import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArborunRuntime } from '../src/mcp/server';
import { ArtifactStore } from '../src/mcp/artifacts';
import type { NodeSpec, Session } from '../src/mcp/schema';

let runtime: ArborunRuntime;
let server: Server;
let client: Client;
let sessionId: string;
let artifactDir: string;

test.use({ channel: process.env.ARBORUN_TEST_BROWSER_CHANNEL });

const action = (id: string, title: string, overrides: Partial<NodeSpec> = {}): NodeSpec => ({
  id, parentId: 'root', kind: 'action', title, action: '核对现有资料并记录具体结果',
  target: '示例需求.md', input: '测试夹具中的产品需求与接口说明', acceptance: [`${title}有明确结论与证据`],
  failure: '记录具体问题并暂停相关分支', dependsOn: [], agentId: 'main', ...overrides,
});
const group = (id: string, title: string, parentId: string | null = 'root') => action(id, title, {
  parentId, kind: 'group', action: '', target: '', input: '', acceptance: [], failure: '',
});
const plan = {
  title: '核对 CSV 编码要求', goal: '根据两份资料核对编码冲突，并生成可验收的决策记录。',
  context: ['这是隔离自动化测试任务，执行记录与证据均由测试客户端提供，不表示真实 Agent 已处理文件。'],
  nodes: [
    group('root', 'CSV 导出', null),
    group('requirements', '需求核对'),
    action('read', '读取两份需求', { parentId: 'requirements' }),
    action('condition', '检查编码是否冲突', { parentId: 'requirements', kind: 'condition', dependsOn: ['read'] }),
    group('investigation', '兼容性调查'),
    action('review', '调查编码兼容性', { parentId: 'investigation', kind: 'agent', agentId: 'reviewer', dependsOn: ['condition'], when: { nodeId: 'condition', outcome: true } }),
    action('parallel', '核对导出字段', { dependsOn: ['condition'] }),
    action('deliver', '整理结果与验收依据', { dependsOn: ['review', 'parallel'] }),
  ],
  agents: [
    { id: 'main', name: '主 Agent', role: '读取需求并整理交付', scope: '示例需求与接口说明', budget: '只执行隔离测试节点' },
    { id: 'reviewer', name: '兼容性 Agent', role: '调查编码冲突', scope: '只读接口与编码资料', budget: '一次调查', parentId: 'main' },
  ],
};

