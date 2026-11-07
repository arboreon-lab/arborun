import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const data = await mkdtemp(join(tmpdir(), 'arborun-stdio-'));
const clients = [];
async function connect() {
  const client = new Client({ name: 'arborun-stdio-check', version: '1' });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist-mcp/index.mjs')],
    // A test client has no UI; keep the server from opening the panel in the user's browser.
    env: { ...process.env, ARBORUN_MCP_DATA_DIR: data, ARBORUN_OPEN_BROWSER: '0' }, stderr: 'pipe' }));
  return client;
}
try {
  const client = await connect();
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  assert.ok(listed.tools.some(tool => tool.name === 'arborun_artifact'));
  assert.ok(listed.tools.some(tool => tool.name === 'arborun_activity'));
  const resource = await client.readResource({ uri: 'ui://arborun/tree.html' });
  assert.match(resource.contents[0].mimeType, /mcp-app/);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const plan = await call('arborun_plan', {
    title: '隔离 stdio 验证任务', goal: '验证打包后的服务协议，不操作用户文件', context: ['自动化协议测试'],
    agents: [{ id: 'main', name: '测试 Agent', role: '协议验证', scope: '隔离测试状态', budget: '1 个节点' }],
    nodes: [{ id: 'root', parentId: null, kind: 'group', title: '协议验证' },
      { id: 'check', parentId: 'root', kind: 'action', title: '检查协议', action: '验证 MCP 生命周期', target: '临时任务', input: '测试数据', acceptance: ['检查完成'], failure: '输出测试错误' }],
  });
  assert.ok(!plan.isError, JSON.stringify(plan.content));
  const sessionId = plan.structuredContent.session.id;
  assert.ok((await call('arborun_claim', { sessionId, revision: 1, nodeId: 'check', agentId: 'main' })).isError);
  // Test-only human control channel. Production host agents must never self-approve.
  const uiToken = plan._meta.uiToken;
  assert.ok(!(await call('arborun_user', { uiToken, action: { sessionId, expectedRevision: 1, type: 'approve' } })).isError);
  const claim = await call('arborun_claim', { sessionId, revision: 1, nodeId: 'check', agentId: 'main' });
  assert.ok(!claim.isError);
  const { attemptId, claimToken } = claim.structuredContent;
  const report = await call('arborun_report', { sessionId, attemptId, claimToken, eventId: randomUUID(), status: 'passed', summary: '隔离协议检查完成', evidence: ['测试客户端已完成 MCP 工具调用'], checks: [{ criterion: '检查完成', passed: true, evidence: '本测试断言通过' }] });
  assert.ok(!report.isError);
  assert.equal((await call('arborun_submit', { sessionId, revision: 1 })).structuredContent.session.status, 'review');
  assert.equal((await call('arborun_user', { uiToken, action: { sessionId, expectedRevision: 1, type: 'accept' } })).structuredContent.session.status, 'accepted');
  await client.close();
  const restarted = await connect();
  assert.equal((await restarted.callTool({ name: 'arborun_read', arguments: { sessionId } })).structuredContent.session.status, 'accepted');
  console.log('stdio MCP 完整生命周期与重启持久化验证通过。');
} finally {
  await Promise.all(clients.map(c => c.close()));
  await rm(data, { recursive: true, force: true });
}
