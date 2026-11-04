import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSelectedFiles, exportTask, taskMarkdown } from '../src/desktop/files';
import { SqliteStore } from '../src/harness/store';
import { createDemoState, createDemoTask } from '../src/shared/demo';

let directory: string;
beforeEach(async () => {
  const scratch = path.resolve(process.cwd(), '../../work');
  await fs.mkdir(scratch, { recursive: true });
  directory = await fs.mkdtemp(path.join(scratch, 'io-tests-'));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('user-selected source snapshots', () => {
  it('imports UTF-8 text with a content hash and no source pathname', async () => {
    const filename = path.join(directory, '中文 资料.md');
    const content = '产品\n└─ 本地优先\n';
    await fs.writeFile(filename, content);
    const sources = await readSelectedFiles([filename]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ name: '中文 资料.md', content, hash: createHash('sha256').update(content).digest('hex') });
    expect(sources[0]).not.toHaveProperty('path');
    await fs.writeFile(filename, '外部修改');
    expect(sources[0].content).toBe(content);
  });
  it('rejects unsupported, invalid UTF-8, binary and oversized source files', async () => {
    const invalid = path.join(directory, 'invalid.txt');
    await fs.writeFile(invalid, Buffer.from([0xff, 0xfe]));
    await expect(readSelectedFiles([invalid])).rejects.toThrow();
    await fs.writeFile(invalid, 'a\0b');
    await expect(readSelectedFiles([invalid])).rejects.toThrow('UTF-8');
    await fs.writeFile(invalid, Buffer.alloc(512 * 1024 + 1, 65));
    await expect(readSelectedFiles([invalid])).rejects.toThrow('512 KB');
    const executable = path.join(directory, 'file.js');
    await fs.writeFile(executable, 'console.log(1)');
    await expect(readSelectedFiles([executable])).rejects.toThrow('Markdown');
  });
  it('rejects symbolic links and total input beyond the task bound', async () => {
    const target = path.join(directory, 'target.md');
    const link = path.join(directory, 'link.md');
    await fs.writeFile(target, 'target');
    await fs.symlink(target, link);
    await expect(readSelectedFiles([link])).rejects.toThrow('符号链接');
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const filename = path.join(directory, `${i}.txt`);
      await fs.writeFile(filename, Buffer.alloc(512 * 1024, 65));
      names.push(filename);
    }
    await expect(readSelectedFiles(names)).rejects.toThrow('2 MB');
    await expect(readSelectedFiles(Array(17).fill(target))).rejects.toThrow('16');
  });
});

describe('task exports', () => {
  it('normalizes multiline user fields so they cannot break out of the exported tree', () => {
    const task = createDemoTask();
    task.title = '任务\n另起一行';
    task.prompt = '说明\r\n更多说明';
    const node = task.nodes[1];
    node.title = '节点\n伪造根';
    node.action = '动作\n另一个动作';
    node.target = '目标\r\n另一个目标';
    node.acceptance = ['通过\n条件'];
    node.result = '结果\n文本';
    const markdown = taskMarkdown(task);
    expect(markdown.split('\n')[0]).toBe('任务 另起一行');
    expect(markdown).toContain('目标  另一个目标');
    for (const line of markdown.trimEnd().split('\n').slice(1)) expect(line).toMatch(/^[ │]*(?:├─|└─)/);
  });
  it('contains untrusted filenames within a new directory and preserves existing user files', async () => {
    const task = createDemoTask();
    const sentinel = path.join(directory, 'secret.md');
    await fs.writeFile(sentinel, 'keep this user file');
    task.artifacts = ['../../secret.md', '..\\..\\secret.md', '/tmp/absolute.md', 'CON', '需求树.md'].map((name, i) => ({
      id: `artifact-${i}`, nodeId: 'write-requirements', name, content: `成果\n└─ ${i}`, version: 1,
      adopted: true, createdAt: new Date().toISOString(),
    }));
    const first = await exportTask(task, directory);
    const second = await exportTask(task, directory);
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(await fs.realpath(directory));
    expect(await fs.readFile(sentinel, 'utf8')).toBe('keep this user file');
    const files = await fs.readdir(path.join(first, 'artifacts'));
    expect(files).toHaveLength(5);
    for (const [i, name] of files.sort().entries()) {
      expect(name).not.toMatch(/[\\/]/);
      expect(await fs.readFile(path.join(first, 'artifacts', name), 'utf8')).toBe(task.artifacts[i].content);
    }
    const snapshot = JSON.parse(await fs.readFile(path.join(first, 'task.json'), 'utf8'));
    expect(snapshot.task.sources).toEqual(task.sources);
    expect(await fs.readFile(path.join(first, '执行树.md'), 'utf8')).toContain('演示（不调用模型）');
  });
});

describe('SQLite persistence', () => {
  const wasmPath = path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm');
  it('persists ordered state snapshots and reloads from a fresh store instance', async () => {
    const filename = path.join(directory, 'private', 'workspace.sqlite');
    const store = new SqliteStore(filename, wasmPath);
    expect(await store.load()).toBeNull();
    const state = createDemoState();
    state.tasks[0].title = '第一次';
    const first = store.save(state);
    state.tasks[0].title = '第二次';
    const second = store.save(state);
    await Promise.all([first, second]);
    const header = await fs.readFile(filename);
    expect(header.subarray(0, 15).toString()).toBe('SQLite format 3');
    const restored = await new SqliteStore(filename, wasmPath).load();
    expect(restored).toEqual(state);
    expect(await fs.readdir(path.dirname(filename))).toEqual(['workspace.sqlite']);
    if (process.platform !== 'win32') expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  });
  it('does not replace a corrupt database with empty state', async () => {
    const filename = path.join(directory, 'broken.sqlite');
    const original = Buffer.from('not a database; preserve me');
    await fs.writeFile(filename, original);
    await expect(new SqliteStore(filename, wasmPath).load()).rejects.toThrow();
    expect(await fs.readFile(filename)).toEqual(original);
  });
});
