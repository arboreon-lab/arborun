// Official AppBridge + sandboxed iframe + real stdio MCP, in an isolated test workspace.
// No model service, global host configuration, or automatic approval/acceptance.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { build } from 'esbuild';

const directory = resolve(process.env.ARBORUN_APP_VERIFY_DIR ?? `../../work/mcp-app-host-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
// --resume reuses the private connection capability and existing session so a
// rebuilt UI can replace a preview at the same URL after its old process stops.
const resumed = process.argv.includes('--resume')
  ? JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) : undefined;
const resumedUrl = resumed ? new URL(resumed.hostUrl) : undefined;
if (resumedUrl && (resumedUrl.hostname !== '127.0.0.1' || resumedUrl.protocol !== 'http:' || !resumedUrl.port || !resumed.sessionId)) {
  throw new Error('恢复预览需要当前隔离目录中的有效本地 connection.json。');
}
const sampleFile = process.env.ARBORUN_VERIFY_SCENARIOS;
const sample = sampleFile ? JSON.parse(await readFile(sampleFile, 'utf8')).scenarios.plan.session : undefined;
const pick = ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, when, agentId }) =>
  ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, ...(when ? { when } : {}), agentId });
const basePlan = sample ? { goal: sample.goal, nodes: sample.nodes.map(pick), agents: sample.agents } : JSON.parse(await readFile(process.env.ARBORUN_APP_PLAN ?? 'examples/mcp-canvas-plan.json', 'utf8'));
const plan = { ...basePlan, title: basePlan.title ?? 'MCP Apps SDK 集成验证 · 测试数据',
  context: ['官方 AppBridge 测试宿主，非 Codex 原生面板；执行与检查是隔离测试数据，不代表业务修改。'] };
const client = new Client({ name: 'arborun-sdk-test-host', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist-mcp/index.mjs')],
  env: { ...process.env, ARBORUN_MCP_DATA_DIR: join(directory, 'state'), ARBORUN_OPEN_BROWSER: '0' }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => {
  stderr += String(chunk);
  const lines = stderr.split('\n'); stderr = lines.pop() ?? '';
  for (const line of lines) if (!line.startsWith('Arborun local panel:')) process.stderr.write(`${line}\n`);
});
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? 'MCP call failed');
  return result;
};
const created = resumed ? await call('arborun_read', { sessionId: resumed.sessionId }) : await call('arborun_plan', plan);
const sessionId = created.structuredContent.session.id;
const RESOURCE = 'ui://arborun/tree.html';
const resource = await client.readResource({ uri: RESOURCE });
const html = resource.contents.find(item => item.uri === RESOURCE && typeof item.text === 'string')?.text;
if (!html) throw new Error('MCP did not return the UI HTML resource');
const forApp = result => ({ ...result, _meta: { uiToken: result._meta?.uiToken } });
const current = async () => (await call('arborun_read', { sessionId })).structuredContent.session;
const forwardAppTool = async params => {
  if (!params || !['arborun_read', 'arborun_user'].includes(params.name)) throw new Error('此测试 App 仅可调用 read/user 工具。');
  const requestedSession = params.name === 'arborun_user' ? params.arguments?.action?.sessionId : params.arguments?.sessionId;
  if (requestedSession && requestedSession !== sessionId) throw new Error('不能访问其他测试任务。');
  // The server retains its existing app-only uiToken checks. This host does not approve anything itself.
  return forApp(await client.callTool({ name: params.name, arguments: params.arguments ?? {} }));
};

// This optional check exercises the actual SDK handshake over linked transports,
// without a browser, without claiming native Codex coverage, and without approval.
if (process.argv.includes('--self-test')) {
  const { App } = await import('@modelcontextprotocol/ext-apps');
  const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair();
  const host = new AppBridge(null, { name: 'Arborun SDK self-test', version: '1.0.0' }, { serverTools: {} },
    { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], theme: 'light', containerDimensions: { width: 420, height: 920 } } });
  host.oncalltool = forwardAppTool;
  host.onrequestdisplaymode = async ({ mode }) => ({ mode });
  const view = new App({ name: 'SDK check', version: '1.0.0' }, {}, { autoResize: false });
  let notified = false; view.ontoolresult = () => { notified = true; };
  await host.connect(hostTransport); await view.connect(viewTransport);
  await host.sendToolInput({ arguments: { sessionId } }); await host.sendToolResult(forApp(created));
  const loaded = await view.callServerTool({ name: 'arborun_read', arguments: { sessionId } });
  const display = await view.requestDisplayMode({ mode: 'fullscreen' });
  const report = { sdkHandshake: true, toolResult: notified, stdioRead: loaded.structuredContent?.session?.id === sessionId,
    displayMode: display.mode, stillDraft: (await current()).status === 'draft', resourceMime: resource.contents[0]?.mimeType };
  await writeFile(join(directory, 'sdk-self-test.json'), JSON.stringify(report, null, 2));
  await view.close(); await host.close(); await client.close();
  console.log(JSON.stringify({ selfTest: report, reportFile: join(directory, 'sdk-self-test.json') }));
  if (!report.toolResult || !report.stdioRead || !report.stillDraft) process.exitCode = 1;
} else {
  const built = await build({ entryPoints: ['scripts/mcp-app-host.ts'], bundle: true, platform: 'browser', format: 'iife',
    write: false, minify: true, target: 'es2022' });
  const hostScript = built.outputFiles[0].text;
  const hostToken = resumedUrl ? new URLSearchParams(resumedUrl.hash.slice(1)).get('hostToken') : randomBytes(32).toString('base64url');
  if (!hostToken) throw new Error('恢复预览缺少原连接 capability，请勿使用其他任务的连接文件。');
  const tokenMatches = value => {
    if (typeof value !== 'string') return false;
    const supplied = Buffer.from(value), expected = Buffer.from(hostToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end('Origin rejected'); return;
    }
    const pathname = new URL(request.url ?? '/', origin).pathname;
    if (pathname === '/' && request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; media-src 'self' data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.end(hostPage()); return;
    }
    if (pathname === '/host.js' && request.method === 'GET') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(hostScript); return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin || !tokenMatches(request.headers.authorization?.replace(/^Bearer /, ''))) {
      response.writeHead(403).end('Host capability required'); return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const parts = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('请求超过 1 MB'); parts.push(chunk); }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
      if (pathname === '/api/bootstrap') {
        response.end(JSON.stringify({ html, result: forApp(await call('arborun_read', { sessionId })), sessionId })); return;
      }
      if (pathname === '/api/tool') { response.end(JSON.stringify(await forwardAppTool(body))); return; }
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject); server.listen(Number(process.env.ARBORUN_APP_HOST_PORT ?? resumedUrl?.port ?? 0), '127.0.0.1', resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const connectionFile = join(directory, 'connection.json');
  await writeFile(connectionFile, JSON.stringify({ hostUrl: `${origin}/#hostToken=${hostToken}`, sessionId,
    description: '官方 AppBridge 测试宿主；不是 Codex 原生面板；批准和验收仅由页面操作发起。' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, sessionId, connectionFile }));

  const claims = new Map();
  const claim = async id => {
    const session = await current(), node = session.nodes.find(n => n.id === id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    const grant = (await call('arborun_claim', { sessionId, revision: session.revision, nodeId: id, agentId: node.agentId })).structuredContent;
    claims.set(id, grant); return grant;
  };
  const report = async (id, status = 'passed', outcome, details = {}) => {
    const session = await current(), node = session.nodes.find(n => n.id === id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    const grant = claims.get(id) ?? await claim(id);
    const result = await call('arborun_report', { sessionId, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: randomUUID(), status,
      summary: details.summary ?? (status === 'progress' ? 'SDK 测试回报：执行进度原位更新。' : status === 'blocked' ? 'SDK 测试回报：缺少条件依据。' : 'SDK 测试回报：协议检查完成。'),
      evidence: details.evidence ?? ['隔离客户端经真实 MCP stdio 上报；业务动作与检查结论为测试数据。'],
      checks: details.checks ?? (status === 'passed' ? node.acceptance.map(criterion => ({ criterion, passed: true, evidence: '测试数据：匹配当前验收字段，验证协议门控与界面更新。' })) : []),
      ...(node.kind === 'condition' ? { conditionOutcome: outcome ?? (status === 'blocked' ? 'unknown' : id === 'native-condition' ? false : true) } : {}),
    });
    if (status !== 'progress') claims.delete(id);
    return result;
  };
  const describe = async () => {
    const session = await current();
    return { id: session.id, revision: session.revision, status: session.status, approved: Boolean(session.approval),
      nodes: session.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
      active: session.attempts.filter(a => a.status === 'running' && !a.invalidated).map(a => ({ nodeId: a.nodeId, agentId: a.agentId })) };
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true; input.close();
    server.closeAllConnections(); await new Promise(done => server.close(done)); await client.close();
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      if (command.op === 'stop') break;
      if (command.op === 'claim') await claim(command.id);
      else if (command.op === 'report') await report(command.id, command.status, command.outcome, command);
      else if (command.op === 'activity') {
        const grant = claims.get(command.id) ?? await claim(command.id);
        await call('arborun_activity', { ...command.activity, sessionId, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: command.activity.eventId ?? randomUUID() });
      } else if (command.op === 'submit') {
        const session = await current(); await call('arborun_submit', { sessionId, revision: session.revision });
      }
      else if (command.op === 'running') {
        if (basePlan.nodes.some(node => node.id === 'req-read')) {
          for (const id of ['req-read', 'req-contract', 'req-fixtures', 'impl-serialize', 'compat-baseline']) await report(id);
          await claim('impl-escape'); await claim('compat-excel'); await report('compat-bom', 'blocked', 'unknown');
        } else { await report('scope'); await claim('protocol-check'); await claim('ui-check'); }
      } else if (command.op === 'finish') {
        for (const id of [...claims.keys()]) await report(id);
        for (let round = 0; round < 100; round++) {
          const session = await current();
          const pending = session.nodes.filter(n => n.kind !== 'group' && !['passed', 'skipped', 'running'].includes(n.status));
          if (!pending.length) break;
          let progressed = false;
          for (const node of pending) { try { await report(node.id); progressed = true; } catch { /* dependencies may need another pass */ } }
          if (!progressed) throw new Error('没有就绪节点，请核对批准、版本与依赖。');
        }
        const session = await current(); await call('arborun_submit', { sessionId, revision: session.revision });
      } else if (command.op !== 'read') throw new Error('支持 read / running / claim / report / activity / submit / finish / stop；不提供终端批准或验收。');
      console.log(JSON.stringify({ ok: true, session: await describe() }));
    } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }
  }
  await stop();
}

function hostPage() { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arborun</title>
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}#stage{width:100%;height:100dvh}iframe{width:100%;height:100%;border:0;display:block}#error{position:absolute;z-index:30;top:16px;left:16px;right:16px;padding:12px 16px;border:1px solid #e3b6b6;border-radius:12px;background:#fff;color:#9b3737;font:14px/1.6 system-ui,sans-serif}
</style></head><body><div id="error" role="alert" hidden></div><div id="stage"><iframe id="app-frame" title="Arborun MCP App" sandbox="allow-scripts allow-forms"></iframe></div><script src="/host.js" defer></script></body></html>`; }
