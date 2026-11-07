import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ARTIFACT_ID, type CaseResult } from './schema';

/**
 * Screenshots and short demo recordings the agent reports by local path. Arborun copies each file into its own store,
 * named by content hash, so the proof survives the agent's temp folders and can be shown in the panel.
 */
const MB = 1024 * 1024;
const TYPES = [
  { ext: 'png', mime: 'image/png', limit: 10 * MB, magic: (b: Buffer) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { ext: 'jpg', mime: 'image/jpeg', limit: 10 * MB, magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', limit: 16 * MB, magic: (b: Buffer) => b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', limit: 10 * MB, magic: (b: Buffer) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { ext: 'mp4', mime: 'video/mp4', limit: 16 * MB, magic: (b: Buffer) => b.toString('latin1', 4, 8) === 'ftyp' },
  { ext: 'webm', mime: 'video/webm', limit: 16 * MB, magic: (b: Buffer) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
] as const;
export const artifactMime = (id: string) => TYPES.find(t => id.endsWith(`.${t.ext}`))?.mime ?? 'application/octet-stream';

export class ArtifactStore {
  constructor(readonly directory: string) {}

  /** Copies a local image or video into the store and returns its id. Only real PNG/JPEG/GIF/WebP/MP4/WebM files are accepted. */
  async ingest(path: string): Promise<string> {
    const file = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    if (!isAbsolute(file)) throw new Error(`截图或录像请给绝对路径：${path}`);
    let info;
    try { info = await stat(file); } catch { throw new Error(`找不到截图或录像文件：${path}`); }
    if (!info.isFile()) throw new Error(`不是文件：${path}`);
    const head = Buffer.alloc(16);
    const handle = await open(file, 'r');
    try { await handle.read(head, 0, 16, 0); } finally { await handle.close(); }
    const type = TYPES.find(t => t.magic(head));
    if (!type) throw new Error(`只支持 PNG、JPEG、GIF、WebP 截图和 MP4、WebM 录像：${path}`);
    if (info.size > type.limit) throw new Error(`文件太大（${(info.size / MB).toFixed(1)} MB），${type.ext.toUpperCase()} 最多 ${type.limit / MB} MB：${path}`);
    const bytes = await readFile(file);
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${type.ext}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, id);
    try { await stat(target); } catch { await writeFile(target, bytes, { mode: 0o600 }); }
    return id;
  }

  async read(id: string): Promise<{ id: string; mimeType: string; data: string }> {
    if (!ARTIFACT_ID.test(id)) throw new Error('证据文件编号无效');
    try { return { id, mimeType: artifactMime(id), data: (await readFile(join(this.directory, id))).toString('base64') }; }
    catch { throw new Error('证据文件不存在或已被删除'); }
  }

  /** Replaces local media paths in sample results with stored artifact ids; the original path stays for reference. */
  async storeProofs(results: CaseResult[] | undefined): Promise<CaseResult[] | undefined> {
    if (!results) return results;
    return Promise.all(results.map(async r => ({
      ...r, proof: await Promise.all((r.proof ?? []).map(async p =>
        (p.kind === 'image' || p.kind === 'video') && p.path && !p.artifact ? { ...p, artifact: await this.ingest(p.path) } : p)),
    })));
  }
}
