import initSqlJs, { type Database } from 'sql.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppState, StateStore } from '../shared/types';

export class SqliteStore implements StateStore {
  private db?: Database;
  private queue = Promise.resolve();
  constructor(private filename: string, private wasmPath: string) {}
  async load(): Promise<AppState | null> {
    const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
    let bytes: Buffer | undefined;
    try { const stat = await fs.stat(this.filename); if (stat.size > 100 * 1024 * 1024) throw new Error('任务数据库超过本版大小限制。'); bytes = await fs.readFile(this.filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, payload TEXT NOT NULL)');
    const rows = this.db.exec('SELECT version, payload FROM workspace WHERE id=1');
    if (!rows.length) return null;
    if (rows[0].values[0][0] !== 1) throw new Error('数据库版本高于本应用，未修改原数据。');
    const state = JSON.parse(String(rows[0].values[0][1]));
    if (state.schemaVersion !== 1 || !Array.isArray(state.tasks)) throw new Error('任务数据库内容无效，原文件已保留。');
    return state as AppState;
  }
  async save(state: AppState): Promise<void> {
    const payload = JSON.stringify(state);
    if (Buffer.byteLength(payload, 'utf8') > 80 * 1024 * 1024) throw new Error('任务数据达到本版 80 MB 保存上限，请导出已有任务；本次更改尚未保存。');
    const next = this.queue.then(async () => {
      if (!this.db) throw new Error('数据库尚未初始化。');
      this.db.run('INSERT INTO workspace(id,version,payload) VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET version=1,payload=excluded.payload', [payload]);
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temp = `${this.filename}.tmp`;
      const handle = await fs.open(temp, 'w', 0o600);
      try { await handle.writeFile(this.db.export()); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.filename);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