type Grant = { attemptId: string; claimToken: string; node: NodeSpec };
async function tool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
async function current(): Promise<Session> {
  const result = await tool('arborun_read', { sessionId });
  return (result.structuredContent as unknown as { session: Session }).session;
}
async function claimNode(nodeId: string): Promise<Grant> {
  const session = await current();
  const node = session.nodes.find(item => item.id === nodeId)!;
  const result = await tool('arborun_claim', { sessionId, nodeId, revision: session.revision, agentId: node.agentId });
  expect(result.isError).not.toBe(true);
  return { ...(result.structuredContent as unknown as { attemptId: string; claimToken: string }), node };
}
async function finish(grant: Grant, conditionOutcome?: boolean) {
  const result = await tool('arborun_report', {
    sessionId, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: randomUUID(),
    status: 'passed', summary: `${grant.node.title}完成（隔离测试事件）`, evidence: ['自动化测试夹具提供的证据'],
    checks: grant.node.acceptance.map(criterion => ({ criterion, passed: true, evidence: '测试事件：检查通过' })),
    ...(conditionOutcome !== undefined ? { conditionOutcome } : {}),
  });
  expect(result.isError).not.toBe(true);
}
async function passNode(nodeId: string, conditionOutcome?: boolean) { await finish(await claimNode(nodeId), conditionOutcome); }
async function openTree(page: Page) {
  await page.setViewportSize({ width: 1320, height: 1000 });
  await page.goto(`${runtime.panelUrl}&sessionId=${sessionId}`);
  await expect(page.getByTestId('tree-canvas')).toBeVisible();
  await expect(shell(page)).toHaveAttribute('data-scope', 'root');
  await expect(shell(page)).toHaveAttribute('data-view', 'tb');
  await expect.poll(async () => (await geometry(page)).transform).not.toContain('translate(0px, 0px)');
}
const nodeCard = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);
const shell = (page: Page) => page.locator('.arborun-canvas-shell');
const nodeButton = (page: Page, title: string) => page.locator(`.node[aria-label^="${title}，"]`);
const inspector = (page: Page) => page.getByRole('complementary', { name: '节点详情' });
async function dismissNotice(page: Page) {
  const notice = page.locator('.message[role="status"]');
  if (await notice.count()) await notice.click();
}
async function closeInspector(page: Page) {
  const close = page.getByRole('button', { name: '关闭节点详情', exact: true });
  if (await close.count()) await close.click();
  await expect.poll(async () => (await page.getByTestId('tree-canvas').boundingBox())?.width ?? 0).toBeGreaterThan(1000);
}
async function geometry(page: Page) {
  return page.getByTestId('canvas-world').evaluate(world => ({
    transform: (world as HTMLElement).style.transform,
    nodes: [...world.querySelectorAll<HTMLElement>('[data-node-id]')].map(node => ({ id: node.dataset.nodeId, left: node.style.left, top: node.style.top })),
  }));
}
async function enterRequirements(page: Page) {
  await nodeButton(page, '需求核对').dblclick();
  await expect(shell(page)).toHaveAttribute('data-scope', 'requirements');
  await expect(inspector(page)).toHaveCount(0);
}
async function openNodeMenu(page: Page) {
  await inspector(page).getByRole('button', { name: '节点操作', exact: true }).click();
  return inspector(page).getByRole('menu', { name: '节点操作', exact: true });
}
async function editReadNode(page: Page, text: string) {
  await nodeButton(page, '读取两份需求').click();
  await expect(inspector(page)).toBeVisible();
  await (await openNodeMenu(page)).getByRole('menuitem', { name: '编辑内容', exact: true }).click();
  await page.getByLabel('具体动作', { exact: true }).fill(text);
}
async function rootDetails(page: Page) {
  await closeInspector(page);
  // The whole task opens from the title at the top left, from any level.
  await page.locator('[data-task-title]').click();
  await expect(shell(page)).toHaveAttribute('data-scope', 'root');
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).locator('[data-inspector-mode="task"]')).toBeVisible();
}
async function approve(page: Page, revision: number) {
  await rootDetails(page);
  await inspector(page).getByRole('button', { name: `批准 v${revision} 并执行`, exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: '暂停执行', exact: true })).toBeVisible();
  await dismissNotice(page);
  await closeInspector(page);
}

test.beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'arborun-e2e-artifacts-'));
  runtime = new ArborunRuntime({ html: await readFile('dist-mcp/tree.html', 'utf8'), save: async () => {}, artifacts: new ArtifactStore(artifactDir) });
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
  await rm(artifactDir, { recursive: true, force: true });
});

