import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArborunRuntime } from '../src/mcp/server';
import type { NodeSpec, Session } from '../src/mcp/schema';

let runtime: ArborunRuntime;
let server: Server;
let client: Client;
let sessionId: string;

test.use({ channel: process.env.ARBORUN_TEST_BROWSER_CHANNEL });

const action = (id: string, title: string, overrides: Partial<NodeSpec> = {}): NodeSpec => ({
  id, parentId: 'root', kind: 'action', title, action: '核对现有资料并记录具体结果',
  target: '示例需求.md', input: '测试夹具中的产品需求与接口说明', acceptance: [`${title}有明确结论与证据`],
  failure: '记录具体问题并暂停相关分支', dependsOn: [], agentId: 'main', ...overrides,
});
const plan = {
  title: '核对 CSV 编码要求', goal: '根据两份资料核对编码冲突，并生成可验收的决策记录。',
  context: ['这是自动化测试夹具，用于验证 UI 与 MCP 事件闭环；不表示真实 Agent 已处理文件。'],
  nodes: [
    action('root', 'CSV 导出', { parentId: null, kind: 'group', action: '', target: '', input: '', acceptance: [], failure: '' }),
    action('read', '读取两份需求'),
    action('condition', '检查编码是否冲突', { kind: 'condition', dependsOn: ['read'] }),
    action('review', '调查编码兼容性', { kind: 'agent', agentId: 'reviewer', dependsOn: ['condition'], when: { nodeId: 'condition', outcome: true } }),
    action('deliver', '整理结果与验收依据', { dependsOn: ['review'] }),
  ],
  agents: [
    { id: 'main', name: '主 Agent', role: '读取需求并整理交付', scope: '示例需求与接口说明', budget: '仅执行树中的四项步骤' },
    { id: 'reviewer', name: '兼容性 Agent', role: '调查编码冲突', scope: '只读接口与编码资料', budget: '一次调查', parentId: 'main' },
  ],
};

async function tool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
async function current(): Promise<Session> {
  const result = await tool('arborun_read', { sessionId });
  return (result.structuredContent as unknown as { session: Session }).session;
}
async function passNode(nodeId: string, conditionOutcome?: boolean) {
  const session = await current();
  const node = session.nodes.find(n => n.id === nodeId)!;
  const claim = await tool('arborun_claim', { sessionId, nodeId, revision: session.revision, agentId: node.agentId });
  expect(claim.isError).not.toBe(true);
  const { attemptId, claimToken } = claim.structuredContent as unknown as { attemptId: string; claimToken: string };
  const report = await tool('arborun_report', { sessionId, attemptId, claimToken,
    eventId: randomUUID(), status: 'passed', summary: `${node.title}完成（测试事件）`, evidence: ['自动化测试夹具提供的证据'],
    checks: node.acceptance.map(criterion => ({ criterion, passed: true, evidence: '测试事件：检查通过' })),
    ...(conditionOutcome !== undefined ? { conditionOutcome } : {}),
  });
  expect(report.isError).not.toBe(true);
}

test.beforeEach(async () => {
  runtime = new ArborunRuntime({ html: await readFile('dist-mcp/tree.html', 'utf8'), save: async () => {} });
  server = await runtime.listen();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'arborun-ui-tests', version: '1.0.0' });
  await runtime.mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await tool('arborun_plan', plan);
  expect(result.isError).not.toBe(true);
  sessionId = (result.structuredContent as unknown as { session: Session }).session.id;
});

test.afterEach(async () => {
  await client.close();
  await runtime.mcp.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('用户编辑并批准，Agent 在树上执行，最后由用户验收', async ({ page }, info) => {
  await page.setViewportSize({ width: 540, height: 980 });
  await page.goto(`${runtime.panelUrl}&sessionId=${sessionId}`);
  await expect(page.getByRole('heading', { name: '核对 CSV 编码要求' })).toBeVisible();
  await expect(page.locator('.execution-tree')).toBeVisible();
  expect((await tool('arborun_claim', { sessionId, revision: 1, nodeId: 'read', agentId: 'main' })).isError).toBe(true);

  await page.locator('#node-read').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('具体动作', { exact: true }).fill('逐项阅读两份需求，记录原文编码要求');
  await page.getByRole('button', { name: '保存节点' }).click();
  await expect(page.getByRole('button', { name: '批准 v2 并执行' })).toBeVisible();
  expect((await current()).nodes.find(n => n.id === 'read')!.action).toBe('逐项阅读两份需求，记录原文编码要求');
  await page.screenshot({ path: info.outputPath('plan-tree.png'), fullPage: true });

  await page.getByRole('button', { name: '批准 v2 并执行' }).click();
  await expect(page.getByRole('button', { name: '暂停执行' })).toBeVisible();
  await passNode('read');
  await passNode('condition', true);
  const grantResult = await tool('arborun_claim', { sessionId, revision: 2, nodeId: 'review', agentId: 'reviewer' });
  const { attemptId, claimToken } = grantResult.structuredContent as unknown as { attemptId: string; claimToken: string };
  await expect(page.locator('#node-review > .node-row .node-status')).toHaveText('↳ 执行中');
  await page.getByRole('button', { name: '收起提示', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath('running-tree.png'), fullPage: true });
  await page.setViewportSize({ width: 420, height: 920 });
  await page.screenshot({ path: info.outputPath('running-tree-narrow.png'), fullPage: true });
  await tool('arborun_report', { sessionId, attemptId, claimToken, eventId: randomUUID(), status: 'failed', summary: '缺少目标软件的编码说明', evidence: ['测试夹具缺少兼容性文档'] });
  await expect(page.locator('#node-review .node-result')).toContainText('缺少目标软件的编码说明');
  await expect(page.locator('#node-review > .node-row .node-status')).toHaveText('有问题');
  await passNode('review');
  await passNode('deliver');
  expect((await tool('arborun_submit', { sessionId, revision: 2 })).isError).not.toBe(true);
  await expect(page.getByRole('button', { name: '验收通过', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验收通过', exact: true }).click();
  await expect(page.locator('.task-status')).toHaveText('已验收 · v2');
  await expect(page.getByText('验收已记录。', { exact: true })).toBeVisible();
  expect((await current()).status).toBe('accepted');
  await page.screenshot({ path: info.outputPath('acceptance-tree.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('编辑时收到新版本保留草稿并拒绝覆盖，用户可向 AI 请求修改', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runtime.panelUrl}&sessionId=${sessionId}`);
  await page.locator('#node-read').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('具体动作', { exact: true }).fill('用户仍在编辑的本地草稿');
  expect((await tool('arborun_plan', { ...plan, sessionId, expectedRevision: 1, title: '更新后的需求核对' })).isError).not.toBe(true);
  await expect(page.getByRole('heading', { name: '更新后的需求核对' })).toBeVisible();
  await expect(page.getByLabel('具体动作', { exact: true })).toHaveValue('用户仍在编辑的本地草稿');
  await page.getByRole('button', { name: '保存节点' }).click();
  await expect(page.getByRole('alert')).toContainText('版本');
  expect((await current()).revision).toBe(2);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '让 AI 修改树', exact: true }).click();
  await page.getByLabel('说明如何修改执行树', { exact: true }).fill('先核对接口文档，再安排兼容性调查。');
  await page.getByRole('button', { name: '发送修改要求', exact: true }).click();
  await expect(page.getByLabel('发送到当前对话', { exact: true })).toHaveValue(/先核对接口文档/);
  const session = await current();
  expect(session.status).toBe('draft');
  expect(session.aiRequests).toContain('先核对接口文档，再安排兼容性调查。');
  expect(session.approval).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
