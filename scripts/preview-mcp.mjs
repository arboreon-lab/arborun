import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const client = new Client({ name: 'arborun-local-preview', version: '0.2.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist-mcp/index.mjs')],
  env: { ...process.env, ARBORUN_MCP_DATA_DIR: resolve(process.env.ARBORUN_PREVIEW_DIR ?? '.arborun-mcp/preview') }, stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
await client.connect(transport);
const listed = await client.callTool({ name: 'arborun_read', arguments: {} });
if (!listed.structuredContent.sessions.length) {
  const plan = JSON.parse(await readFile('examples/mcp-plan.json', 'utf8'));
  const reply = await client.callTool({ name: 'arborun_plan', arguments: plan });
  if (reply.isError) throw new Error(JSON.stringify(reply.content));
}
console.log('示例计划已载入；不会自动执行或批准。使用上方本地链接查看。');
process.once('SIGINT', async () => { await client.close(); process.exit(); });
process.once('SIGTERM', async () => { await client.close(); process.exit(); });
