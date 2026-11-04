import { afterEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { request as httpRequest, type Server } from 'node:http';
import { ArborunRuntime } from '../src/mcp/server';
import type { ArborunSnapshot, ProposeInput, Session } from '../src/mcp/schema';

const HTML = '<!doctype html><html lang="zh"><body>Arborun tree</body></html>';
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(close => close()));
});

function plan(): ProposeInput {
  return {
    title: '补全 CSV 导出说明', goal: '读取现有约定，并生成明确编码的说明',
    context: ['现有接口要求 UTF-8 编码'],
    agents: [{ id: 'main', name: '主 Agent', role: '执行与核对', scope: '说明文档', budget: '最多两个节点' }],
    nodes: [
      { id: 'root', parentId: null, kind: 'group', title: 'CSV 导出说明' },
      {
        id: 'read', parentId: 'root', kind: 'action', title: '确认编码', agentId: 'main',
        action: '读取接口说明并定位编码要求', target: '接口说明.md', input: '用户提供的接口说明',
        acceptance: ['找到明确编码要求'], failure: '未找到时报告阻塞并询问用户',
      },
      {
        id: 'write', parentId: 'root', kind: 'action', title: '补全说明', agentId: 'main',
        action: '补充编码字段', target: '导出说明.md', input: '已核实的编码要求',
        acceptance: ['文档明确写出 UTF-8'], failure: '修正文档后再次核对', dependsOn: ['read'],
      },
    ],
  };
}

async function connection(options: Partial<ConstructorParameters<typeof ArborunRuntime>[0]> = {}) {
  const runtime = new ArborunRuntime({ html: HTML, save: async () => {}, ...options });
  const client = new Client({ name: 'arborun-test-host', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => {
    await Promise.allSettled([client.close(), runtime.mcp.close()]);
  });
  await Promise.all([runtime.mcp.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name, arguments: args }) as CallToolResult;
  return { runtime, client, call };
}

function session(result: CallToolResult): Session {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent?.session).toBeDefined();
  return result.structuredContent!.session as unknown as Session;
}

function token(result: CallToolResult) {
  expect(result._meta?.uiToken).toEqual(expect.any(String));
  return result._meta!.uiToken as string;
}

function claims(result: CallToolResult) {
  session(result);
  return {
    attemptId: result.structuredContent!.attemptId as string,
    claimToken: result.structuredContent!.claimToken as string,
  };
}

function closeHttp(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  });
}

