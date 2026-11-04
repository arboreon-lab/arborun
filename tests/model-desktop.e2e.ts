import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ModelMessage, ToolCall } from '../src/shared/types';

// The local server is a deterministic protocol fixture, not an online model.
// This exercises the packaged renderer -> main -> utility process -> HTTP
// provider -> bounded tool loop without sending user data to a third party.
test('model-mode desktop completes a real tool loop against a local simulated model', async () => {
  const scratch = path.resolve(process.cwd(), '../../work');
  await fs.mkdir(scratch, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(scratch, 'model-desktop-e2e-'));
  const secret = 'local-fixture-key-do-not-persist';
  const requests: { path?: string; authorization?: string; body: any }[] = [];
  const fixtureErrors: string[] = [];
  const plan = { nodes: [
    { id: 'fixture-root', parentId: null, title: '本机模拟模型协议验收', kind: 'group', description: '验证授权读取和树形交付', target: '本次资料快照', action: '读取资料、生成有来源的说明并保存交付清单。', acceptance: ['读取记录和产物可追溯'], dependencies: [], operation: 'generate' },
    { id: 'fixture-read', parentId: 'fixture-root', title: '读取授权资料', kind: 'task', description: '通过受限工具读取真实导入的资料', target: '已导入资料', action: '读取第一份已授权资料并记录结果。', acceptance: ['存在真实 read_source 记录'], dependencies: [], operation: 'read' },
    { id: 'fixture-generate', parentId: 'fixture-root', title: '生成来源说明树', kind: 'task', description: '读取第二份资料后生成文档', target: '来源说明树.md', action: '读取资料，生成含原文依据和来源文件名的树形 Markdown。', acceptance: ['文档采用树结构', '包含授权来源名称'], dependencies: ['fixture-read'], operation: 'generate' },
    { id: 'fixture-deliver', parentId: 'fixture-root', title: '保存交付清单', kind: 'artifact', description: '汇总已经采用的产物', target: '交付清单.md', action: '生成交付清单并关联来源说明树。', acceptance: ['存在已采用的生成产物'], dependencies: ['fixture-generate'], operation: 'deliver' },
  ] };
  let callSequence = 0;
  const respond = (response: ServerResponse, content: string | null, toolCalls?: ToolCall[]) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `fixture-response-${++callSequence}`, object: 'chat.completion', model: 'arborun-local-fixture', choices: [{ index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }], usage: { total_tokens: 42 } }));
  };
  const tool = (name: string, args: unknown): ToolCall => ({ id: `fixture-tool-${callSequence + 1}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ path: request.url, authorization: request.headers.authorization, body });
        const messages = body.messages as ModelMessage[];
        if (messages[0].content?.startsWith('You plan')) { respond(response, JSON.stringify(plan)); return; }
        const context = JSON.parse(messages.find(message => message.role === 'user')!.content!);
        const sourceIndex = context.node.title === '读取授权资料' ? 0 : 1;
        const results = messages.filter(message => message.role === 'tool');
        if (!results.length) {
          respond(response, null, [tool('read_source', { sourceId: context.availableSources[sourceIndex].id })]);
          return;
        }
        if (context.node.title === '读取授权资料') { respond(response, '读取结果\n└─ 已通过 read_source 读取授权资料快照。'); return; }
        if (context.node.title !== '生成来源说明树') throw new Error('Unexpected node reached the model fixture');
        if (results.length === 1) {
          const source = JSON.parse(results[0].content!);
          const quote = String(source.content).split('\n').find((line: string) => line.includes('CSV'))?.trim() ?? String(source.content).split('\n')[0];
          respond(response, null, [tool('write_artifact', { name: '来源说明树.md', content: `来源说明\n├─ 来源：${source.name}\n├─ 依据：${quote}\n└─ 验证：本机模拟模型已完成授权读取与文档生成。` })]);
          return;
        }
        respond(response, '生成结果\n└─ 来源说明树.md 已通过 write_artifact 提交，等待运行时检查并采用。');
      } catch (error) {
        fixtureErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Local fixture failure' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ ...(process.env.ARBORUN_PACKAGED_EXECUTABLE ? { executablePath: process.env.ARBORUN_PACKAGED_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env: { ...process.env, ARBORUN_DATA_DIR: dataDir, ARBORUN_TEST: '1' } });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'CSV 导出需求', exact: true })).toBeVisible();
    const configured = await page.evaluate(async ({ baseUrl, secret }) => window.arborun.saveModelConfig({ baseUrl, apiKey: secret, model: 'arborun-local-fixture' }), { baseUrl, secret });
    expect(configured).toEqual({ baseUrl, model: 'arborun-local-fixture', hasKey: true, storage: 'session' });
    expect(configured).not.toHaveProperty('apiKey');
    const taskId = await page.evaluate(async () => {
      const state = await window.arborun.command({ type: 'create', title: '本机模拟模型验收', prompt: '读取两份资料，生成有来源的树形说明并保存交付清单。', mode: 'model' });
      return state.activeTaskId!;
    });
    const sourcePaths = ['产品需求.md', '接口说明.md'].map(name => path.resolve(process.cwd(), 'examples', name));
    await app.evaluate(({ dialog }, filePaths) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths }; };
    }, sourcePaths);
    const imported = await page.evaluate(async id => window.arborun.importSources(id), taskId);
    const importedTask = imported.tasks.find(task => task.id === taskId)!;
    expect(importedTask.sources.map(source => source.name)).toEqual(['产品需求.md', '接口说明.md']);
    expect(importedTask.sources.every(source => /^[a-f0-9]{64}$/.test(source.hash))).toBe(true);
    expect(importedTask.sources[1].content).toBe(await fs.readFile(sourcePaths[1], 'utf8'));
    await page.evaluate(async id => window.arborun.command({ type: 'plan', taskId: id }), taskId);
    await expect.poll(async () => {
      const state = await page.evaluate(async () => window.arborun.getState());
      return state.tasks.find(task => task.id === taskId)?.nodes.map(node => node.id);
    }).toEqual(plan.nodes.map(node => node.id));
    await page.evaluate(async id => {
      await window.arborun.command({ type: 'approve', taskId: id });
      await window.arborun.command({ type: 'run', taskId: id });
    }, taskId);
    await expect.poll(async () => {
      const state = await page.evaluate(async () => window.arborun.getState());
      const task = state.tasks.find(task => task.id === taskId)!;
      return task.status === 'failed' ? `failed: ${task.lastError}` : task.status;
    }).toBe('completed');
    const completed = await page.evaluate(async id => (await window.arborun.getState()).tasks.find(task => task.id === id)!, taskId);
    expect(completed.mode).toBe('model');
    expect(completed.nodes.every(node => node.status === 'passed')).toBe(true);
    expect(completed.artifacts.filter(artifact => artifact.adopted).map(artifact => artifact.name)).toEqual(['来源说明树.md', '交付清单.md']);
    expect(completed.artifacts[0].content).toContain('接口说明.md');
    expect(completed.artifacts[0].content).toContain('GB18030');
    expect(completed.events.filter(event => event.message === '执行工具：read_source')).toHaveLength(2);
    expect(completed.events.filter(event => event.message === '执行工具：write_artifact')).toHaveLength(1);
    expect(completed.budget.usedCalls).toBe(6);
    expect(requests).toHaveLength(6);
    expect(requests.every(request => request.path === '/v1/chat/completions' && request.authorization === `Bearer ${secret}` && request.body.model === 'arborun-local-fixture')).toBe(true);
    expect(fixtureErrors).toEqual([]);
    expect(JSON.stringify(completed)).not.toContain(secret);
    expect(await fs.readFile(path.join(dataDir, 'model.json'), 'utf8')).not.toContain(secret);
    await page.screenshot({ path: 'test-results/model-desktop-completed.png', fullPage: true });
  } finally {
    if (app) await app.close().catch(() => undefined);
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
