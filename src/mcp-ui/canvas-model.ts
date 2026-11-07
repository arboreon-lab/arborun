import type { AttemptView, NodeState, Session } from '../mcp/schema';

/**
 * The canvas shows the plan from the accepting person's side:
 * - the root's children form the trunk, which always ends with the user's acceptance;
 * - a result shows its tests side by side, with the agent's work folded into one card;
 * - a container's children form a path when each depends on the previous one, otherwise branches.
 */
export type TreeView = 'tb' | 'lr';
export type ChildMode = 'seq' | 'par' | 'set';
/** Nodes are circles; layout still works on their square bounding box, so every side midpoint lies on the circle. */
export const NODE_D = 184, CARD_W = NODE_D, CARD_H = NODE_D, FRAME_HEAD = 36, FRAME_PAD = 16;
/** Room outside the circle for the agents' progress ring. */
export const RING_GAP = 7, RING_W = 4.6;
export const ACCEPT_ID = '__accept';
export const workId = (resultId: string) => `${resultId}::work`;

export interface Camera { x: number; y: number; zoom: number }
export interface Point { x: number; y: number }
export interface Line { pts: Point[]; from: string; to: string; trunk?: boolean }
export interface Rect { id: string; x: number; y: number; w: number; h: number }
export interface TreeLayout { pos: Map<string, Point>; rects: Rect[]; lines: Line[]; trunk: string[]; scope: string }
export interface Counts { total: number; passed: number; running: number; failed: number; blocked: number; skipped: number }

/** A node as drawn: real plan nodes plus the virtual work card and acceptance node. */
export interface ViewNode {
  id: string; kind: NodeState['kind'] | 'work' | 'accept'; title: string; parentId: string | null;
  node?: NodeState; children: string[]; mode: ChildMode;
}

export const isContainer = (node: Pick<NodeState, 'kind'>) => node.kind === 'group' || node.kind === 'result';

export function childMap(nodes: NodeState[]) {
  const result = new Map<string | null, NodeState[]>();
  for (const node of nodes) result.set(node.parentId, [...(result.get(node.parentId) ?? []), node]);
  return result;
}
export function subtreeIds(nodes: NodeState[], rootId: string): Set<string> {
  const children = childMap(nodes), result = new Set<string>();
  const visit = (id: string) => { if (result.has(id)) return; result.add(id); for (const child of children.get(id) ?? []) visit(child.id); };
  visit(rootId);
  return result;
}
export function activeAttempts(session: Session): AttemptView[] {
  const nodes = new Map(session.nodes.map(node => [node.id, node]));
  return session.attempts.filter(attempt => {
    const node = nodes.get(attempt.nodeId);
    return attempt.status === 'running' && !attempt.invalidated && attempt.revision === session.revision && node?.status === 'running' && node.attemptId === attempt.id;
  });
}

/** Children form a path when every child after the first depends, directly or transitively, on the previous child's subtree. */
function inferMode(session: Session, children: NodeState[]): ChildMode {
  if (children.length < 2) return 'seq';
  const byId = new Map(session.nodes.map(n => [n.id, n]));
  const reaches = (from: Set<string>, target: Set<string>) => {
    const seen = new Set<string>(), stack = [...from];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue; seen.add(id);
      const n = byId.get(id); if (!n) continue;
      for (const d of [...n.dependsOn, ...(n.when ? [n.when.nodeId] : [])]) { if (target.has(d)) return true; stack.push(d); }
    }
    return false;
  };
  for (let i = 1; i < children.length; i++) {
    if (!reaches(subtreeIds(session.nodes, children[i].id), subtreeIds(session.nodes, children[i - 1].id))) return 'par';
  }
  return 'seq';
}

