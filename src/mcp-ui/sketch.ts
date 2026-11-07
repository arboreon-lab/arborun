import type { NodeState } from '../mcp/schema';
import { NODE_D, RING_GAP, RING_W, type Point } from './canvas-model';

/** Clean vector marks for the canvas: status icons, edges, message arcs and the agents' progress ring. */
export const SKETCH_M = 16;
const C = SKETCH_M + NODE_D / 2;
const f = (n: number) => +n.toFixed(2);

export type GlyphKind = 'start' | 'accept' | 'result' | 'other';
/** A 16×16 status icon: done, failed, needs attention, running (in the agent's colour), waiting, redo or not applicable. */
export function glyphMarkup(kind: GlyphKind, status: NodeState['status'], options: { agentColor?: string; ready?: boolean; accepted?: boolean; approved?: boolean } = {}) {
  const disc = (fill: string, mark: string) => `<circle cx="8" cy="8" r="7" style="fill:${fill}"/><path d="${mark}" style="fill:none;stroke:var(--on-status);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"/>`;
  const ring = (stroke: string, extra = '') => `<circle cx="8" cy="8" r="6.4" style="fill:none;stroke:${stroke};stroke-width:1.4${extra}"/>`;
  if (kind === 'start') return `<circle cx="8" cy="8" r="7" style="fill:${options.approved ? 'var(--ink)' : 'var(--faint)'}"/><path d="M6.5 5.2v5.6L11 8z" style="fill:var(--bg)"/>`;
  if (kind === 'accept') return ring(options.ready ? 'var(--ink)' : 'var(--faint)') + `<circle cx="8" cy="8" r="3" style="fill:${options.accepted ? 'var(--pass)' : options.ready ? 'var(--ink)' : 'var(--faint)'}"/>`;
  if (status === 'passed') return disc('var(--pass)', 'M4.9 8.3 7 10.4l4.2-4.6');
  if (status === 'failed') return disc('var(--fail)', 'M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6');
  if (status === 'blocked') return disc('var(--wait)', 'M8 4.6v4.2M8 11.3v.1');
  if (status === 'running') { const c = options.agentColor ?? 'var(--accent)'; return ring(c) + `<circle cx="8" cy="8" r="3" style="fill:${c}"/>`; }
  if (status === 'stale') return ring('var(--wait)', ';stroke-dasharray:2.4 2') + `<path d="M8 5v3l2 1.2" style="fill:none;stroke:var(--wait);stroke-width:1.4;stroke-linecap:round"/>`;
  if (status === 'skipped') return ring('var(--faint)') + `<path d="M5.4 10.6l5.2-5.2" style="stroke:var(--faint);stroke-width:1.4;stroke-linecap:round"/>`;
  const c = status === 'ready' ? 'var(--muted)' : 'var(--faint)';
  return ring(c) + `<path d="M8 5v3.2l2.1 1.2" style="fill:none;stroke:${c};stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round"/>`;
}

/** A polyline with softly rounded corners and a small arrowhead at its end. */
export function edgeMarkup(pts: Point[], color: string, width: number, dashed = false) {
  const r = 10;
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const la = Math.hypot(b.x - a.x, b.y - a.y) || 1, lc = Math.hypot(c.x - b.x, c.y - b.y) || 1, k = Math.min(r, la / 2, lc / 2);
    d += ` L${f(b.x - (b.x - a.x) / la * k)} ${f(b.y - (b.y - a.y) / la * k)} Q${f(b.x)} ${f(b.y)} ${f(b.x + (c.x - b.x) / lc * k)} ${f(b.y + (c.y - b.y) / lc * k)}`;
  }
  const z = pts[pts.length - 1], y = pts[pts.length - 2], ang = Math.atan2(z.y - y.y, z.x - y.x);
  d += ` L${f(z.x)} ${f(z.y)}`;
  const head = `M${f(z.x - 6 * Math.cos(ang - .5))} ${f(z.y - 6 * Math.sin(ang - .5))} L${f(z.x)} ${f(z.y)} L${f(z.x - 6 * Math.cos(ang + .5))} ${f(z.y - 6 * Math.sin(ang + .5))}`;
  const style = `fill:none;stroke:${color};stroke-width:${width};stroke-linecap:round;stroke-linejoin:round`;
  return `<path d="${d}" style="${style}${dashed ? ';stroke-dasharray:4 5' : ''}"/><path d="${head}" style="${style}"/>`;
}

