import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../mcp/schema';
import {
  ACCEPT_ID, CARD_H, CARD_W, FRAME_HEAD, activeAttempts, aggregateStatus, applyOffsets, buildView, counts, fitCamera, initialExpanded,
  isFolder, layoutTree, stateLabel, viewDescendants, visibleCard, zoomCamera, type Camera, type Counts, type Point, type TreeView, type ViewNode,
} from './canvas-model';
import { collaborationMessages, currentWork } from './collaboration-model';
import { bez, cardMarkup, edgeMarkup, frameMarkup, glyphMarkup, messageCurve, messageMarkup, type CardLook } from './sketch';
import './canvas.css';

export interface TreeCanvasProps {
  session: Session;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Called when the scope changes; the panel closes unless a step was entered. */
  onEnter?: (id: string) => void;
  editing?: boolean;
  /** Nodes a pending edit would invalidate, drawn dashed. */
  impact?: ReadonlySet<string>;
  locateRequest?: { id: string; key: number };
  /** Restore dragged cards: one card when `id` is given, otherwise every card in the current scope and view. */
  resetRequest?: { id?: string; key: number };
  panelOpen?: boolean;
  /** Fold the tree into the overview (replaces folding subtrees when provided). */
  onOverview?: () => void;
}

const agentVar = (id?: string) => `var(--agent-${['main', 'export', 'compat'].includes(id ?? '') ? id : 'other'})`;
const ICON = {
  tb: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 3v18M6 7h5M6 15h5M11 7h7M11 15h7M14 15v4h4" /></svg>,
  lr: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M7 6v5M15 6v5M7 11v7M15 11v7M15 14h4v4" /></svg>,
  fold: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 4 5 5 5-5M7 20l5-5 5 5" /></svg>,
  unfold: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 9 5-5 5 5M7 15l5 5 5-5" /></svg>,
};
const loadOffsets = (): Record<string, Point> => { try { return JSON.parse(localStorage.getItem('arborun-card-offsets') || '{}') || {}; } catch { return {}; } };
const saveOffsets = (value: Record<string, Point>) => { try { localStorage.setItem('arborun-card-offsets', JSON.stringify(value)); } catch { /* per-viewer convenience only */ } };

export function MiniBar({ c, wide = false }: { c: Counts; wide?: boolean }) {
  const rest = c.total - c.passed - c.running - c.failed - c.blocked - c.skipped;
  const seg = (cls: string, n: number) => n ? <i className={cls} style={{ flex: n }} /> : null;
  return <span className={wide ? 'bar' : 'mini-bar'} aria-hidden="true">{seg('s-pass', c.passed)}{seg('s-skip', c.skipped)}{seg('s-fail', c.failed)}{seg('s-wait', c.blocked)}{seg('s-run', c.running)}{rest ? <i style={{ flex: rest }} /> : null}</span>;
}
export function Glyph({ session, view, id, size = 16 }: { session: Session; view: Map<string, ViewNode>; id: string; size?: number }) {
  const v = view.get(id); if (!v) return null;
  const status = aggregateStatus(session, view, id);
  const kind = v.node?.parentId === null ? 'start' : v.kind === 'accept' ? 'accept' : v.kind === 'result' ? 'result' : 'other';
  const running = activeAttempts(session).find(a => a.nodeId === id || viewDescendants(view, id).includes(a.nodeId));
  const html = glyphMarkup(id, kind, status, { agentColor: agentVar(running?.agentId), ready: session.status === 'review', accepted: session.status === 'accepted', approved: session.status !== 'draft' });
  return <svg className="glyph" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}
export function Avatar({ session, agentId }: { session: Session; agentId: string }) {
  const name = session.agents.find(a => a.id === agentId)?.name ?? agentId;
  return <span className="avatar" style={{ '--agent': agentVar(agentId) } as React.CSSProperties} title={name}>{name.slice(0, 1)}</span>;
}