export function buildView(session: Session): Map<string, ViewNode> {
  const view = new Map<string, ViewNode>(), children = childMap(session.nodes);
  const root = session.nodes.find(n => n.parentId === null);
  for (const node of session.nodes) {
    const kids = children.get(node.id) ?? [];
    let ids = kids.map(k => k.id), mode: ChildMode = node.parentId === null ? 'seq' : inferMode(session, kids);
    if (node.kind === 'result') {
      const tests = kids.filter(k => k.kind === 'test'), work = kids.filter(k => k.kind !== 'test');
      ids = tests.map(t => t.id); mode = 'set';
      if (work.length) {
        ids.push(workId(node.id));
        view.set(workId(node.id), { id: workId(node.id), kind: 'work', title: 'Agent 工作', parentId: node.id, children: work.map(w => w.id), mode: inferMode(session, work) });
      }
    }
    view.set(node.id, { id: node.id, kind: node.kind, title: node.title, parentId: node.parentId, node, children: ids, mode });
  }
  for (const node of session.nodes) {
    const parent = node.parentId ? view.get(node.parentId) : undefined;
    if (parent?.kind === 'result' && node.kind !== 'test') view.get(node.id)!.parentId = workId(parent.id);
  }
  if (root) {
    view.get(root.id)!.children.push(ACCEPT_ID);
    view.set(ACCEPT_ID, { id: ACCEPT_ID, kind: 'accept', title: '用户验收', parentId: root.id, children: [], mode: 'seq' });
  }
  return view;
}
export const isFolder = (v?: ViewNode) => Boolean(v && (v.kind === 'group' || v.kind === 'result' || v.kind === 'work') && v.children.length);

export function viewDescendants(view: Map<string, ViewNode>, id: string): string[] {
  const out: string[] = [];
  const walk = (i: string) => view.get(i)?.children.forEach(c => { out.push(c); walk(c); });
  walk(id); return out;
}

/** Each agent keeps its own colour for the whole session, in the order agents were declared or first seen. */
export const AGENT_COLORS = 6;
export function agentColor(session: Pick<Session, 'agents' | 'nodes' | 'attempts'>, agentId?: string) {
  const ids = [...new Set([...session.agents.map(a => a.id), ...session.nodes.map(n => n.agentId), ...session.attempts.map(a => a.agentId)])];
  const i = agentId ? ids.indexOf(agentId) : -1;
  return `var(--agent-${i < 0 ? AGENT_COLORS - 1 : i % AGENT_COLORS})`;
}

/** One agent's share of a node: the steps and tests it owns below (or at) the node, and how many have passed. */
export interface AgentProgress { agentId: string; total: number; done: number; running: number }
export function agentProgress(session: Session, view: Map<string, ViewNode>, id: string): AgentProgress[] {
  // Acceptance is the person's step, so it carries no agent ring.
  if (!view.has(id) || id === ACCEPT_ID) return [];
  const ids = new Set([id, ...viewDescendants(view, id)]);
  const live = new Map(activeAttempts(session).map(a => [a.nodeId, a.agentId]));
  const out = new Map<string, AgentProgress>();
  for (const n of session.nodes) {
    if (!ids.has(n.id) || isContainer(n) || n.parentId === null || n.status === 'skipped') continue;
    const agentId = live.get(n.id) ?? n.agentId;
    const p = out.get(agentId) ?? { agentId, total: 0, done: 0, running: 0 };
    p.total++;
    if (n.status === 'passed') p.done++;
    if (live.has(n.id)) p.running++;
    out.set(agentId, p);
  }
  const order = [...new Set([...session.agents.map(a => a.id), ...out.keys()])];
  return order.filter(a => out.has(a)).map(a => out.get(a)!);
}

/** Progress counts tests: that is what the person accepts. Work and plain groups fall back to steps. */
export function counts(session: Session, view: Map<string, ViewNode>, id: string): Counts {
  const ids = new Set(id === ACCEPT_ID ? session.nodes.map(n => n.id) : viewDescendants(view, id));
  let items = session.nodes.filter(n => ids.has(n.id) && n.kind === 'test');
  if (!items.length) items = session.nodes.filter(n => ids.has(n.id) && !isContainer(n));
  const c = (s: NodeState['status']) => items.filter(n => n.status === s).length;
  return { total: items.length, passed: c('passed'), running: c('running'), failed: c('failed'), blocked: c('blocked'), skipped: c('skipped') };
}

