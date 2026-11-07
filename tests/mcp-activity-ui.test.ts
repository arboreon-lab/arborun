import { describe, expect, test } from 'vitest';
import { ArborunService } from '../src/mcp/core';
import { collaborationMessages, currentWork, visibleAncestor } from '../src/mcp-ui/collaboration-model';

function setup() {
  const service = new ArborunService();
  const session = service.propose({ title: '协作界面测试', goal: '区分消息发出与实际接收', context: [],
    agents: ['a', 'b'].map(id => ({ id, name: id, role: '核对', scope: '固定测试数据', budget: '一次' })),
    nodes: [{ id: 'root', parentId: null, kind: 'group', title: '核对' }, ...['a', 'b'].map(id => ({ id, parentId: 'root', kind: 'action' as const, title: id,
      action: '核对输入', target: 'input.json', input: '固定输入', acceptance: ['一致'], failure: '停止', agentId: id }))] });
  service.userAction({ type: 'approve', sessionId: session.id, expectedRevision: 1 });
  const a = service.claim({ sessionId: session.id, revision: 1, nodeId: 'a', agentId: 'a' });
  const b = service.claim({ sessionId: session.id, revision: 1, nodeId: 'b', agentId: 'b' });
  return { service, id: session.id, a: { attemptId: a.attemptId, claimToken: a.claimToken }, b: { attemptId: b.attemptId, claimToken: b.claimToken } };
}

describe('observed collaboration in the tree', () => {
  test('a sent message is not shown as received, and presence advances to the newest observed event', () => {
    const { service, id, a, b } = setup();
    service.activity({ sessionId: id, ...a, kind: 'action', eventId: 'read', summary: '已读取输入', runtimeAgentId: 'actual-a' });
    service.activity({ sessionId: id, ...a, kind: 'message_sent', eventId: 'sent', messageId: 'handoff', toAgentId: 'b', toNodeId: 'b', summary: '交接输入路径' });
    expect(collaborationMessages(service.get(id))[0].received).toBeUndefined();
    expect(currentWork(service.get(id)).find(work => work.attempt.agentId === 'a')?.runtimeAgentId).toBe('actual-a');
    const received = service.activity({ sessionId: id, ...b, kind: 'message_received', eventId: 'received', messageId: 'handoff', summary: '已实际收到输入路径' });
    expect(collaborationMessages(received)[0].received?.agentId).toBe('b');
    expect(currentWork(received).find(work => work.attempt.agentId === 'b')?.activity?.summary).toBe('已实际收到输入路径');
    service.userAction({ type: 'pause', sessionId: id, expectedRevision: 1 });
    expect(currentWork(service.get(id))).toHaveLength(0);
  });
  test('collapsed task positions represent hidden descendants without changing node relationships', () => {
    const { service, id } = setup(); const session = service.get(id);
    expect(visibleAncestor(session, 'a', new Set(['root']))).toBe('root');
    expect(visibleAncestor(session, 'a', new Set(['a', 'b']))).toBe('a');
    expect(visibleAncestor(session, 'missing', new Set(['root']))).toBeUndefined();
    expect(service.get(id).nodes.find(node => node.id === 'a')?.parentId).toBe('root');
  });
});
