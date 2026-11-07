import { afterEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ArborunService } from '../src/mcp/core';
import { ArborunRuntime } from '../src/mcp/server';
import type { ActivityInput, ArborunSnapshot, NodeSpec, ProposeInput, Session } from '../src/mcp/schema';

function plan(): ProposeInput {
  return { title: '并行核对导出', goal: '实现与检查 Agent 依据确认约定协作',
    context: ['本测试只验证协作协议，不执行真实业务操作'],
    agents: [
      { id: 'main', name: '主 Agent', role: '实现', scope: 'src/export.ts', budget: '本节点' },
      { id: 'review', name: '检查 Agent', role: '独立检查', scope: 'tests/export.test.ts', budget: '本节点', parentId: 'main' },
      { id: 'other', name: '其他 Agent', role: '交叉检查', scope: '结果', budget: '本节点', parentId: 'main' },
    ], nodes: [
      { id: 'root', parentId: null, kind: 'group', title: '导出协作' },
      ...[['implement', 'main'], ['verify', 'review'], ['crosscheck', 'other']].map(([id, agentId]) => ({
        id, parentId: 'root', kind: 'action' as const, title: id, action: `执行 ${id}`, target: `${id}.ts`,
        input: '已经确认的 UTF-8 约定', acceptance: ['符合已确认约定'], failure: '停止并在正常对话中调查', agentId,
      })),
    ] };
}
function setup() {
  const service = new ArborunService(), session = service.propose(plan());
  const approve = () => service.userAction({ type: 'approve', sessionId: session.id, expectedRevision: service.get(session.id).revision });
  const claim = (nodeId = 'implement', agentId = 'main') => service.claim({ sessionId: session.id, revision: service.get(session.id).revision, nodeId, agentId });
  const activity = (grant: ReturnType<typeof claim>, eventId: string, extra: Record<string, unknown> = {}) => ({
    sessionId: session.id, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId,
    kind: 'action', summary: '读取已确认导出入口', ...extra,
  }) as ActivityInput;
  return { service, id: session.id, approve, claim, activity };
}
const specs = (session: Session): NodeSpec[] => session.nodes.map(({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, when, agentId }) =>
  ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, when, agentId }));

describe('confirmed plans before executable trees', () => {
  test('rejects unanswered questions before creation or update and retains confirmed answers in versions', () => {
    const service = new ArborunService();
    expect(() => service.propose({ ...plan(), clarifications: [{ question: '目标编码是什么？' }] })).toThrow('Codex 在对话中询问');
    expect(service.list()).toEqual([]);
    const session = service.propose({ ...plan(), clarifications: [{ question: '目标编码是什么？', answer: 'UTF-8' }] });
    expect(session.clarifications).toEqual([{ question: '目标编码是什么？', answer: 'UTF-8' }]);
    expect(session.history[0].clarifications).toEqual(session.clarifications);
    expect(() => service.propose({ ...plan(), sessionId: session.id, expectedRevision: 1,
      clarifications: [{ question: '目标环境是什么？', answer: '  ' }] })).toThrow('目标环境');
    expect(service.get(session.id).revision).toBe(1);
    service.userAction({ type: 'approve', sessionId: session.id, expectedRevision: 1 });
    const tampered = service.snapshot(); tampered.sessions[0].clarifications![0].answer = 'different requirement';
    expect(() => new ArborunService(tampered)).toThrow('批准版本与计划不匹配');
    const changed = service.propose({ ...plan(), sessionId: session.id, expectedRevision: 1,
      clarifications: [{ question: '目标编码是什么？', answer: 'UTF-8 with BOM' }] });
    expect(changed.approval).toBeUndefined();
    expect(changed.history.map(item => item.clarifications?.[0].answer)).toEqual(['UTF-8', 'UTF-8 with BOM']);
    const edited = service.userAction({ type: 'edit', sessionId: session.id, expectedRevision: 2, nodes: specs(changed) });
    expect(edited.clarifications).toEqual(changed.clarifications);
    const restored = new ArborunService(service.snapshot());
    expect(restored.get(session.id).clarifications).toEqual(changed.clarifications);
  });

  test('loads older snapshots without changing existing approval hashes', () => {
    const { service, id, approve } = setup(); approve();
    const old = service.snapshot(); delete old.sessions[0].clarifications; delete old.sessions[0].activities;
    const restored = new ArborunService(old);
    expect(restored.get(id).approval).toEqual(service.get(id).approval);
    expect(restored.get(id).clarifications).toEqual([]);
    expect(restored.get(id).activities).toEqual([]);
  });
});

