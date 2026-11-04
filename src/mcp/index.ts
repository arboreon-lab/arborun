import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SnapshotFile } from './persistence';
import { ArborunRuntime } from './server';

const data = new SnapshotFile(resolve(process.env.ARBORUN_MCP_DATA_DIR ?? join(process.cwd(), '.arborun-mcp')));
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
  runtime = new ArborunRuntime({ snapshot: await data.load(), save: value => data.save(value),
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