export function aggregateStatus(session: Session, view: Map<string, ViewNode>, id: string): NodeState['status'] {
  const v = view.get(id);
  if (!v) return 'draft';
  if (v.kind === 'accept') return session.status === 'accepted' ? 'passed' : session.status === 'review' ? 'ready' : 'draft';
  if (v.node && v.kind !== 'work' && !isContainer(v.node)) return v.node.status;
  const ids = new Set(viewDescendants(view, id));
  const s = session.nodes.filter(n => ids.has(n.id) && !isContainer(n)).map(n => n.status);
  if (s.includes('failed')) return 'failed';
  if (s.includes('blocked')) return 'blocked';
  if (s.includes('running')) return 'running';
  if (s.includes('stale')) return 'stale';
  if (s.length && s.every(x => x === 'passed' || x === 'skipped')) return 'passed';
  return session.status === 'draft' ? 'draft' : 'ready';
}

/**
 * The two ends of the whole task, which the start node stands for: what goes in at the first stage and what reaches
 * user acceptance after the last. The root's own fields win; otherwise the first and last stages supply them.
 */
export function taskEnds(session: Session): { input: string; output: string; stages: NodeState[] } {
  const root = session.nodes.find(n => n.parentId === null);
  const stages = root ? session.nodes.filter(n => n.parentId === root.id) : [];
  const last = stages.at(-1);
  return {
    input: root?.input || stages[0]?.input || '',
    output: root?.output || (last ? last.output || (last.kind === 'result' ? last.action : '') : '') || session.goal,
    stages,
  };
}

export function stateLabel(session: Session, view: Map<string, ViewNode>, id: string): string {
  const v = view.get(id)!, s = aggregateStatus(session, view, id), n = v.node;
  if (v.kind === 'accept') {
    if (session.status === 'accepted') return '已验收';
    if (session.status === 'review') return '待你验收';
    const c = counts(session, view, ACCEPT_ID); return `还有 ${c.total - c.passed - c.skipped} 项测试`;
  }
  if (n && n.parentId === null) return ({ draft: `v${session.revision} 待批准`, approved: `v${session.revision} 已批准`, running: `v${session.revision} 执行中`, paused: '已暂停', review: '已提交验收', accepted: '已验收' } as const)[session.status];
  const ready = (label: string) => s === 'ready' && n && !n.dependsOn.every(d => ['passed', 'skipped'].includes(session.nodes.find(x => x.id === d)?.status ?? '')) ? '等待前序' : label;
  const table: Record<string, Record<NodeState['status'], string>> = {
    result: { draft: '待批准', ready: '待开始', running: '进行中', passed: '效果已达成', failed: '有测试未通过', blocked: '需要处理', skipped: '不适用', stale: '需重新验证' },
    work: { draft: '待批准', ready: '待开始', running: '进行中', passed: '已完成', failed: '修复中', blocked: '需要处理', skipped: '不适用', stale: '需重做' },
    group: { draft: '待批准', ready: '待开始', running: '进行中', passed: '全部达成', failed: '有测试未通过', blocked: '需要处理', skipped: '不适用', stale: '需重新验证' },
    test: { draft: '待批准', ready: ready('待测试'), running: '测试中', passed: '测试通过', failed: '测试未通过', blocked: '需要处理', skipped: '不适用', stale: '需重新测试' },
    condition: { draft: '待批准', ready: ready('待判断'), running: '判断中', passed: n?.conditionOutcome === false ? '判断不成立' : '判断成立', failed: '判断失败', blocked: '需要处理', skipped: '条件未触发', stale: '需重新判断' },
    other: { draft: '待批准', ready: ready('待执行'), running: '执行中', passed: '已完成', failed: '未完成', blocked: '需要处理', skipped: '条件未触发', stale: '需重做' },
  };
  return (table[v.kind] ?? table.other)[s];
}

/** Which card stands in for a node that is folded away. */
export function visibleCard(view: Map<string, ViewNode>, pos: Map<string, Point>, id: string | undefined): string | undefined {
  while (id && !pos.has(id)) id = view.get(id)?.parentId ?? undefined;
  return id;
}

/**
 * Layout on two axes: u runs along the trunk, v along side rows.
 * 从上到下: u = y, v = x. 从左到右: u = x, v = y.
 */
