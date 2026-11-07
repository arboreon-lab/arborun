import { describe, expect, it } from 'vitest';
import type { NodeSpec, NodeState, Session } from '../src/mcp/schema';
import { deletionImpact, nodeSpecification, previewImpact, subtreeIds } from '../src/mcp-ui/inspector-model';

const node = (id: string, parentId: string | null = 'root', extra: Partial<NodeState> = {}): NodeState => ({
  id, parentId, kind: 'action', title: id, action: '执行动作', target: '文件', input: '输入',
  acceptance: ['检查符合预期'], failure: '记录问题', dependsOn: [], agentId: 'main', status: 'draft', ...extra,
});
const session = (nodes: NodeState[], extra: Partial<Session> = {}): Session => ({
  id: 'session', title: '测试任务', goal: '验证交互', context: [], revision: 1, status: 'draft', nodes,
  agents: [{ id: 'main', name: '主 Agent', role: '执行', scope: '测试任务', budget: '一次' }],
  attempts: [], events: [], aiRequests: [], history: [], createdAt: '', updatedAt: '', ...extra,
});

describe('node inspector impact previews', () => {
  it('traces changed conditions through branch descendants and result adoption without affecting independent work', () => {
    const state = session([
      node('root', null, { kind: 'group' }), node('condition', 'root', { kind: 'condition' }),
      node('branch', 'root', { kind: 'group', when: { nodeId: 'condition', outcome: true } }),
      node('inside', 'branch'), node('worker', 'root', { kind: 'agent' }),
      node('investigate', 'worker', { dependsOn: ['inside'] }), node('adopt', 'root', { dependsOn: ['worker'] }), node('independent'),
    ]);
    const affected = previewImpact(state, { ...nodeSpecification(state.nodes[1]), action: '补充判断依据' }).map(n => n.id);
    expect(new Set(affected)).toEqual(new Set(['condition', 'branch', 'inside', 'worker', 'investigate', 'adopt']));
  });

  it('includes running work on other branches because a new version revokes its old claim', () => {
    const work = node('running', 'root', { status: 'running', attemptId: 'attempt' });
    const state = session([node('root', null, { kind: 'group' }), node('edit'), work, node('downstream', 'root', { dependsOn: ['running'] })], {
      attempts: [{ id: 'attempt', nodeId: 'running', agentId: 'main', revision: 1, approvalId: 'approval',
        specification: nodeSpecification(work), status: 'running', startedAt: '', evidence: [], checks: [], provenance: 'agent_reported' }],
    });
    expect(previewImpact(state, nodeSpecification(state.nodes[1])).map(n => n.id)).toEqual(['running', 'downstream', 'edit']);
  });

  it('retains the old subtree when previewing a move and never mutates source state', () => {
    const state = session([node('root', null, { kind: 'group' }), node('left', 'root', { kind: 'group' }),
      node('right', 'root', { kind: 'group' }), node('move', 'left', { kind: 'agent' }), node('child', 'move'), node('keep', 'right')]);
    const original = structuredClone(state);
    const moved = { ...nodeSpecification(state.nodes[3]), parentId: 'right' };
    expect(new Set(previewImpact(state, moved).map(n => n.id))).toEqual(new Set(['move', 'child']));
    expect(state).toEqual(original);
  });

  it('previews a newly added Agent child and the parent result that must be adopted again', () => {
    const state = session([node('root', null, { kind: 'group' }), node('worker', 'root', { kind: 'agent' }),
      node('existing', 'worker'), node('adopt', 'root', { dependsOn: ['worker'] }), node('independent')]);
    const added = nodeSpecification(node('new-child', 'worker'));
    expect(new Set(previewImpact(state, added).map(n => n.id))).toEqual(new Set(['worker', 'existing', 'adopt', 'new-child']));
    expect(state.nodes.some(n => n.id === 'new-child')).toBe(false);
  });

  it('rejects deleting a referenced leaf without silently removing execution dependencies', () => {
    const state = session([node('root', null, { kind: 'group' }), node('work'), node('dependent', 'root', { dependsOn: ['work'] })]);
    const original = structuredClone(state);
    const result = deletionImpact(state, 'work');
    expect(result.descendants).toEqual([]);
    expect(result.references.map(n => n.id)).toEqual(['dependent']);
    expect(result.canDelete).toBe(false);
    expect(state).toEqual(original);
  });

  it('finds descendants regardless of array order', () => {
    const nodes = [node('leaf', 'branch'), node('branch', 'root', { kind: 'group' }), node('root', null, { kind: 'group' })];
    expect(subtreeIds(nodes, 'root')).toEqual(new Set(['root', 'branch', 'leaf']));
  });

  it('blocks deleting referenced subtrees, roots, and the last child of a group', () => {
    const state = session([node('root', null, { kind: 'group' }), node('group', 'root', { kind: 'group' }), node('condition', 'group', { kind: 'condition' }),
      node('dependent', 'root', { when: { nodeId: 'condition', outcome: true } }), node('free')]);
    const group = deletionImpact(state, 'group');
    expect(group.descendants.map(n => n.id)).toEqual(['condition']);
    expect(group.references.map(n => n.id)).toEqual(['dependent']);
    expect(group.canDelete).toBe(false);
    expect(deletionImpact(state, 'root').canDelete).toBe(false);
    expect(deletionImpact(state, 'condition').leavesEmptyGroup).toBe(true);
    expect(deletionImpact(state, 'condition').canDelete).toBe(false);
    expect(deletionImpact(state, 'free').canDelete).toBe(true);
  });

  it('strips execution state before saving and does not share editable arrays', () => {
    const original = node('work', 'root', { status: 'passed', attemptId: 'attempt', result: '真实结果', evidence: ['证据'], when: { nodeId: 'condition', outcome: true } });
    const spec: NodeSpec = nodeSpecification(original);
    expect(spec).not.toHaveProperty('status');
    expect(spec).not.toHaveProperty('result');
    spec.acceptance.push('新条件');
    spec.when!.outcome = false;
    expect(original.acceptance).toHaveLength(1);
    expect(original.when?.outcome).toBe(true);
  });
});
