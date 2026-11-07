// Isolated real-MCP integration session for manual/CUA canvas verification.
// The example work reports are test data; no user task is executed or approved here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const directory = resolve(process.env.ARBORUN_VERIFY_DIR ?? '.arborun-mcp/canvas-verification');
await mkdir(directory, { recursive: true });
const scenarioFile = process.env.ARBORUN_VERIFY_SCENARIOS;
const sample = scenarioFile ? JSON.parse(await readFile(scenarioFile, 'utf8')).scenarios.plan.session : null;
const pick = ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, when, agentId }) =>
  ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, ...(when ? { when } : {}), agentId });
const plan = sample ? { title: '画布集成验证 · 测试数据', goal: sample.goal,
  context: ['隔离 MCP 集成任务；执行内容、检查和验收操作仅用于测试，不代表真实 CSV 修改。'], nodes: sample.nodes.map(pick), agents: sample.agents } :
  { ...JSON.parse(await readFile('examples/mcp-canvas-plan.json', 'utf8')), title: '画布集成验证 · 测试数据' };
const client = new Client({ name: 'arborun-canvas-verification', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist-mcp/index.mjs')],
  env: { ...process.env, ARBORUN_MCP_DATA_DIR: join(directory, 'state'), ARBORUN_OPEN_BROWSER: '0' }, stderr: 'pipe' });
// Do not write bearer capabilities to the transcript or shared verification report.
transport.stderr?.on('data', chunk => { if (!String(chunk).includes('local panel:')) process.stderr.write(chunk); });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? 'MCP call failed');
  return result;
};
const created = await call('arborun_plan', plan);
const sessionId = created.structuredContent.session.id;
const panelUrl = `${created._meta.panelUrl}&sessionId=${sessionId}`;
await writeFile(join(directory, 'connection.json'), JSON.stringify({ panelUrl, sessionId }), { mode: 0o600 });
const claims = new Map();
const current = async () => (await call('arborun_read', { sessionId })).structuredContent.session;
const claim = async id => {
  const session = await current();
  const node = session.nodes.find(item => item.id === id);
  if (!node) throw new Error(`Unknown node: ${id}`);
  const granted = (await call('arborun_claim', { sessionId, revision: session.revision, nodeId: id, agentId: node.agentId })).structuredContent;
  claims.set(id, granted); return granted;
};
const report = async (id, status = 'passed', outcome) => {
  const session = await current();
  const node = session.nodes.find(item => item.id === id);
  const grant = claims.get(id) ?? await claim(id);
  const result = await call('arborun_report', { sessionId, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: randomUUID(), status,
    summary: status === 'progress' ? '测试回报：进度原位更新，不改变节点位置。' : status === 'blocked' ? '测试回报：条件依据尚未齐备。' : '测试回报：当前节点的协议状态检查完成。',
    evidence: ['隔离测试客户端通过真实 MCP stdio 调用；业务动作与检查结论为测试数据。'],
    checks: status === 'passed' ? node.acceptance.map(criterion => ({ criterion, passed: true, evidence: '测试数据：匹配当前节点验收字段，验证协议门控与 UI 呈现。' })) : [],
    ...(node.kind === 'condition' ? { conditionOutcome: outcome ?? (status === 'blocked' ? 'unknown' : true) } : {}),
  });
  if (status !== 'progress') claims.delete(id);
  return result;
};
const describe = async () => {
  const session = await current();
  return { id: session.id, revision: session.revision, status: session.status, approved: Boolean(session.approval),
    nodes: session.nodes.map(n => ({ id: n.id, title: n.title, status: n.status, parentId: n.parentId })),
    active: session.attempts.filter(a => a.status === 'running' && !a.invalidated).map(a => ({ nodeId: a.nodeId, agentId: a.agentId })), requests: session.aiRequests };
};
console.log(JSON.stringify({ ready: true, sessionId, connectionFile: join(directory, 'connection.json') }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const command = JSON.parse(line);
    if (command.op === 'stop') break;
    if (command.op === 'claim') await claim(command.id);
    else if (command.op === 'report') await report(command.id, command.status, command.outcome);
    else if (command.op === 'running') {
      for (const id of ['req-read', 'req-contract', 'req-fixtures', 'impl-serialize', 'compat-baseline']) await report(id);
      await claim('impl-escape'); await claim('compat-excel'); await report('compat-bom', 'blocked', 'unknown');
    } else if (command.op === 'finish') {
      for (const id of [...claims.keys()]) await report(id);
      let rounds = 0;
      while (++rounds <= 100) {
        const session = await current();
        const candidates = session.nodes.filter(n => n.kind !== 'group' && !['passed', 'skipped', 'running'].includes(n.status));
        if (!candidates.length) break;
        let progress = false;
        for (const n of candidates) {
          try { await report(n.id, 'passed', n.kind === 'condition' ? true : undefined); progress = true; } catch { /* dependency may still be waiting */ }
        }
        if (!progress) throw new Error('No ready nodes; inspect dependency/approval state.');
      }
      const session = await current(); await call('arborun_submit', { sessionId, revision: session.revision });
    } else if (command.op === 'external-edit') {
      const session = await current();
      await call('arborun_plan', { sessionId, expectedRevision: session.revision, title: session.title, goal: session.goal, context: session.context, agents: session.agents,
        nodes: session.nodes.map(n => pick(n.id === command.id ? { ...n, action: `${n.action}\n测试：来自另一个协议客户端的新版本。` } : n)) });
    } else if (command.op !== 'read') throw new Error('Unknown command');
    console.log(JSON.stringify({ ok: true, session: await describe() }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }
}
await client.close();
process.stdin.pause();
