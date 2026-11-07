import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SnapshotFile } from './persistence';
import { ArtifactStore } from './artifacts';
import { ArborunRuntime } from './server';

if (process.argv[2] === 'install') {
  const { install } = await import('./install');
  try { await install(process.argv.slice(3)); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  process.exit();
}

// Opens the local panel for hosts that cannot render MCP Apps; the URL carries the user token, so it never goes to the model.
function openUrl(url: string) {
  if (process.env.ARBORUN_OPEN_BROWSER === '0') return false;
  const [command, args] = platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(command, args as string[], { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

const data = new SnapshotFile(resolve(process.env.ARBORUN_MCP_DATA_DIR ?? join(homedir(), '.arborun', 'data')));
let runtime: ArborunRuntime | undefined;
let http: Awaited<ReturnType<ArborunRuntime['listen']>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  http?.closeAllConnections();
  await new Promise<void>(r => http ? http.close(() => r()) : r());
  await runtime?.mcp.close();
  await data.release();
}

try {
  await data.acquire();
  runtime = new ArborunRuntime({ snapshot: await data.load(), save: value => data.save(value), openUrl, artifacts: new ArtifactStore(join(data.directory, 'artifacts')),
    html: await readFile(join(dirname(fileURLToPath(import.meta.url)), 'tree.html'), 'utf8') });
  await runtime.persistRecovery();
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口。');
  http = await runtime.listen(port);
  console.error(`Arborun local panel: ${runtime.panelUrl}`);
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  if (!process.argv.includes('--web-only')) {
    const transport = new StdioServerTransport();
    runtime.mcp.server.onclose = () => void stop();
    await runtime.mcp.connect(transport);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop();
  process.exitCode = 1;
}