const border = (a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, r = NODE_D / 2 + RING_GAP + RING_W + 3;
  return { x: a.x + dx / len * r, y: a.y + dy / len * r };
};
export type Curve = [number, number, number, number, number, number, number, number];
export function messageCurve(a: Point, b: Point, lane: number): Curve {
  const bulge = 40 + lane * 28, p = border(a, b), q = border(b, a), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1, nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
  return [p.x, p.y, mx + nx * bulge, my + ny * bulge, mx + nx * bulge, my + ny * bulge, q.x, q.y];
}
export const bez = (d: Curve, t: number): Point => { const u = 1 - t; return { x: u * u * u * d[0] + 3 * u * u * t * d[2] + 3 * u * t * t * d[4] + t * t * t * d[6], y: u * u * u * d[1] + 3 * u * u * t * d[3] + 3 * u * t * t * d[5] + t * t * t * d[7] }; };
/** A message between agents: a smooth arc in the sender's colour, dashed until it is received. */
export function messageMarkup(d: Curve, color: string, received: boolean) {
  const e = bez(d, 1), near = bez(d, .96), ang = Math.atan2(e.y - near.y, e.x - near.x);
  const style = `fill:none;stroke:${color};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round`;
  return `<path d="M${f(d[0])} ${f(d[1])} C${f(d[2])} ${f(d[3])} ${f(d[4])} ${f(d[5])} ${f(d[6])} ${f(d[7])}" style="${style}${received ? '' : ';stroke-dasharray:6 5'}"/>`
    + `<path d="M${f(e.x - 7 * Math.cos(ang - .5))} ${f(e.y - 7 * Math.sin(ang - .5))} L${f(e.x)} ${f(e.y)} L${f(e.x - 7 * Math.cos(ang + .5))} ${f(e.y - 7 * Math.sin(ang + .5))}" style="${style}"/>`;
}

/** One agent's arc of the progress ring: its share of the circle, how much of that share is done, and whether it is working now. */
export interface RingSegment { agentId: string; color: string; share: number; done: number; running: boolean }
/**
 * Progress as one clean stroke around the node: each agent owns a part of the circle in its own colour and fills it
 * clockwise from the top as its steps and tests pass. Nothing is drawn for work not yet done; an agent working now
 * shows a softly breathing arc (a short stub when it has not finished anything yet).
 */
export function ringMarkup(segments: RingSegment[]) {
  const r = NODE_D / 2 + RING_GAP, gap = segments.length > 1 ? .14 : 0;
  const point = (a: number) => `${f(C + r * Math.cos(a))} ${f(C + r * Math.sin(a))}`;
  const arc = (from: number, to: number) => to - from >= Math.PI * 2 - .001
    ? `M ${point(from)} A ${r} ${r} 0 1 1 ${point(from + Math.PI)} A ${r} ${r} 0 1 1 ${point(from)}`
    : `M ${point(from)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${point(to)}`;
  let a = -Math.PI / 2, out = '';
  for (const s of segments) {
    const span = Math.PI * 2 * s.share - gap, drawn = Math.max(span * Math.min(1, s.done), s.running ? Math.min(.22, span) : 0);
    if (drawn > .01) out += `<path class="ring-arc${s.running ? ' live' : ''}" data-agent="${s.agentId}" d="${arc(a + gap / 2, a + gap / 2 + drawn)}" style="stroke:${s.color};stroke-width:${RING_W}"/>`;
    a += span + gap;
  }
  return out;
}
