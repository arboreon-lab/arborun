import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('desktop edits, executes conditional child agent, records decision, persists and retries locally', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arborun-e2e-'));
  const launch = () => electron.launch({ ...(process.env.ARBORUN_PACKAGED_EXECUTABLE ? { executablePath: process.env.ARBORUN_PACKAGED_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env: { ...process.env, ARBORUN_DATA_DIR: dataDir, ARBORUN_TEST: '1' } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'CSV 导出需求', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('.execution-footer')!.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
    await page.locator('#node-write-requirements').click();
    await page.getByTestId('node-action-input').fill('新增 CSV 导出子树，明确 UTF-8 编码、字段顺序和空数据行为。');
    await page.getByTestId('node-save').click();
    await page.screenshot({ path: 'test-results/desktop-edit.png', fullPage: true });
    const alerts = await page.getByRole('alert').allTextContents();
    expect(alerts, 'saving a valid node should not report an error').toEqual([]);
    await expect.poll(() => page.evaluate(async () => (await window.arborun.getState()).tasks[0].revision)).toBe(2);
    await page.getByRole('button', { name: '确认并运行', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /确认.*运行/ }).click();
    await expect.poll(() => page.evaluate(async () => (await window.arborun.getState()).tasks[0].status)).toBe('waiting');
    await page.locator('#node-choose-format').click();
    await page.getByRole('button', { name: '采用 UTF-8', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.arborun.getState()).tasks[0].status)).toBe('completed');
    const completed = await page.evaluate(async () => (await window.arborun.getState()).tasks[0]);
    expect(completed.nodes.find(n => n.id === 'agent-review')?.status).toBe('passed');
    expect(completed.artifacts.filter(a => a.adopted).length).toBeGreaterThanOrEqual(4);
    expect(completed.nodes.find(n => n.id === 'choose-format')?.decision).toBe('采用 UTF-8');
    await page.getByRole('tab', { name: '执行', exact: true }).click();
    await page.locator('#node-check-conflict').click();
    if (await page.getByRole('button', { name: '关闭通知' }).count()) await page.getByRole('button', { name: '关闭通知' }).click();
    await page.screenshot({ path: 'test-results/desktop-execution.png', fullPage: true });
    await page.getByRole('tab', { name: '结果', exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-result.png', fullPage: true });
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.arborun.getState()).tasks[0].status)).toBe('completed');
    await page.evaluate(async () => {
      await window.arborun.command({ type: 'retry', taskId: 'demo-task', nodeId: 'write-acceptance' });
      await window.arborun.command({ type: 'run', taskId: 'demo-task' });
    });
    await expect.poll(() => page.evaluate(async () => (await window.arborun.getState()).tasks[0].status)).toBe('completed');
    const retried = await page.evaluate(async () => (await window.arborun.getState()).tasks[0]);
    expect(retried.nodes.find(n => n.id === 'write-requirements')?.attempts).toBe(1);
    expect(retried.nodes.find(n => n.id === 'write-acceptance')?.attempts).toBe(2);
    expect(retried.artifacts.filter(a => a.nodeId === 'write-acceptance')).toHaveLength(2);
  } finally { await app.close().catch(() => undefined); await fs.rm(dataDir, { recursive: true, force: true }); }
});