describe('Arborun MCP transport and persistence boundary', () => {
  test('advertises a real app resource, thread entrypoint and app-only user operations', async () => {
    const { client, call } = await connection();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'arborun_claim', 'arborun_plan', 'arborun_read', 'arborun_report', 'arborun_submit', 'arborun_user',
    ]);
    const read = tools.find(tool => tool.name === 'arborun_read')!;
    expect(read._meta).toMatchObject({
      ui: { resourceUri: 'ui://arborun/tree.html' },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    });
    expect(tools.find(tool => tool.name === 'arborun_user')?._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(tools.find(tool => tool.name === 'arborun_claim')?._meta).toMatchObject({ ui: { visibility: ['model'] } });
    // Raw MCP lists metadata; the host is responsible for filtering model/app audiences.
    const resource = await client.readResource({ uri: 'ui://arborun/tree.html' });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: HTML });
    expect(resource.contents[0]._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] } } });
    expect((await call('arborun_read', {})).structuredContent).toEqual({ sessions: [] });
  });

  test('rejects injected approval and execution before a real UI approval', async () => {
    const { call } = await connection();
    const forged = await call('arborun_plan', { ...plan(), approved: true });
    expect(forged.isError).toBe(true);
    expect((await call('arborun_read', {})).structuredContent).toEqual({ sessions: [] });

    const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    expect(task.status).toBe('draft');
    expect(task.approval).toBeUndefined();
    const claim = await call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: 'read', agentId: 'main' });
    expect(claim.isError).toBe(true);
    expect(session(await call('arborun_read', { sessionId: task.id })).attempts).toHaveLength(0);

    const denied = await call('arborun_user', {
      uiToken: 'model-invented-token', action: { type: 'approve', sessionId: task.id, expectedRevision: 1 },
    });
    expect(denied.isError).toBe(true);
    expect(session(await call('arborun_read', { sessionId: task.id })).approval).toBeUndefined();
    expect(JSON.stringify(proposed.content)).not.toContain(token(proposed));
    expect(JSON.stringify(proposed.structuredContent)).not.toContain(token(proposed));
  });

  test('round trips approval, dependency claims, evidence and separate human acceptance', async () => {
    let saved: ArborunSnapshot | undefined;
    const { call } = await connection({ save: async value => { saved = structuredClone(value); } });
    const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    const uiToken = token(proposed);
    const approved = session(await call('arborun_user', {
      uiToken, action: { type: 'approve', sessionId: task.id, expectedRevision: 1 },
    }));
    expect(approved.approval?.revision).toBe(1);
    expect(approved.events.at(-1)?.provenance).toBe('user_confirmed');
    expect((await call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: 'write', agentId: 'main' })).isError).toBe(true);
    expect((await call('arborun_submit', { sessionId: task.id, revision: 1 })).isError).toBe(true);

    for (const node of approved.nodes.filter(node => node.kind !== 'group')) {
      const claimed = claims(await call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: node.id, agentId: 'main' }));
      const report = {
        sessionId: task.id, ...claimed, eventId: `result-${node.id}`, status: 'passed',
        summary: `${node.title}已完成`, evidence: [`${node.target}：UTF-8`],
        checks: node.acceptance.map(criterion => ({ criterion, passed: true, evidence: '已核对原文 UTF-8' })),
      };
      expect((await call('arborun_report', { ...report, checks: [] })).isError).toBe(true);
      const reported = session(await call('arborun_report', report));
      expect(reported.nodes.find(item => item.id === node.id)?.status).toBe('passed');
      expect(reported.attempts.at(-1)?.provenance).toBe('agent_reported');
      const retry = session(await call('arborun_report', report));
      expect(retry.events).toHaveLength(reported.events.length);
    }

    const review = session(await call('arborun_submit', { sessionId: task.id, revision: 1 }));
    expect(review.status).toBe('review');
    expect(review.review?.tree).toContain('UTF-8');
    expect(review.review?.acceptedAt).toBeUndefined();
    const accepted = session(await call('arborun_user', {
      uiToken, action: { type: 'accept', sessionId: task.id, expectedRevision: 1 },
    }));
    expect(accepted.status).toBe('accepted');
    expect(accepted.review?.acceptedAt).toEqual(expect.any(String));
    expect(saved?.sessions[0].status).toBe('accepted');
  });

  test('serializes competing claims so only one attempt can own the node', async () => {
    const { call } = await connection();
    const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    await call('arborun_user', { uiToken: token(proposed), action: { type: 'approve', sessionId: task.id, expectedRevision: 1 } });
    const outcomes = await Promise.all([0, 1].map(() => call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: 'read', agentId: 'main' })));
    expect(outcomes.filter(result => result.isError)).toHaveLength(1);
    const current = session(await call('arborun_read', { sessionId: task.id }));
    expect(current.attempts).toHaveLength(1);
    expect(current.nodes.find(node => node.id === 'read')?.status).toBe('running');
  });

  test('failed persistence does not publish approval or poison the mutation queue', async () => {
    let fail = false;
    let saved: ArborunSnapshot | undefined;
    const { call } = await connection({ save: async value => {
      if (fail) throw new Error('disk full');
      saved = structuredClone(value);
    } });
    const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    const action = { uiToken: token(proposed), action: { type: 'approve', sessionId: task.id, expectedRevision: 1 } };
    fail = true;
    expect((await call('arborun_user', action)).isError).toBe(true);
    expect(session(await call('arborun_read', { sessionId: task.id })).status).toBe('draft');
    expect(saved?.sessions[0].approval).toBeUndefined();
    expect((await call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: 'read', agentId: 'main' })).isError).toBe(true);
    fail = false;
    expect(session(await call('arborun_user', action)).status).toBe('approved');
    expect(saved?.sessions[0].approval?.revision).toBe(1);
  });

  test('restart recovers an in-flight attempt without replaying it and rotates UI capability', async () => {
    let saved: ArborunSnapshot | undefined;
    const first = await connection({ save: async value => { saved = structuredClone(value); } });
    const proposed = await first.call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    await first.call('arborun_user', { uiToken: token(proposed), action: { type: 'approve', sessionId: task.id, expectedRevision: 1 } });
    await first.call('arborun_claim', { sessionId: task.id, revision: 1, nodeId: 'read', agentId: 'main' });
    expect(saved?.sessions[0].attempts[0].status).toBe('running');
    const next = await connection({ snapshot: saved });
    const restored = await next.call('arborun_read', { sessionId: task.id });
    expect(token(restored)).not.toBe(token(proposed));
    const recovered = session(restored);
    expect(recovered.status).toBe('paused');
    expect(recovered.approval).toBeUndefined();
    expect(recovered.attempts[0].status).toBe('interrupted');
    expect((await next.call('arborun_user', {
      uiToken: token(proposed), action: { type: 'approve', sessionId: task.id, expectedRevision: 1 },
    })).isError).toBe(true);
  });

  test('localhost preview rejects missing capability, cross-origin and forged Host requests', async () => {
    const { runtime, call } = await connection();
    const server = await runtime.listen(0);
    cleanup.push(() => closeHttp(server));
    const base = new URL(runtime.panelUrl).origin;
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(`${base}/api/read`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${runtime.uiToken}` };
    expect((await fetch(`${base}/api/read`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
    // Node fetch normalizes Host, so send this header through the HTTP client directly.
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/read`, { headers: { ...headers, Host: 'untrusted.example' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end();
    });
    expect(forgedHostStatus).toBe(403);
    const response = await fetch(`${base}/api/read`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
    const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
    const task = session(proposed);
    const approved = await fetch(`${base}/api/user`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ action: { type: 'approve', sessionId: task.id, expectedRevision: 1 } }),
    });
    expect(approved.status).toBe(200);
    expect(session(await call('arborun_read', { sessionId: task.id })).status).toBe('approved');
  });
});
