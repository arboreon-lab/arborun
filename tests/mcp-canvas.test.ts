import { describe, expect, test } from 'vitest';
import type { AttemptView, NodeState, Session } from '../src/mcp/schema';
import {
  ACCEPT_ID, activeAttempts, agentColor, agentProgress, taskEnds, applyOffsets, buildView, counts, fitCamera, initialExpanded, layoutTree, stateLabel, visibleCard, workId, zoomCamera, ZOOM_MAX, ZOOM_MIN, type TreeView,
} from '../src/mcp-ui/canvas-model';

const node = (id: string, parentId: string | null, kind: NodeState['kind'] = 'action', overrides: Partial<NodeState> = {}): NodeState => ({
  id, parentId, kind, title: id, action: `执行 ${id}`, target: '测试文件', input: '测试输入', acceptance: ['检查通过'], failure: '停止并报告问题', dependsOn: [], agentId: 'main', status: 'draft', ...overrides,
});
const session = (nodes: NodeState[], attempts: AttemptView[] = [], status: Session['status'] = 'running'): Session => ({
  id: 'test-session', title: '测试树', goal: '测试目标', context: [], revision: 2, status, nodes, agents: [{ id: 'main', name: '主 Agent', role: '执行', scope: '测试目录', budget: '10 步' }],
  attempts, events: [], aiRequests: [], history: [], createdAt: '', updatedAt: '',
});
const attempt = (id: string, nodeId: string, overrides: Partial<AttemptView> = {}): AttemptView => ({
  id, nodeId, agentId: 'main', revision: 2, approvalId: 'approval', specification: node(nodeId, 'root'), status: 'running', startedAt: '', evidence: [], checks: [], provenance: 'agent_reported', ...overrides,
});
// Trunk: samples (path) → effects (two results) → user acceptance.
const plan = () => [
  node('root', null, 'group'),
  node('samples', 'root', 'group'), node('s1', 'samples'), node('s2', 'samples', 'action', { dependsOn: ['s1'] }),
  node('effects', 'root', 'group'),
  node('r1', 'effects', 'result'), node('t1', 'r1', 'test', { by: 'user', dependsOn: ['w1'] }), node('t2', 'r1', 'test', { by: 'agent', dependsOn: ['w1'] }), node('w1', 'r1'),
  node('r2', 'effects', 'result'), node('t3', 'r2', 'test', { by: 'user' }),
];

describe('the tree as the accepting person sees it', () => {
  test('the trunk is the root path and always ends with user acceptance', () => {
    const view = buildView(session(plan()));
    expect(view.get('root')!.children).toEqual(['samples', 'effects', ACCEPT_ID]);
    expect(view.get('root')!.mode).toBe('seq');
  });
  test('a container is a path when each child follows the previous one, otherwise branches', () => {
    const view = buildView(session(plan()));
    expect(view.get('samples')!.mode).toBe('seq');
    expect(view.get('effects')!.mode).toBe('par');
  });
  test('a result shows its tests side by side and folds agent work into one card', () => {
    const view = buildView(session(plan()));
    expect(view.get('r1')!.children).toEqual(['t1', 't2', workId('r1')]);
    expect(view.get('r1')!.mode).toBe('set');
    expect(view.get(workId('r1'))!.children).toEqual(['w1']);
    expect(view.get('w1')!.parentId).toBe(workId('r1'));
    expect(initialExpanded(view, 'root').size).toBe(0);
  });
  test('progress counts tests, not agent steps; acceptance counts every test', () => {
    const nodes = plan();
    nodes.find(n => n.id === 't1')!.status = 'passed'; nodes.find(n => n.id === 'w1')!.status = 'passed';
    const state = session(nodes), view = buildView(state);
    expect(counts(state, view, 'r1')).toMatchObject({ total: 2, passed: 1 });
    expect(counts(state, view, ACCEPT_ID)).toMatchObject({ total: 3, passed: 1 });
    expect(counts(state, view, workId('r1'))).toMatchObject({ total: 1, passed: 1 });
    expect(stateLabel(state, view, ACCEPT_ID)).toBe('还有 2 项测试');
  });
  test('a failed test marks its result; agent work under repair reads as fixing, not as a problem for the person', () => {
    const nodes = plan();
    nodes.find(n => n.id === 't1')!.status = 'failed'; nodes.find(n => n.id === 'w1')!.status = 'failed';
    const state = session(nodes), view = buildView(state);
    expect(stateLabel(state, view, 'r1')).toBe('有测试未通过');
    expect(stateLabel(state, view, workId('r1'))).toBe('修复中');
    expect(stateLabel(state, view, 't1')).toBe('测试未通过');
  });
  test('live positions come only from the current, valid attempt', () => {
    const nodes = plan(); nodes.find(n => n.id === 'w1')!.status = 'running'; nodes.find(n => n.id === 'w1')!.attemptId = 'live';
    const state = session(nodes, [attempt('live', 'w1'), attempt('old', 'w1', { revision: 1 }), attempt('invalid', 'w1', { invalidated: true })]);
    expect(activeAttempts(state).map(a => a.id)).toEqual(['live']);
  });
});