describe('actual action and message observations', () => {
  test('binds observable work to a valid approved attempt without completing or reassigning it', () => {
    const { service, id, approve, claim, activity } = setup();
    expect(() => service.activity({ sessionId: id, attemptId: 'forged', claimToken: 'forged', eventId: 'a', kind: 'action', summary: '伪造' })).toThrow('凭证');
    approve(); const grant = claim(), before = service.get(id);
    expect(() => service.activity({ ...activity(grant, 'a'), claimToken: 'wrong' })).toThrow('凭证');
    expect(() => service.activity({ ...activity(grant, 'a'), agentId: 'review' } as unknown as ActivityInput)).toThrow();
    const recorded = service.activity(activity(grant, 'a', { target: 'src/export.ts:12', runtimeAgentId: 'host-worker-42' }));
    expect(recorded.activities?.[0]).toMatchObject({ id: 'a', sequence: 1, revision: 1, kind: 'action', nodeId: 'implement',
      agentId: 'main', runtimeAgentId: 'host-worker-42', target: 'src/export.ts:12', provenance: 'agent_reported' });
    expect(recorded.approval).toEqual(before.approval);
    expect(recorded.nodes).toEqual(before.nodes);
    expect(JSON.stringify(recorded)).not.toContain(grant.claimToken);
  });

  test('records delivery only after an independent matching recipient report', () => {
    const { service, approve, claim, activity } = setup(); approve();
    const sender = claim(), receiver = claim('verify', 'review'), other = claim('crosscheck', 'other');
    const send = activity(sender, 'send', { kind: 'message_sent', messageId: 'm1', toAgentId: 'review', toNodeId: 'verify', summary: '实际宿主已发送：检查转义边界' });
    const sent = service.activity(send);
    expect(sent.activities).toHaveLength(1); expect(sent.activities?.[0].kind).toBe('message_sent');
    expect(() => service.activity(activity(other, 'wrong-recipient', { kind: 'message_received', messageId: 'm1' }))).toThrow('接收者');
    expect(() => service.activity(activity(receiver, 'missing', { kind: 'message_received', messageId: 'missing' }))).toThrow('没有对应');
    expect(() => service.activity(activity(sender, 'bad-target', { kind: 'message_sent', messageId: 'bad', toAgentId: 'review', toNodeId: 'crosscheck' }))).toThrow('目标节点');
    expect(() => service.activity(activity(sender, 'undeclared', { kind: 'message_sent', messageId: 'bad', toAgentId: 'unregistered' }))).toThrow('未在计划');
    const received = service.activity(activity(receiver, 'receive', { kind: 'message_received', messageId: 'm1', summary: '实际接收者读取消息并开始检查' }));
    expect(received.activities?.[1]).toMatchObject({ kind: 'message_received', nodeId: 'verify', agentId: 'review',
      messageId: 'm1', fromAgentId: 'main', fromNodeId: 'implement', toAgentId: 'review', toNodeId: 'verify', sentActivityId: 'send' });
    expect(received.events.slice(-2).map(event => event.type)).toEqual(['activity_message_sent', 'activity_message_received']);
    const restored = new ArborunService(service.snapshot(), { recover: true });
    expect(restored.get(received.id).activities).toEqual(received.activities);
    expect(restored.get(received.id).status).toBe('paused');
  });

  test('deduplicates event payloads and prevents message identity reuse and double receipt', () => {
    const { service, approve, claim, activity } = setup(); approve();
    const sender = claim(), receiver = claim('verify', 'review');
    const send = activity(sender, 'send', { kind: 'message_sent', messageId: 'm1', toAgentId: 'review' });
    service.activity(send); const before = service.get(sender.session.id);
    service.activity(send); expect(service.get(before.id).activities).toEqual(before.activities);
    expect(service.get(before.id).events).toEqual(before.events);
    expect(() => service.activity({ ...send, summary: '覆盖原消息' })).toThrow('eventId');
    expect(() => service.activity({ ...send, eventId: 'another-send' })).toThrow('messageId');
    const receive = activity(receiver, 'receive', { kind: 'message_received', messageId: 'm1' });
    service.activity(receive); service.activity(receive);
    expect(() => service.activity({ ...receive, eventId: 'another-receive' })).toThrow('已经存在');
    expect(service.get(before.id).activities).toHaveLength(2);
  });

  test('rejects paused, completed and old-version activity; old messages cannot enter a new revision', () => {
    const { service, id, approve, claim, activity } = setup(); approve();
    const sender = claim(), receiver = claim('verify', 'review');
    service.activity(activity(sender, 'send-old', { kind: 'message_sent', messageId: 'm1', toAgentId: 'review' }));
    service.userAction({ type: 'pause', sessionId: id, expectedRevision: 1 });
    expect(() => service.activity(activity(receiver, 'paused', { kind: 'message_received', messageId: 'm1' }))).toThrow('用户批准');
    service.propose({ ...plan(), sessionId: id, expectedRevision: 1 }); approve();
    expect(() => service.activity(activity(sender, 'old-action'))).toThrow('计划已更新');
    const current = claim('verify', 'review');
    expect(() => service.activity(activity(current, 'old-message', { kind: 'message_received', messageId: 'm1' }))).toThrow('当前版本没有');
    service.report({ sessionId: id, attemptId: current.attemptId, claimToken: current.claimToken, eventId: 'pass', status: 'passed',
      summary: '独立检查完成', evidence: ['隔离测试报告'], checks: [{ criterion: '符合已确认约定', passed: true, evidence: '测试记录' }] });
    expect(() => service.activity(activity(current, 'completed'))).toThrow('正在执行');
    expect(service.get(id).activities).toHaveLength(1);
  });
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(close => close())); });
async function connection() {
  let failSave = false, persisted: ArborunSnapshot | undefined;
  const runtime = new ArborunRuntime({ html: '<html></html>', save: async value => {
    if (failSave) throw new Error('disk unavailable'); persisted = structuredClone(value);
  } });
  const client = new Client({ name: 'collaboration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await Promise.allSettled([client.close(), runtime.mcp.close()]); });
  await Promise.all([runtime.mcp.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as CallToolResult;
  const proposed = await call('arborun_plan', plan() as unknown as Record<string, unknown>);
  const session = proposed.structuredContent!.session as unknown as Session;
  await call('arborun_user', { uiToken: proposed._meta!.uiToken, action: { type: 'approve', sessionId: session.id, expectedRevision: 1 } });
  const claim = await call('arborun_claim', { sessionId: session.id, revision: 1, nodeId: 'implement', agentId: 'main' });
  return { runtime, client, call, session, grant: { attemptId: claim.structuredContent!.attemptId, claimToken: claim.structuredContent!.claimToken },
    fail: (value: boolean) => { failSave = value; }, persisted: () => persisted };
}

describe('activity MCP transport and persistence', () => {
  test('advertises model-only activity and returns a compact acknowledgment without replacing normal chat', async () => {
    const { client, call, session, grant, persisted } = await connection();
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === 'arborun_activity')?._meta).toMatchObject({ ui: { visibility: ['model'] } });
    const result = await call('arborun_activity', { sessionId: session.id, ...grant, eventId: 'action', kind: 'action', summary: '实际命令：读取导出入口' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ sessionId: session.id, revision: 1, sequence: 1, activity: { agentId: 'main', kind: 'action' } });
    expect(result.structuredContent).not.toHaveProperty('session');
    expect(JSON.stringify(result.content)).not.toContain('计划版本');
    expect(result._meta).toBeUndefined();
    expect(persisted()?.sessions[0].activities).toHaveLength(1);
  });

  test('failed persistence does not publish a collaboration event and the queue remains usable', async () => {
    const { call, session, grant, fail } = await connection();
    const input = { sessionId: session.id, ...grant, eventId: 'action', kind: 'action', summary: '读取文件' };
    fail(true); expect((await call('arborun_activity', input)).isError).toBe(true);
    const unchanged = (await call('arborun_read', { sessionId: session.id })).structuredContent!.session as unknown as Session;
    expect(unchanged.activities).toEqual([]);
    fail(false); expect((await call('arborun_activity', input)).isError).not.toBe(true);
    const recorded = (await call('arborun_read', { sessionId: session.id })).structuredContent!.session as unknown as Session;
    expect(recorded.activities).toHaveLength(1);
  });
});