test('单击展开详情，双击进入任意节点，View 与层级返回共享选择并恢复视野', async ({ page }, info) => {
  await openTree(page);
  // The top bar's right side carries only two icons, without visible text.
  await expect(page.locator('.tools button')).toHaveCount(2);
  await expect(page.locator('.tools')).toHaveText('');
  // Folding turns the tree into the overview; selecting a result there expands the tree at it.
  await page.getByRole('button', { name: '折叠为概览', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行树概览' })).toBeVisible();
  await expect(page.getByTestId('tree-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '展开详情', exact: true }).click();
  await expect(page.getByTestId('tree-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: '切换为从左到右', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '画布选项', exact: true })).toHaveCount(0);
  await nodeButton(page, '需求核对').click();
  await expect(inspector(page)).toContainText('需求核对');
  await expect(shell(page)).toHaveAttribute('data-scope', 'root');
  await expect(nodeCard(page, 'requirements')).toHaveAttribute('data-selected', 'true');
  await closeInspector(page);
  const rootGeometry = await geometry(page);
  await enterRequirements(page);
  await nodeButton(page, '读取两份需求').click();
  await expect(inspector(page)).toContainText('核对现有资料并记录具体结果');
  for (const [view, label] of [['lr', '切换为从左到右'], ['tb', '切换为从上到下']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(shell(page)).toHaveAttribute('data-view', view);
    await expect(shell(page)).toHaveAttribute('data-scope', 'requirements');
    await expect(nodeCard(page, 'read')).toHaveAttribute('data-selected', 'true');
    await expect(inspector(page)).toContainText('读取两份需求');
  }
  await page.screenshot({ path: info.outputPath('reference-detail-expanded.png'), fullPage: true });
  await closeInspector(page);
  const requirementsGeometry = await geometry(page);
  await nodeButton(page, '读取两份需求').dblclick();
  await expect(shell(page)).toHaveAttribute('data-scope', 'read');
  // Entering a single step opens its detail beside it.
  await expect(inspector(page)).toContainText('读取两份需求');
  await closeInspector(page);
  await expect(nodeCard(page, 'read')).toBeVisible();
  await page.locator('[data-breadcrumb="requirements"]').click();
  await expect(shell(page)).toHaveAttribute('data-scope', 'requirements');
  await expect.poll(() => geometry(page)).toEqual(requirementsGeometry);
  await page.locator('[data-breadcrumb="root"]').click();
  await expect(shell(page)).toHaveAttribute('data-scope', 'root');
  await expect.poll(() => geometry(page)).toEqual(rootGeometry);
});

test('节点菜单编辑、根详情批准、真实 MCP 状态原位更新并在同树验收', async ({ page }, info) => {
  await openTree(page);
  expect((await tool('arborun_claim', { sessionId, revision: 1, nodeId: 'read', agentId: 'main' })).isError).toBe(true);
  await enterRequirements(page);
  await editReadNode(page, '逐项阅读两份需求，记录原文编码要求');
  await page.getByRole('button', { name: /^保存为 v\d+$/ }).click();
  await expect(page.locator('[data-inspector-mode="detail"]')).toBeVisible();
  expect((await current()).nodes.find(node => node.id === 'read')!.action).toBe('逐项阅读两份需求，记录原文编码要求');
  await dismissNotice(page);
  await approve(page, 2);
  await enterRequirements(page);
  const initialGeometry = await geometry(page);
  const read = await claimNode('read');
  await expect(nodeCard(page, 'read')).toHaveAttribute('data-running', 'true');
  await expect(nodeCard(page, 'read')).toContainText('主 Agent');
  expect(await geometry(page)).toEqual(initialGeometry);
  expect((await tool('arborun_report', { sessionId, attemptId: read.attemptId, claimToken: read.claimToken,
    eventId: randomUUID(), status: 'progress', summary: '两份资料已读取，正在比较编码字段（隔离测试事件）', evidence: ['测试文档第一段'] })).isError).not.toBe(true);
  await nodeButton(page, '读取两份需求').click();
  await expect(inspector(page)).toContainText('正在比较编码字段');
  await closeInspector(page);
  const beforeResult = await geometry(page);
  await finish(read);
  await expect(nodeCard(page, 'read')).toHaveAttribute('data-status', 'passed');
  expect(await geometry(page)).toEqual(beforeResult);
  await passNode('condition', true);

  const reviewer = await claimNode('review');
  const parallel = await claimNode('parallel');
  await page.locator('[data-breadcrumb="root"]').click();
  // The working agent shows as a pulsing tip on its own arc of the folded node's ring, not as an avatar.
  await expect(nodeCard(page, 'investigation').locator('.ring-tip')).toHaveCount(1);
  await expect(nodeCard(page, 'investigation').locator('.avatar')).toHaveCount(0);
  await expect(nodeCard(page, 'parallel')).toHaveAttribute('data-running', 'true');
  await nodeButton(page, '兼容性调查').dblclick();
  await expect(shell(page)).toHaveAttribute('data-scope', 'investigation');
  await expect(nodeCard(page, 'review')).toHaveAttribute('data-running', 'true');
  await nodeButton(page, '调查编码兼容性').click();
  await expect(inspector(page)).toBeVisible();
  expect((await tool('arborun_report', { sessionId, attemptId: reviewer.attemptId, claimToken: reviewer.claimToken,
    eventId: randomUUID(), status: 'failed', summary: '缺少目标软件的编码说明', evidence: ['隔离夹具缺少兼容性文档'] })).isError).not.toBe(true);
  await expect(nodeCard(page, 'review')).toHaveAttribute('data-status', 'failed');
  await expect(inspector(page)).toContainText('缺少目标软件的编码说明');
  await page.screenshot({ path: info.outputPath('reference-failed-expanded.png'), fullPage: true });
  await closeInspector(page);
  await passNode('review');
  await finish(parallel);
  await passNode('deliver');
  expect((await tool('arborun_submit', { sessionId, revision: 2 })).isError).not.toBe(true);
  await rootDetails(page);
  await expect(inspector(page).getByRole('button', { name: '验收通过', exact: true })).toBeVisible();
  const beforeAccept = await geometry(page);
  const beforeIds = (await current()).nodes.map(node => node.id);
  await inspector(page).getByRole('button', { name: '验收通过', exact: true }).click();
  await expect(inspector(page)).toContainText('用户已验收');
  const accepted = await current();
  expect(accepted.status).toBe('accepted');
  expect(accepted.nodes.map(node => node.id)).toEqual(beforeIds);
  // Acceptance happens in the whole-task view, which stays open; the tree does not move.
  await expect(inspector(page).locator('[data-inspector-mode="task"]')).toBeVisible();
  expect(await geometry(page)).toEqual(beforeAccept);
  await page.screenshot({ path: info.outputPath('reference-accepted-expanded.png'), fullPage: true });
});

test('运行中编辑撤销批准，旧结果仅留历史，并发版本冲突保留草稿', async ({ page }, info) => {
  await openTree(page);
  await approve(page, 1);
  await enterRequirements(page);
  const oldClaim = await claimNode('read');
  await expect(nodeCard(page, 'read')).toHaveAttribute('data-running', 'true');
  await editReadNode(page, '按修正后的需求逐项核对');
  await page.getByRole('button', { name: /^保存为 v\d+$/ }).click();
  await expect(page.locator('[data-inspector-mode="detail"]')).toBeVisible();
  const changed = await current();
  expect(changed.revision).toBe(2);
  expect(changed.approval).toBeUndefined();
  expect(changed.attempts.find(attempt => attempt.id === oldClaim.attemptId)?.invalidated).toBe(true);
  await expect(nodeCard(page, 'read')).toHaveAttribute('data-running', 'false');
  expect((await tool('arborun_claim', { sessionId, revision: 1, nodeId: 'read', agentId: 'main' })).isError).toBe(true);
  expect((await tool('arborun_claim', { sessionId, revision: 2, nodeId: 'read', agentId: 'main' })).isError).toBe(true);
  const late = await tool('arborun_report', { sessionId, attemptId: oldClaim.attemptId, claimToken: oldClaim.claimToken,
    eventId: randomUUID(), status: 'passed', summary: '旧版本迟到结果', evidence: ['旧版测试证据'] });
  expect(late.isError).not.toBe(true);
  const afterLate = await current();
  expect(afterLate.nodes.find(node => node.id === 'read')?.status).not.toBe('passed');
  expect(afterLate.nodes.find(node => node.id === 'read')?.result).not.toBe('旧版本迟到结果');
  expect(afterLate.attempts.find(attempt => attempt.id === oldClaim.attemptId)?.lateStatus).toBe('passed');
  expect(afterLate.events.at(-1)?.type).toBe('late_report');

  await dismissNotice(page);
  await (await openNodeMenu(page)).getByRole('menuitem', { name: '编辑内容', exact: true }).click();
  await page.getByLabel('具体动作', { exact: true }).fill('用户仍在编辑的本地草稿');
  expect((await tool('arborun_plan', { ...plan, sessionId, expectedRevision: 2, title: '更新后的需求核对' })).isError).not.toBe(true);
  await expect(inspector(page)).toContainText('此草稿基于 v2');
  await expect(page.getByLabel('具体动作', { exact: true })).toHaveValue('用户仍在编辑的本地草稿');
  await page.getByRole('button', { name: /^保存为 v\d+$/ }).click();
  await expect(page.locator('.message.error')).toContainText('版本');
  await expect(page.getByLabel('具体动作', { exact: true })).toHaveValue('用户仍在编辑的本地草稿');
  expect((await current()).revision).toBe(3);
  expect((await current()).nodes.find(node => node.id === 'read')!.action).toBe(plan.nodes.find(node => node.id === 'read')!.action);
  await page.screenshot({ path: info.outputPath('reference-edit-conflict-expanded.png'), fullPage: true });
});

test('长任务：节点完成后，测试里每个样例显示实际结果与看得懂的证据（命令行、截图、演示录像）', async ({ page }) => {
  const model = JSON.parse(await readFile('examples/mcp-model-plan.json', 'utf8'));
  const created = await tool('arborun_plan', model);
  expect(created.isError).not.toBe(true);
  sessionId = (created.structuredContent as unknown as { session: Session }).session.id;
  await openTree(page);
  // The start node is only where the path begins.
  await nodeButton(page, '起点').click();
  await expect(inspector(page)).toContainText('任务从这里出发');
  await expect(inspector(page).getByRole('button', { name: '批准 v1 并执行', exact: true })).toHaveCount(0);
  await page.locator('[data-task-title]').click();
  await expect(inspector(page)).toContainText('最后交给你验收');
  await inspector(page).getByRole('button', { name: '批准 v1 并执行', exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: '暂停执行', exact: true })).toBeVisible();
  // Root reads as the same four parts as every node.
  for (const part of ['输入', '输出', '描述', '测试']) await expect(inspector(page).getByRole('heading', { name: part, exact: true })).toBeVisible();
  await dismissNotice(page);
  await closeInspector(page);

  const grant = await claimNode('d-scan');
  const report = await tool('arborun_report', {
    sessionId, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: randomUUID(), status: 'passed',
    summary: '每张照片都检查过了', evidence: [], checks: [{ criterion: '每张照片都有结论', passed: true, evidence: 'scan.py 退出码 0' }],
    caseResults: [
      { case: 0, passed: true, actual: '24997 张能打开，3 张是坏图', proof: [{ kind: 'command', command: 'python data/scan.py', output: 'ok 24997 / broken 3' }] },
      { case: 1, passed: true, actual: '空文件被记为坏图', proof: [{ kind: 'image', path: resolve('plugins/arborun/assets/logo.png'), caption: '坏图清单截图' }] },
      { case: 2, passed: true, actual: '超大照片能打开，照常记录', proof: [{ kind: 'video', path: resolve('tests/fixtures/demo.webm'), caption: '检查过程录像' }] },
    ],
  });
  expect(report.isError, JSON.stringify(report.content)).not.toBe(true);

  await nodeButton(page, '照片整理干净').click();
  await inspector(page).getByText('Agent 要做的步骤').click();
  // The stage is broken into several small steps, not one.
  await expect(inspector(page).locator('details.fold .link-chip')).toHaveCount(4);
  await inspector(page).getByRole('button', { name: '清点并检查每张照片' }).click();
  await expect(inspector(page)).toHaveAttribute('data-inspector-node', 'd-scan');
  const rows = inspector(page).locator('.cases > li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-result', 'passed');
  await expect(rows.nth(0)).toContainText('实际：24997 张能打开，3 张是坏图');
  await expect(rows.nth(0).locator('.term')).toContainText('$ python data/scan.py');
  // The screenshot and the clip come from Arborun's own store, loaded through the panel's authorised channel.
  const image = rows.nth(1).locator('img.media');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const video = rows.nth(2).locator('video.media');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('reference-sample-results.png'), fullPage: true });
});