describe('view-only geometry', () => {
  test.each<TreeView>(['tb', 'lr'])('%s: the trunk runs along one axis and acceptance is last', view => {
    const tree = buildView(session(plan())), layout = layoutTree(tree, 'root', view, initialExpanded(tree, 'root'));
    const axis = view === 'tb' ? 'y' : 'x';
    const trunk = layout.trunk.map(id => layout.pos.get(id)!);
    expect(layout.trunk.at(-1)).toBe(ACCEPT_ID);
    trunk.slice(1).forEach((p, i) => expect(p[axis]).toBeGreaterThan(trunk[i][axis]));
    expect(layout.rects).toEqual([]); // folded by default: the trunk alone
    const open = layoutTree(tree, 'root', view, new Set(['samples', 'effects', 'r1', 'r2']));
    expect(open.rects.map(r => r.id).sort()).toEqual(['r1', 'r2']); // trunk nodes stay cards; their contents sit beside them
  });
  test('execution state never moves cards', () => {
    const nodes = plan(), before = layoutTree(buildView(session(nodes)), 'root', 'tb', new Set(['effects', 'r1']));
    nodes.forEach(n => { n.status = 'passed'; });
    const after = layoutTree(buildView(session(nodes)), 'root', 'tb', new Set(['effects', 'r1']));
    expect([...after.pos]).toEqual([...before.pos]);
  });
  test('a folded node stands in for what it contains', () => {
    const tree = buildView(session(plan())), layout = layoutTree(tree, 'root', 'tb', new Set(['effects', 'r1']));
    expect(layout.pos.has(workId('r1'))).toBe(true);
    expect(visibleCard(tree, layout.pos, 'w1')).toBe(workId('r1'));
    expect(visibleCard(tree, layout.pos, 't3')).toBe('r2');
  });
  test('a dragged card moves alone; its lines follow and its frame grows to hold it', () => {
    const tree = buildView(session(plan())), layout = layoutTree(tree, 'root', 'tb', new Set(['effects', 'r1']));
    const moved = applyOffsets(layout, tree, { t1: { x: -400, y: 300 } });
    expect(moved.pos.get('t1')).toEqual({ x: layout.pos.get('t1')!.x - 400, y: layout.pos.get('t1')!.y + 300 });
    expect(moved.pos.get('t2')).toEqual(layout.pos.get('t2'));
    const r1 = moved.rects.find(r => r.id === 'r1')!, old = layout.rects.find(r => r.id === 'r1')!;
    expect(r1.x).toBeLessThan(old.x); expect(r1.y + r1.h).toBeGreaterThan(old.y + old.h);
  });
  test('zoom is effectively unbounded and fit-all shows everything', () => {
    expect(zoomCamera({ x: 0, y: 0, zoom: 1 }, 100, 0, 0).zoom).toBe(ZOOM_MAX);
    expect(zoomCamera({ x: 0, y: 0, zoom: 1 }, 0.0001, 0, 0).zoom).toBe(ZOOM_MIN);
    const tree = buildView(session(plan())), layout = layoutTree(tree, 'root', 'tb', initialExpanded(tree, 'root'));
    expect(fitCamera(layout, 400, 300, true).zoom).toBeLessThan(.8);
    expect(fitCamera(layout, 400, 300).zoom).toBeGreaterThanOrEqual(.8);
  });

  test('each agent owns its share of a node and inks it as its steps and tests pass', () => {
    const nodes = plan().map(n => ({ ...n, ...(n.id === 'w1' ? { agentId: 'export', status: 'passed' as const } : {}), ...(n.id === 't2' ? { agentId: 'compat', status: 'running' as const, attemptId: 'a-t2' } : {}), ...(n.id === 't1' ? { agentId: 'compat', status: 'passed' as const } : {}) }));
    const s = session(nodes, [attempt('a-t2', 't2', { agentId: 'compat' })]);
    const view = buildView(s);
    expect(agentProgress(s, view, 'r1')).toEqual([{ agentId: 'compat', total: 2, done: 1, running: 1 }, { agentId: 'export', total: 1, done: 1, running: 0 }]);
    expect(agentProgress(s, view, 't2')).toEqual([{ agentId: 'compat', total: 1, done: 0, running: 1 }]);
    expect(agentProgress(s, view, ACCEPT_ID)).toEqual([]);
    // Colours follow the order agents appear in, so the same agent keeps one colour everywhere.
    expect(agentColor(s, 'main')).toBe('var(--agent-0)');
    expect(agentColor(s, 'compat')).toBe('var(--agent-1)');
    expect(agentColor(s, 'export')).toBe('var(--agent-2)');
  });

  test('the start node spans the whole path: input from the first stage, output from the last unless the root says otherwise', () => {
    const nodes = plan().map(n => n.id === 'root' ? { ...n, input: '' } : n.id === 'samples' ? { ...n, input: '原始数据' } : n.id === 'effects' ? { ...n, output: '三项效果都达成' } : n);
    const s = session(nodes);
    expect(taskEnds(s)).toMatchObject({ input: '原始数据', output: '三项效果都达成' });
    expect(taskEnds(s).stages.map(n => n.id)).toEqual(['samples', 'effects']);
    const own = session(nodes.map(n => n.id === 'root' ? { ...n, input: '整个任务的起点', output: '整个任务的交付' } : n));
    expect(taskEnds(own)).toMatchObject({ input: '整个任务的起点', output: '整个任务的交付' });
    expect(taskEnds(session([node('root', null, 'group')])).output).toBe('测试目标');
  });
});