export function TreeCanvas({ session, selectedId, onSelect, onEnter, editing = false, impact, locateRequest, resetRequest, panelOpen, onOverview }: TreeCanvasProps) {
  const view = useMemo(() => buildView(session), [session]);
  const root = session.nodes.find(n => n.parentId === null)?.id ?? '';
  const [scope, setScope] = useState(root);
  const [treeView, setTreeView] = useState<TreeView>('tb');
  const [expanded, setExpanded] = useState(() => initialExpanded(view, root));
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [offsets, setOffsets] = useState(loadOffsets);
  const [dragging, setDragging] = useState<string | null>(null);
  const [animate, setAnimate] = useState(false);
  const [notice, setNotice] = useState('');
  const [lod, setLod] = useState<'near' | 'far'>('near');
  const canvasRef = useRef<HTMLDivElement>(null), worldRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const size = useRef({ w: 0, h: 0 }), needsFit = useRef<'start' | 'all' | false>('start');
  const history = useRef(new Map<string, { view: TreeView; camera: Camera; expanded: Set<string> }>());
  const lastClick = useRef<{ id: string; t: number } | null>(null), suppressClick = useRef(false);
  const offsetKey = (id: string) => `${session.id}|${scope}|${treeView}|${id}`;
  const scopedOffsets = useMemo(() => Object.fromEntries(Object.entries(offsets).filter(([k]) => k.startsWith(`${session.id}|${scope}|${treeView}|`)).map(([k, v]) => [k.split('|').slice(3).join('|'), v])), [offsets, session.id, scope, treeView]);
  const layout = useMemo(() => view.has(scope) ? applyOffsets(layoutTree(view, scope, treeView, expanded), view, scopedOffsets) : null, [view, scope, treeView, expanded, scopedOffsets]);
  const running = activeAttempts(session), work = currentWork(session);
  const blocked = () => { if (!editing) return false; setNotice('请先保存或取消正在编辑的内容。'); return true; };

  // Scope follows structural changes (a deleted subtree returns to its nearest surviving ancestor).
  useEffect(() => { if (!view.has(scope)) { setScope(root); needsFit.current = 'start'; } }, [view, scope, root]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 3200); return () => clearTimeout(t); }, [notice]);

  const viewport = () => ({ w: size.current.w, h: size.current.h });
  useLayoutEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      size.current = { w: entry.contentRect.width, h: entry.contentRect.height };
      setViewportSize(size.current);
    });
    observer.observe(el); size.current = { w: el.clientWidth, h: el.clientHeight }; setViewportSize(size.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!layout || !needsFit.current || !size.current.w) return;
    setCamera(fitCamera(layout, size.current.w, size.current.h, needsFit.current === 'all'));
    needsFit.current = false;
  }, [layout, viewportSize]);
  // Far zoom shows titles only; switch after a zoom animation so cards do not flash large titles.
  useEffect(() => {
    const next = camera.zoom < .5 ? 'far' : 'near';
    if (!animate) { setLod(next); return; }
    const t = setTimeout(() => setLod(next), 340); return () => clearTimeout(t);
  }, [camera.zoom, animate]);

  const ensureVisible = (id: string) => {
    const p = layout?.pos.get(id); if (!p) return;
    const { w, h } = viewport(), m = 32;
    setCamera(c => {
      const sx = c.x + p.x * c.zoom, sy = c.y + p.y * c.zoom, hw = CARD_W / 2 * c.zoom, hh = CARD_H / 2 * c.zoom;
      let dx = 0, dy = 0;
      if (sx - hw < m) dx = m - (sx - hw); else if (sx + hw > w - m) dx = (w - m) - (sx + hw);
      if (sy - hh < m) dy = m - (sy - hh); else if (sy + hh > h - m) dy = (h - m) - (sy + hh);
      return dx || dy ? { ...c, x: c.x + dx, y: c.y + dy } : c;
    });
  };
  useEffect(() => { if (selectedId) { setAnimate(true); requestAnimationFrame(() => ensureVisible(selectedId)); } }, [selectedId, panelOpen]);

  const enter = (id: string, restore = false) => {
    if (blocked() || id === scope || !view.has(id) || id === ACCEPT_ID) return;
    history.current.set(scope, { view: treeView, camera, expanded: new Set(expanded) });
    const saved = restore ? history.current.get(id) : undefined;
    setScope(id);
    if (saved) { setTreeView(saved.view); setExpanded(new Set(saved.expanded)); setCamera(saved.camera); }
    else { setExpanded(initialExpanded(view, id)); needsFit.current = 'start'; }
    setAnimate(true); onEnter?.(id);
  };
  // Reveal a node anywhere: leave the subtree if needed, open its ancestors, select it.
  useEffect(() => {
    if (!locateRequest || editing) return;
    const id = locateRequest.id; if (!view.has(id)) return;
    const inScope = id === scope || viewDescendants(view, scope).includes(id);
    if (!inScope) { history.current.set(scope, { view: treeView, camera, expanded: new Set(expanded) }); setScope(root); needsFit.current = 'start'; }
    setExpanded(current => { const next = new Set(current); for (let p = view.get(id)?.parentId; p && p !== (inScope ? scope : root); p = view.get(p)?.parentId) next.add(p); return next; });
    requestAnimationFrame(() => ensureVisible(id));
  }, [locateRequest?.key]);

  const toggle = (id: string) => {
    const before = layout?.pos.get(id) ?? (() => { const r = layout?.rects.find(r => r.id === id); return r && { x: r.x + CARD_W / 2, y: r.y + CARD_H / 2 }; })();
    setExpanded(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    if (before) anchor.current = { id, x: camera.x + before.x * camera.zoom, y: camera.y + before.y * camera.zoom };
  };
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current; if (!a || !layout) return; anchor.current = null;
    const after = layout.pos.get(a.id) ?? (() => { const r = layout.rects.find(r => r.id === a.id); return r && { x: r.x + CARD_W / 2, y: r.y + CARD_H / 2 }; })();
    if (after) { setAnimate(false); setCamera(c => ({ ...c, x: a.x - after.x * c.zoom, y: a.y - after.y * c.zoom })); }
  }, [layout]);
  const groupsInScope = viewDescendants(view, scope).filter(id => isFolder(view.get(id)));
  const anyOpen = groupsInScope.some(id => expanded.has(id));
  const foldAll = () => {
    setExpanded(anyOpen ? new Set() : new Set(groupsInScope.filter(id => view.get(id)!.kind !== 'work')));
    needsFit.current = 'start'; setAnimate(true);
  };
  const switchView = () => { if (blocked()) return; setTreeView(v => v === 'tb' ? 'lr' : 'tb'); needsFit.current = 'start'; setAnimate(false); };

  // Running cards redraw their outline every half second: the line "boils", as hand-drawn animation does.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const timer = setInterval(() => {
      frame = (frame + 1) % 3;
      worldRef.current?.querySelectorAll<HTMLElement>('.node[data-live="true"]').forEach(el => {
        const svg = el.querySelector('.sketch'); const look = el.dataset.look;
        if (svg && look) svg.innerHTML = cardMarkup(el.dataset.id!, JSON.parse(look) as CardLook, frame);
      });
    }, 520);
    return () => clearInterval(timer);
  }, []);

  // Hovering a node traces the path that leads to it from the start of the trunk.
  const trace = (id: string | null) => {
    const world = worldRef.current; if (!world) return;
    world.querySelectorAll('.traced').forEach(el => el.classList.remove('traced'));
    world.classList.toggle('tracing', Boolean(id) && !dragging);
    if (!id) return;
    const chain = new Set<string>();
    for (let cur: string | null | undefined = id; cur; cur = view.get(cur)?.parentId) {
      chain.add(cur);
      const parent = view.get(cur)?.parentId; if (!parent) break;
      const p = view.get(parent)!;
      if (p.mode === 'seq') p.children.slice(0, p.children.indexOf(cur)).forEach(x => chain.add(x));
      if (parent === scope) { chain.add(parent); break; }
    }
    world.querySelectorAll<HTMLElement>('[data-from]').forEach(g => { if (chain.has(g.dataset.from!) && chain.has(g.dataset.to!)) g.classList.add('traced'); });
    world.querySelectorAll<HTMLElement>('.node').forEach(el => { if (chain.has(el.dataset.id!)) el.classList.add('traced'); });
  };

  // Pointer: drag a card (captured only after it really moves, so clicks still reach it) or pan the canvas.
  const gesture = useRef<{ kind: 'pan' | 'card'; id?: string; x: number; y: number; start: Camera; base: Point; moved: boolean; pointerId: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('.node');
    if (card && !(event.target as HTMLElement).closest('button')) {
      const id = card.dataset.id!;
      gesture.current = { kind: 'card', id, x: event.clientX, y: event.clientY, start: camera, base: offsets[offsetKey(id)] ?? { x: 0, y: 0 }, moved: false, pointerId: event.pointerId };
      return;
    }
    if ((event.target as HTMLElement).closest('.msg-chip,.region-head,button')) return;
    gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, start: camera, base: { x: 0, y: 0 }, moved: false, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current; if (!g) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    if (!g.moved) { g.moved = true; event.currentTarget.setPointerCapture(g.pointerId); if (g.kind === 'card') { setDragging(g.id!); trace(null); } }
    setAnimate(false);
    if (g.kind === 'pan') setCamera({ ...g.start, x: g.start.x + dx, y: g.start.y + dy });
    else setOffsets(o => ({ ...o, [offsetKey(g.id!)]: { x: g.base.x + dx / camera.zoom, y: g.base.y + dy / camera.zoom } }));
  };
  const onPointerUp = () => {
    const g = gesture.current; gesture.current = null;
    if (!g) return;
    if (g.kind === 'card' && g.moved) { setDragging(null); suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
    if (g.kind === 'pan' && !g.moved && !editing) onSelect(null);
  };
  useEffect(() => { if (!dragging) saveOffsets(offsets); }, [offsets, dragging]);
  useEffect(() => {
    if (!resetRequest) return;
    const prefix = `${session.id}|${scope}|${treeView}|`;
    setAnimate(true);
    setOffsets(o => Object.fromEntries(Object.entries(o).filter(([k]) => resetRequest.id ? k !== prefix + resetRequest.id : !k.startsWith(prefix))));
  }, [resetRequest?.key]);
  const onClick = (event: React.MouseEvent) => {
    if (suppressClick.current) return;
    const target = event.target as HTMLElement;
    const toggleButton = target.closest<HTMLElement>('[data-toggle]');
    if (toggleButton) { toggle(toggleButton.dataset.toggle!); return; }
    const chip = target.closest<HTMLElement>('[data-msg-to]');
    if (chip) { if (!blocked()) onSelect(chip.dataset.msgTo!); return; }
    const hit = target.closest<HTMLElement>('.node,[data-select]'), id = hit?.dataset.id ?? hit?.dataset.select;
    if (!id || blocked()) return;
    // Selecting re-renders (and may move) cards, so the dblclick event is unreliable. The browser's click count is not:
    // the second click enters the card the first click selected. Clicks without a count (keyboard, scripts) fall back to timing.
    const now = performance.now();
    if (event.detail >= 2 || (event.detail === 0 && lastClick.current?.id === id && now - lastClick.current.t < 420)) {
      const target = event.detail >= 2 && lastClick.current ? lastClick.current.id : id;
      lastClick.current = null;
      if (event.detail <= 2) enter(target);
      return;
    }
    lastClick.current = { id, t: now };
    onSelect(id);
  };
  const onDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('.node,.region,.msg-chip')) return;
    if (layout) { setAnimate(true); setCamera(fitCamera(layout, size.current.w, size.current.h, true)); }
  };
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = event => {
    event.preventDefault();
    const mouseWheel = event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
    setAnimate(false);
    if (event.ctrlKey || event.metaKey || mouseWheel) {
      const r = canvasRef.current!.getBoundingClientRect();
      setCamera(c => zoomCamera(c, c.zoom * Math.exp(-event.deltaY * (event.ctrlKey ? .012 : .0018)), event.clientX - r.left, event.clientY - r.top));
    } else setCamera(c => ({ ...c, x: c.x - event.deltaX, y: c.y - event.deltaY }));
  };
  useEffect(() => { const el = canvasRef.current, h = (e: WheelEvent) => wheel.current(e); el?.addEventListener('wheel', h, { passive: false }); return () => el?.removeEventListener('wheel', h); }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input,textarea,select')) return;
    const { w, h } = viewport();
    if (event.key === '+' || event.key === '=') { setAnimate(true); setCamera(c => zoomCamera(c, c.zoom * 1.25, w / 2, h / 2)); }
    else if (event.key === '-') { setAnimate(true); setCamera(c => zoomCamera(c, c.zoom / 1.25, w / 2, h / 2)); }
    else if (event.key === '0' && layout) { setAnimate(true); setCamera(fitCamera(layout, w, h, true)); }
    else if (event.key === 'Enter' && (event.altKey || event.shiftKey) && selectedId) { event.preventDefault(); enter(selectedId); }
    else if (event.key.startsWith('Arrow') && layout) {
      event.preventDefault();
      const cur = selectedId ? layout.pos.get(selectedId) : undefined;
      if (!cur) { onSelect(scope); return; }
      const dir = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, number[]>)[event.key];
      let best: string | null = null, score = Infinity;
      for (const [id, p] of layout.pos) {
        if (id === selectedId) continue;
        const dx = p.x - cur.x, dy = p.y - cur.y, along = dx * dir[0] + dy * dir[1], across = Math.abs(dx * dir[1] - dy * dir[0]);
        if (along > 4 && along + across * 2 < score) { score = along + across * 2; best = id; }
      }
      if (best && !blocked()) onSelect(best);
    }
  };

  if (!layout) return null;
  const path: ViewNode[] = [];
  for (let a: ViewNode | undefined = view.get(scope); a; a = a.parentId ? view.get(a.parentId) : undefined) path.unshift(a);
  const grid = (() => { let g = 22 * camera.zoom; while (g < 14) g *= 2; while (g > 44) g /= 2; return g; })();

  // Edges, then message arcs; labels avoid cards and frame headers.
  let edges = '';
  for (const l of layout.lines) {
    const hl = selectedId && (l.from === selectedId || l.to === selectedId);
    const quiet = view.get(l.to)?.kind === 'work' || view.get(l.to)?.node?.kind === 'action';
    const color = hl ? 'var(--ink)' : l.trunk ? 'var(--ink-2)' : quiet ? 'var(--faint)' : 'var(--line-strong)';
    edges += `<g class="edge" data-from="${l.from}" data-to="${l.to}">${edgeMarkup(l.pts, `${l.from}>${l.to}`, color, hl ? 1.9 : l.trunk ? 1.6 : 1.3, Boolean(quiet && !hl))}</g>`;
  }
  const boxes = [...[...layout.pos.values()].map(p => [p.x - CARD_W / 2 - 6, p.y - CARD_H / 2 - 6, p.x + CARD_W / 2 + 6, p.y + CARD_H / 2 + 6]), ...layout.rects.map(r => [r.x, r.y - 4, r.x + Math.min(r.w, 320), r.y + FRAME_HEAD])];
  const hits = (b: number[]) => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const agentName = (id?: string) => session.agents.find(a => a.id === id)?.name ?? id ?? '';
  const chips: React.ReactNode[] = [];
  collaborationMessages(session).slice(-4).forEach(({ sent, received }, i) => {
    const target = sent.toNodeId ?? received?.nodeId ?? work.find(w => w.attempt.agentId === sent.toAgentId)?.attempt.nodeId;
    const a = visibleCard(view, layout.pos, sent.nodeId), b = visibleCard(view, layout.pos, target);
    if (!a || !b || a === b) return;
    const d = messageCurve(layout.pos.get(a)!, layout.pos.get(b)!, i), color = agentVar(sent.agentId);
    edges += `<g class="msg" data-from="${a}" data-to="${b}">${messageMarkup(d, sent.id, color, Boolean(received))}</g>`;
    const cw = Math.min(250, 76 + sent.summary.length * 12.5), ch = 28;
    let spot: Point | null = null;
    for (const t of [.5, .4, .6, .3, .7, .2, .8]) {
      const q = bez(d, t);
      for (const [ox, oy] of [[0, 0], [cw / 2 + 8, 0], [-cw / 2 - 8, 0], [0, -ch], [0, ch], [0, -ch * 2], [0, ch * 2], [cw / 2 + 60, 0], [-cw / 2 - 60, 0]]) {
        const box = [q.x + ox - cw / 2, q.y + oy - ch / 2, q.x + ox + cw / 2, q.y + oy + ch / 2];
        if (!hits(box)) { spot = { x: q.x + ox, y: q.y + oy }; boxes.push(box); break; }
      }
      if (spot) break;
    }
    const label = `${agentName(sent.agentId)} → ${agentName(sent.toAgentId)} · ${received ? '已接收' : '已发送'}：${sent.summary}`;
    const at = spot ?? bez(d, .5 + (i % 2 ? .12 : -.12));
    chips.push(<button key={sent.id} type="button" className={`msg-chip${spot ? '' : ' compact'}`} data-msg-to={b} data-message-id={sent.messageId} data-delivery={received ? 'received' : 'sent'}
      style={{ '--agent': color, left: at.x, top: at.y, maxWidth: spot ? cw : undefined } as React.CSSProperties} title={label} aria-label={label}>
      <Avatar session={session} agentId={sent.agentId} />{spot ? <><span className="summary">{sent.summary}</span><span className="status">{received ? '已接收' : '已发送'}</span></> : <span className="status">{received ? '✓' : '→'}</span>}
    </button>);
  });

  const card = (id: string, p: Point) => {
    const v = view.get(id)!, n = v.node, status = impact?.has(id) ? 'stale' : aggregateStatus(session, view, id);
    const isRoot = n?.parentId === null, quiet = v.kind === 'work' || n?.kind === 'action';
    const attempt = running.find(a => a.nodeId === id);
    // The card shows what the agent is doing; messages are drawn as arcs instead.
    const act = attempt && [...(session.activities ?? [])].reverse().find(x => x.attemptId === attempt.id && x.kind === 'action' && x.revision === session.revision);
    const folded = isFolder(v) && !expanded.has(id) && id !== scope && !(layout.trunk.includes(id) && expanded.has(id));
    const selected = selectedId === id;
    const look: CardLook = {
      color: selected ? 'var(--ink)' : isRoot || v.kind === 'accept' ? 'var(--ink-2)' : attempt ? agentVar(attempt.agentId) : status === 'failed' && !quiet ? 'var(--fail)'
        : status === 'blocked' || status === 'stale' ? 'var(--wait)' : v.kind === 'result' ? 'var(--ink-2)' : quiet ? 'var(--faint)' : 'var(--line-strong)',
      width: selected ? 1.9 : v.kind === 'result' ? 1.7 : quiet ? 1.1 : 1.4,
      dashed: (quiet && !attempt && !selected) || status === 'stale', stacked: folded,
      hatch: !quiet && !isFolder(v) && !isRoot && status === 'failed', selected, live: Boolean(attempt),
    };
    const c = counts(session, view, v.kind === 'accept' ? ACCEPT_ID : id);
    const text = isRoot ? session.goal : v.kind === 'accept' ? '逐项查看每个效果的测试与证据；全部通过后验收。' : v.kind === 'work' ? `${v.children.length} 步` : n?.action ?? '';
    const agents = [...new Set(running.filter(a => a.nodeId === id || viewDescendants(view, id).includes(a.nodeId)).map(a => a.agentId))];
    let foot: React.ReactNode;
    if (isFolder(v) || isRoot || v.kind === 'accept') foot = <><MiniBar c={c} /><span>{c.passed + c.skipped} / {c.total}</span>{agents.map(a => <Avatar key={a} session={session} agentId={a} />)}</>;
    else if (attempt) foot = <span className="agent"><Avatar session={session} agentId={attempt.agentId} /><span className="doing">{act?.summary ?? `${agentName(attempt.agentId)} 已领取`}</span></span>;
    else if (n?.kind === 'test') foot = <><span className={`by ${n.by ?? 'agent'}`}>{n.by === 'user' ? '你设定' : 'Agent 补充'}</span>{!!n.evidence?.length && <span className="has-evidence" title="有证据">◫</span>}</>;
    else if (n) foot = <span className="agent"><Avatar session={session} agentId={n.agentId} /><span className="name">{agentName(n.agentId)}</span></span>;
    const label = stateLabel(session, view, id);
    return <div key={id} className={['node', folded && 'group collapsed', isRoot && 'start', v.kind === 'accept' && 'end', quiet && 'work', dragging === id && 'dragging', impact?.has(id) && 'impacted'].filter(Boolean).join(' ')}
      role="treeitem" tabIndex={-1} data-id={id} data-node={id} data-node-id={id} data-kind={v.kind} data-state={status} data-status={status} data-running={Boolean(attempt)} data-live={Boolean(attempt)} data-look={JSON.stringify(look)}
      aria-selected={selected} aria-label={`${v.title}，${label}`} data-selected={selected}
      style={{ left: p.x - CARD_W / 2, top: p.y - CARD_H / 2, ...(attempt ? { '--agent': agentVar(attempt.agentId) } : {}) } as React.CSSProperties}>
      <svg className="sketch" viewBox={`0 0 ${CARD_W + 12} ${CARD_H + 12}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: cardMarkup(id, look) }} />
      <div className="head"><Glyph session={session} view={view} id={id} /><span className="title">{v.title}</span></div>
      <div className="text">{text}</div>
      <div className="foot">{foot}<span className="state">{label}</span></div>
      {isFolder(v) && id !== scope && <button type="button" className="expand" data-toggle={id} aria-expanded={expanded.has(id)} aria-label={`${expanded.has(id) ? '收起' : '展开'}：${v.title}`}>{expanded.has(id) ? '−' : `+${v.children.length}`}</button>}
    </div>;
  };

  return <section className="arborun-canvas-shell" data-view={treeView} data-scope={scope} aria-label="决策执行树">
    <header className="topbar">
      <nav className="crumbs" aria-label="当前子树路径">{path.map((n, i) => <React.Fragment key={n.id}>{i > 0 && <span className="sep" aria-hidden="true">/</span>}
        <button type="button" data-breadcrumb={n.id} aria-current={n.id === scope ? 'page' : undefined} onClick={() => n.id === scope ? !blocked() && onSelect(n.id) : enter(n.id, true)}>{n.title}</button></React.Fragment>)}</nav>
      <div className="tools">
        {onOverview
          ? <button type="button" className="tool" data-fold aria-label="折叠为概览" title="折叠为概览" onClick={() => { if (!blocked()) onOverview(); }}>{ICON.fold}</button>
          : <button type="button" className="tool" data-fold aria-label={anyOpen ? '全部折叠' : '全部展开'} title={anyOpen ? '全部折叠' : '全部展开'} onClick={foldAll}>{anyOpen ? ICON.fold : ICON.unfold}</button>}
        <button type="button" className="tool" data-view-toggle aria-label={treeView === 'tb' ? '切换为从左到右' : '切换为从上到下'} title={treeView === 'tb' ? '切换为从左到右' : '切换为从上到下'} onClick={switchView}>{ICON[treeView]}</button>
      </div>
    </header>
    <div className="tree-canvas" ref={canvasRef} data-testid="tree-canvas" tabIndex={0} role="tree" aria-label="树形画布，可平移和缩放"
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClick={onClick} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}
      onMouseOver={event => trace((event.target as HTMLElement).closest<HTMLElement>('.node')?.dataset.id ?? null)} onMouseLeave={() => trace(null)}>
      <div ref={worldRef} className={`world${animate ? ' animate' : ''}${dragging ? ' dragging' : ''}`} data-testid="canvas-world" data-lod={lod}
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        {layout.rects.map(r => {
          const v = view.get(r.id)!, s = aggregateStatus(session, view, r.id), c = counts(session, view, r.id);
          const color = s === 'failed' && v.kind !== 'work' ? 'var(--fail)' : v.kind === 'result' ? 'var(--line-strong)' : 'var(--line)';
          return <div key={r.id} className="region" data-region={r.id} data-kind={v.kind} data-state={s} style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
            <svg viewBox={`0 0 ${r.w + 12} ${r.h + 12}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: frameMarkup(r.id, r.w, r.h, color, v.kind === 'result') }} />
            <div className="region-head"><button type="button" className="region-title" data-select={r.id}><Glyph session={session} view={view} id={r.id} size={14} /><span>{v.title}</span></button>
              <MiniBar c={c} /><span className="region-count">{c.passed} / {c.total}</span>
              <button type="button" className="collapse" data-toggle={r.id} aria-label={`收起：${v.title}`}>−</button></div>
          </div>;
        })}
        <svg className="edges" aria-hidden="true" dangerouslySetInnerHTML={{ __html: edges }} />
        {[...layout.pos].map(([id, p]) => card(id, p))}
        {layout.lines.filter(l => view.get(l.to)?.node?.when).map(l => {
          const n = view.get(l.to)!.node!, condition = session.nodes.find(x => x.id === n.when!.nodeId), z = l.pts[l.pts.length - 1];
          const state = condition?.conditionOutcome === 'unknown' ? 'unknown' : typeof condition?.conditionOutcome === 'boolean' ? (condition.conditionOutcome === n.when!.outcome ? 'yes' : 'no') : '';
          return <span key={`when-${l.to}`} className={`chip ${state}`} style={{ left: treeView === 'tb' ? z.x : z.x - 40, top: treeView === 'tb' ? z.y - 22 : z.y }}>{n.when!.outcome ? '成立时' : '不成立时'}</span>;
        })}
        {chips}
      </div>
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  </section>;
}
