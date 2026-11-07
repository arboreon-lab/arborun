import { afterEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ArborunRuntime } from '../src/mcp/server';

const plan = JSON.parse(await readFile('examples/mcp-results-plan.json', 'utf8'));
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

async function connect(capabilities: Record<string, unknown>) {
  const opened: string[] = [];
  const runtime = new ArborunRuntime({ html: '<!doctype html>', save: async () => {}, openUrl: url => { opened.push(url); return true; } });
  const server: Server = await runtime.listen();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'host-test', version: '1.0.0' }, { capabilities });
  await runtime.mcp.connect(serverSide); await client.connect(clientSide);
  cleanup.push(async () => { await client.close(); await runtime.mcp.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { client, opened, runtime };
}
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[]).map(c => c.text).join('\n');

describe('hosts without MCP Apps', () => {
  test('open the local panel in the browser once per task, without exposing the token to the model', async () => {
    const { client, opened, runtime } = await connect({});
    const first = await client.callTool({ name: 'arborun_plan', arguments: plan });
    const sessionId = (first.structuredContent as { session: { id: string } }).session.id;
    expect(opened).toEqual([`${runtime.panelUrl}&sessionId=${encodeURIComponent(sessionId)}`]);
    expect(text(first)).toContain('Arborun 面板已在用户本机浏览器中打开');
    expect(text(first)).not.toContain(runtime.uiToken);
    const again = await client.callTool({ name: 'arborun_read', arguments: { sessionId } });
    expect(opened).toHaveLength(1);
    expect(text(again)).not.toContain('面板已在用户本机浏览器中打开');
  });
  test('hosts that render MCP Apps keep the panel in the host', async () => {
    const { client, opened } = await connect({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
    const result = await client.callTool({ name: 'arborun_plan', arguments: plan });
    expect(opened).toEqual([]);
    expect(text(result)).not.toContain('浏览器中打开');
  });
  test('server instructions describe the result-centred workflow for any host', async () => {
    const { client } = await connect({});
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('kind=result');
    expect(instructions).toContain('never approve or accept for the user');
    expect(instructions).not.toContain('Codex');
  });
});
