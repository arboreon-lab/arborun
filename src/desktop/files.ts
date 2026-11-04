import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Source, Task } from '../shared/types';

export async function readSelectedFiles(paths: string[]): Promise<Source[]> {
  if (paths.length > 16) throw new Error('一次最多导入 16 个文件。');
  let total = 0;
  const sources: Source[] = [];
  for (const filename of paths) {
    if (!['.md', '.txt', '.json'].includes(path.extname(filename).toLowerCase())) throw new Error('首版支持 Markdown、TXT 和 JSON。');
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('请直接选择原始文件，不导入符号链接。');
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('每个资料文件需小于 512 KB。');
      // Read at most the cap + 1 even if another process grows the file after stat.
      const data = Buffer.alloc(512 * 1024 + 1);
      let length = 0;
      while (length < data.length) { const read = await handle.read(data, length, data.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > 512 * 1024) throw new Error('文件读取过程中超过大小限制。');
      total += length; if (total > 2 * 1024 * 1024) throw new Error('本次资料总量需小于 2 MB。');
      const bytes = data.subarray(0, length);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('资料必须为 UTF-8 文本。');
      sources.push({ id: randomUUID(), name: path.basename(filename), content, hash: createHash('sha256').update(bytes).digest('hex') });
    } finally { await handle.close(); }
  }
  return sources;
}
export function taskMarkdown(task: Task): string {
  const lines = [`${task.title.replace(/[\r\n]/g, ' ')}`, `├─ 任务：${task.prompt.replace(/[\r\n]/g, ' ')}`, `├─ 模式：${task.mode === 'demo' ? '演示（不调用模型）' : '模型执行'}`, `├─ 计划版本：${task.revision}`, '└─ 执行树'];
  const walk = (parent: string | null, prefix: string, seen: Set<string>) => {
    const nodes = task.nodes.filter(n => n.parentId === parent);
    nodes.forEach((n, i) => { if (seen.has(n.id)) return; seen.add(n.id); const last = i === nodes.length - 1;
      lines.push(`${prefix}${last ? '└─' : '├─'} ${n.title.replace(/[\r\n]/g, ' ')} [${n.status}]`);
      const sub = prefix + (last ? '   ' : '│  ');
      lines.push(`${sub}├─ 动作：${n.action.replace(/[\r\n]/g, ' ')}`);
      lines.push(`${sub}├─ 对象：${n.target.replace(/[\r\n]/g, ' ')}`);
      lines.push(`${sub}├─ 通过条件：${n.acceptance.join('；').replace(/[\r\n]/g, ' ')}`);
      lines.push(`${sub}${task.nodes.some(child => child.parentId === n.id) ? '├─' : '└─'} 结果：${(n.result ?? '尚未产生').replace(/[\r\n]/g, ' ')}`);
      walk(n.id, sub, seen);
    });
  };
  walk(null, '   ', new Set()); return lines.join('\n') + '\n';
}
export async function exportTask(task: Task, parentDirectory: string): Promise<string> {
  const root = await fs.realpath(parentDirectory);
  const out = await fs.mkdtemp(path.join(root, 'Arborun-'));
  await fs.writeFile(path.join(out, '执行树.md'), taskMarkdown(task), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(out, 'task.json'), JSON.stringify({ schemaVersion: 1, task }, null, 2), { flag: 'wx', mode: 0o600 });
  const artifactDir = path.join(out, 'artifacts'); await fs.mkdir(artifactDir, { mode: 0o700 });
  for (const [i, artifact] of task.artifacts.entries()) {
    const name = artifact.name.replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 90).replace(/^\.+/, '') || 'artifact.md';
    await fs.writeFile(path.join(artifactDir, `${i + 1}-v${artifact.version}-${name}`), artifact.content, { flag: 'wx', mode: 0o600 });
  }
  return out;
}