export function layoutTree(view: Map<string, ViewNode>, scope: string, treeView: TreeView, expanded: ReadonlySet<string>): TreeLayout {
  const tb = treeView === 'tb', W = CARD_W, H = CARD_H;
  const su = tb ? H : W, sv = tb ? W : H;
  const GV = tb ? 44 : 34, GU = tb ? 34 : 44, TRUNK_GAP = tb ? 52 : 64, SIDE = tb ? 66 : 56;
  const HU = tb ? FRAME_HEAD : 0, HV = tb ? 0 : FRAME_HEAD;
  type UV = { u: number; v: number };
  const cards = new Map<string, UV>(), frames: { id: string; u: number; v: number; du: number; dv: number }[] = [], lines: { pts: UV[]; from: string; to: string; trunk?: boolean }[] = [];
  const elbow = (a: UV, b: UV): UV[] => Math.abs(a.u - b.u) < 1 ? [a, b] : [a, { u: a.u, v: (a.v + b.v) / 2 }, { u: b.u, v: (a.v + b.v) / 2 }, b];
  type Block = { du: number; dv: number; inP: UV; outP: UV };
  const block = (id: string, u: number, v: number): Block => {
    const node = view.get(id)!;
    if (isFolder(node) && expanded.has(id)) {
      const cu = u + HU + FRAME_PAD, cv = v + HV + FRAME_PAD;
      let du = 0, dv = 0;
      if (node.mode === 'par') {
        let pu = cu;
        for (const k of node.children) { const r = row([k], pu, cv); dv = Math.max(dv, r.dv); pu += r.du + GU; }
        du = pu - GU - cu;
      } else { const r = row(node.children, cu, cv, node.mode === 'seq'); du = r.du; dv = r.dv; }
      const f = { id, u, v, du: HU + FRAME_PAD * 2 + du, dv: HV + FRAME_PAD * 2 + dv };
      frames.push(f);
      const mid = cu + su / 2;
      return { du: f.du, dv: f.dv, inP: { u: mid, v }, outP: { u: mid, v: v + f.dv } };
    }
    cards.set(id, { u, v });
    return { du: su, dv: sv, inP: { u: u + su / 2, v }, outP: { u: u + su / 2, v: v + sv } };
  };
  const row = (ids: string[], u: number, v: number, linked = true): Block => {
    let cv = v, prev: (Block & { id: string }) | null = null, first: Block | null = null, du = 0;
    for (const id of ids) {
      const b = block(id, u, cv);
      if (prev && linked) lines.push({ pts: elbow(prev.outP, b.inP), from: prev.id, to: id });
      prev = { ...b, id }; first ??= b;
      du = Math.max(du, b.du); cv += b.dv + GV;
    }
    return { du, dv: cv - GV - v, inP: first!.inP, outP: prev!.outP };
  };
  const scopeNode = view.get(scope)!;
  const trunk = [scope, ...(scopeNode.mode === 'seq' ? scopeNode.children : [])];
  let u = 0, prevU: number | null = null;
  trunk.forEach((id, i) => {
    cards.set(id, { u, v: 0 });
    if (prevU !== null) lines.push({ pts: [{ u: prevU + su, v: sv / 2 }, { u, v: sv / 2 }], from: trunk[i - 1], to: id, trunk: true });
    let span = su;
    const node = view.get(id)!;
    const side = id === scope ? (node.mode === 'seq' ? [] : node.children) : expanded.has(id) && isFolder(node) ? node.children : [];
    if (side.length) {
      const v0 = sv + SIDE, out = { u: u + su / 2, v: sv };
      if (node.mode === 'seq' || node.mode === 'set') {
        const r = row(side, u, v0, node.mode === 'seq');
        lines.push({ pts: elbow(out, r.inP), from: id, to: side[0] });
        span = Math.max(span, r.du);
      } else {
        let pu = u;
        const bus = sv + SIDE / 2;
        for (const k of side) {
          const r = row([k], pu, v0);
          lines.push({ pts: [out, { u: out.u, v: bus }, { u: r.inP.u, v: bus }, r.inP], from: id, to: k });
          pu += r.du + GU;
        }
        span = Math.max(span, pu - GU - u);
      }
    }
    prevU = u; u += span + TRUNK_GAP;
  });
  const xy = (p: UV): Point => tb ? { x: p.v, y: p.u } : { x: p.u, y: p.v };
  const pos = new Map([...cards].map(([id, c]) => [id, xy({ u: c.u + su / 2, v: c.v + sv / 2 })]));
  const rects = frames.map(f => ({ id: f.id, ...(tb ? { x: f.v, y: f.u, w: f.dv, h: f.du } : { x: f.u, y: f.v, w: f.du, h: f.dv }) }));
  return { pos, rects, lines: lines.map(l => ({ ...l, pts: l.pts.map(xy) })), trunk, scope };
}

