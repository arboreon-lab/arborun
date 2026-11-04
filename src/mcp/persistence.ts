import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArborunSnapshot } from './schema';

export class SnapshotFile {
  readonly file: string;
  private locked = false;
  constructor(readonly directory: string) { this.file = join(directory, 'sessions.json'); }

  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'server.lock');
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      this.locked = true;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = JSON.parse(await readFile(lock, 'utf8')).pid; }
      catch { throw new Error('数据目录锁无法读取，请检查已有 Arborun 服务。'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('数据目录锁无效。');
      try { process.kill(pid, 0); }
      catch (probe: any) {
        if (probe.code === 'ESRCH') {
          await rm(lock);
          return this.acquire();
        }
        throw probe;
      }
      throw new Error('此数据目录已有 Arborun 服务；请使用该服务或另选数据目录。');
    }
  }

  async load(): Promise<ArborunSnapshot | undefined> {
    try {
      if ((await stat(this.file)).size > 32 * 1024 * 1024) throw new Error('状态文件超过 32 MB。');
      const snapshot = JSON.parse(await readFile(this.file, 'utf8'));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.grants)) {
        throw new Error('无法识别 Arborun 状态文件；保留原文件以便恢复。');
      }
      return snapshot;
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(snapshot: ArborunSnapshot): Promise<void> {
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('任务历史超过 32 MB；未保存此修改。');
    const temp = join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
    } finally { await rm(temp, { force: true }); }
  }

  async release(): Promise<void> {
    if (this.locked) { await rm(join(this.directory, 'server.lock'), { force: true }); this.locked = false; }
  }
}
