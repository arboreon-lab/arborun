import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ChatProvider, validateConfig } from '../src/harness/provider';
import type { ModelMessage, ToolDefinition } from '../src/shared/types';

const servers: Server[] = [];
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return { baseUrl, provider: new ChatProvider(() => ({ baseUrl, model: 'test-model', apiKey: 'test-secret-do-not-log' })) };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
const messages: ModelMessage[] = [{ role: 'user', content: '只读取已授权资料' }];
const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_source', description: '读取资料快照', parameters: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false } } }];
const complete = (provider: ChatProvider, signal = new AbortController().signal) => provider.complete(messages, tools, signal, 1024);
function reply(response: ServerResponse, data: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); }

describe('model endpoint configuration', () => {
  it('allows HTTPS and explicit loopback HTTP but rejects credentials, queries and remote plaintext', () => {
    const base = { model: 'm', apiKey: '' };
    expect(validateConfig({ ...base, baseUrl: 'https://provider.example/v1/' }).baseUrl).toBe('https://provider.example/v1');
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(validateConfig({ ...base, baseUrl: `http://${host}:11434/v1` })).toBeDefined();
    for (const baseUrl of ['http://provider.example/v1', 'https://secret:password@provider.example/v1', 'https://provider.example/v1?api_key=secret', 'https://provider.example/v1#secret', 'file:///tmp/model']) {
      expect(() => validateConfig({ ...base, baseUrl })).toThrow();
    }
  });
});

describe('Chat Completions transport', () => {
  it('sends the bounded tool protocol and parses a tool call with usage', async () => {
    let received: any;
    let authorization: string | undefined;
    const { provider } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        received = { url: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) };
        authorization = request.headers.authorization;
        reply(response, { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_source', arguments: '{"sourceId":"allowed"}' } }] } }], usage: { total_tokens: 50 } });
      });
    });
    const result = await complete(provider);
    expect(received).toMatchObject({ method: 'POST', url: '/v1/chat/completions', body: { model: 'test-model', messages, tools, stream: false, max_completion_tokens: 1024, parallel_tool_calls: false } });
    expect(authorization).toBe('Bearer test-secret-do-not-log');
    expect(result).toEqual({ content: '', toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_source', arguments: '{"sourceId":"allowed"}' } }], tokens: 50 });
  });
  it('forwards tool result messages on the next model call', async () => {
    let receivedMessages: unknown;
    const { provider } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { receivedMessages = JSON.parse(Buffer.concat(chunks).toString()).messages; reply(response, { choices: [{ message: { content: '任务\n└─ 已读取资料' }, finish_reason: 'stop' }] }); });
    });
    const history: ModelMessage[] = [...messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_source', arguments: '{"sourceId":"allowed"}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: '资料\n└─ 已授权内容' }];
    expect((await provider.complete(history, tools, new AbortController().signal, 1024)).content).toContain('已读取资料');
    expect(receivedMessages).toEqual(history);
  });
  it('aborts an in-flight model response instead of returning a late result', async () => {
    let arrive!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const { provider } = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); arrive(); });
    const controller = new AbortController();
    const result = complete(provider, controller.signal);
    const rejection = expect(result).rejects.toThrow();
    await arrived;
    controller.abort();
    await rejection;
  });
  it('refuses redirects without forwarding the bearer token to a second endpoint', async () => {
    let hits = 0;
    const { provider } = await fixture((_request, response) => { hits++; response.writeHead(302, { Location: '/sink' }); response.end(); });
    await expect(complete(provider)).rejects.toThrow();
    expect(hits).toBe(1);
  });
  it('reports status without propagating provider error bodies or credentials', async () => {
    const { provider } = await fixture((_request, response) => reply(response, { error: 'test-secret-do-not-log user-private-data' }, 401));
    const error = await complete(provider).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected provider request to reject');
    expect(error.message).toContain('401');
    expect(error.message).not.toContain('test-secret');
    expect(error.message).not.toContain('user-private-data');
  });
  it.each(['length', 'content_filter'])('rejects incomplete or refused responses (%s)', async finish_reason => {
    const { provider } = await fixture((_request, response) => reply(response, { choices: [{ finish_reason, message: { content: 'partial' } }] }));
    await expect(complete(provider)).rejects.toThrow();
  });
  it('bounds response size and validates tool-call structure before returning it', async () => {
    const large = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(2 * 1024 * 1024 + 1)); });
    await expect(complete(large.provider)).rejects.toThrow('响应过大');
    const invalid = await fixture((_request, response) => reply(response, { choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'unknown', function: { name: 'read_source', arguments: {} } }] } }] }));
    await expect(complete(invalid.provider)).rejects.toThrow('协议');
  });
});