/** Everything starts folded: the trunk alone, ending in acceptance. Entering or expanding a node opens it. */
export function initialExpanded(_view: Map<string, ViewNode>, _scope: string): Set<string> {
  return new Set();
}

/** Dragged cards keep their own offset; lines and frames follow, task relations never change. */
export function applyOffsets(layout: TreeLayout, view: Map<string, ViewNode>, offsets: Record<string, Point>): TreeLayout {
  const moved = new Set([...layout.pos.keys()].filter(id => offsets[id]));
  if (!moved.size) return layout;
  const shift = (p: Point, id: string | null) => { const o = id ? offsets[id] : undefined; return o ? { x: p.x + o.x, y: p.y + o.y } : p; };
  const pos = new Map([...layout.pos].map(([id, p]) => [id, shift(p, id)]));
  const lines = layout.lines.map(l => {
    if (!moved.has(l.from) && !moved.has(l.to)) return l;
    const a = shift(l.pts[0], moved.has(l.from) ? l.from : null), b = shift(l.pts[l.pts.length - 1], moved.has(l.to) ? l.to : null);
    const vertical = Math.abs(l.pts[0].x - l.pts[1].x) < 1;
    return { ...l, pts: vertical ? [a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b] : [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b] };
  });
  const rects = layout.rects.map(r => {
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    for (const id of viewDescendants(view, r.id)) {
      if (!moved.has(id)) continue;
      const p = pos.get(id)!;
      x0 = Math.min(x0, p.x - CARD_W / 2 - FRAME_PAD); y0 = Math.min(y0, p.y - CARD_H / 2 - FRAME_PAD - FRAME_HEAD);
      x1 = Math.max(x1, p.x + CARD_W / 2 + FRAME_PAD); y1 = Math.max(y1, p.y + CARD_H / 2 + FRAME_PAD);
    }
    return { ...r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
  return { ...layout, pos, lines, rects };
}

export function layoutBounds(layout: TreeLayout) {
  const ps = [...layout.pos.values()];
  if (!ps.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...ps.map(p => p.x - CARD_W / 2), ...layout.rects.map(r => r.x)), x1: Math.max(...ps.map(p => p.x + CARD_W / 2), ...layout.rects.map(r => r.x + r.w)),
    y0: Math.min(...ps.map(p => p.y - CARD_H / 2), ...layout.rects.map(r => r.y)), y1: Math.max(...ps.map(p => p.y + CARD_H / 2), ...layout.rects.map(r => r.y + r.h)),
  };
}
export const ZOOM_MIN = .06, ZOOM_MAX = 8;
/** Readable start (zoom ≥ .8, beginning at the trunk) or, with `all`, the whole tree. */
export function fitCamera(layout: TreeLayout, width: number, height: number, all = false): Camera {
  const b = layoutBounds(layout), pad = 28, w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
  const zoom = Math.max(all ? ZOOM_MIN : .8, Math.min(1, (width - pad * 2) / w, (height - pad * 2) / h));
  const camera = { zoom, x: width / 2 - (b.x0 + b.x1) / 2 * zoom, y: height / 2 - (b.y0 + b.y1) / 2 * zoom };
  if (w * zoom > width - pad * 2) camera.x = pad - b.x0 * zoom;
  if (h * zoom > height - pad * 2) camera.y = pad - b.y0 * zoom;
  return camera;
}
/** Zoom about a screen point, unbounded in practice. */
export function zoomCamera(camera: Camera, zoom: number, px: number, py: number): Camera {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)), k = z / camera.zoom;
  return { zoom: z, x: px - (px - camera.x) * k, y: py - (py - camera.y) * k };
}
