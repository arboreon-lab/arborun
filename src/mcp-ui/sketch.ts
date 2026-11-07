import rough from 'roughjs';
import type { Drawable } from 'roughjs/bin/core';
import type { NodeState } from '../mcp/schema';
import { NODE_D, RING_GAP, RING_W, type Point } from './canvas-model';

/** Hand-drawn strokes as SVG path markup. Every element has a fixed seed so its lines stay put between renders. */
const gen = rough.generator();
export const seedOf = (value: string) => { let h = 7; for (const c of value) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 2147483646) + 1; };
export const draw = (...drawables: (Drawable | Drawable[])[]) => drawables.flat().map(d => gen.toPaths(d).map(p =>
  `<path d="${p.d}" style="stroke:${p.stroke};stroke-width:${p.strokeWidth};fill:${p.fill || 'none'}"/>`).join('')).join('');
const pt = (p: Point): [number, number] => [p.x, p.y];

export type GlyphKind = 'start' | 'accept' | 'result' | 'other';
export function glyphMarkup(id: string, kind: GlyphKind, status: NodeState['status'], options: { agentColor?: string; ready?: boolean; accepted?: boolean; approved?: boolean } = {}) {
  const seed = seedOf(id);
  const o = (stroke: string, x: object = {}) => ({ stroke, strokeWidth: 1.4, roughness: .8, bowing: .6, seed, ...x });
  const solid = (c: string) => o(c, { fill: c, fillStyle: 'solid' });
  const shape = (x: object) => kind === 'result' ? gen.polygon([[8, 1], [15, 8], [8, 15], [1, 8]], x) : gen.circle(8, 8, 13.4, x);
  const mark = (pts: [number, number][], c = 'var(--bg)', w = 1.8) => gen.linearPath(pts, { stroke: c, strokeWidth: w, roughness: .4, seed });
  if (kind === 'start') return draw(gen.circle(8, 8, 13.4, solid(options.approved ? 'var(--ink)' : 'var(--line-strong)')), gen.polygon([[6.4, 4.9], [11.1, 8], [6.4, 11.1]], { stroke: 'var(--bg)', fill: 'var(--bg)', fillStyle: 'solid', roughness: .3, seed }));
  if (kind === 'accept') { const c = options.ready ? 'var(--ink)' : 'var(--faint)'; return draw(gen.circle(8, 8, 13.4, o(c)), gen.circle(8, 8, 5.4, solid(options.accepted ? 'var(--pass)' : c))); }
  if (status === 'passed') return draw(shape(solid('var(--pass)')), mark([[4.8, 8.4], [7.1, 10.7], [11.4, 5.4]]));
  if (status === 'failed') return draw(shape(solid('var(--fail)')), mark([[5.6, 5.6], [10.4, 10.4]]), mark([[10.4, 5.6], [5.6, 10.4]]));
  if (status === 'blocked') return draw(shape(solid('var(--wait)')), mark([[8, 4.4], [8, 8.8]]), mark([[8, 11.2], [8.1, 11.6]], 'var(--bg)', 2.2));
  if (status === 'stale') return draw(shape(o('var(--wait)', { strokeLineDash: [2.4, 2] })), gen.arc(8, 8, 6.4, 6.4, -.4, 4.4, false, o('var(--wait)', { roughness: .4 })));
  if (status === 'skipped') return draw(shape(o('var(--faint)', { strokeLineDash: [2.2, 2] })), mark([[5, 11], [11, 5]], 'var(--faint)', 1.4));
  if (status === 'running') return draw(shape(o('var(--line-strong)'))) + `<g class="spin">${draw(gen.arc(8, 8, 13.4, 13.4, -Math.PI / 2, 0, false, { stroke: options.agentColor ?? 'var(--ink)', strokeWidth: 2.2, roughness: .5, seed }))}</g>`;
  return draw(shape(o(status === 'ready' ? 'var(--ink-2)' : 'var(--faint)')));
}

export interface CardLook { color: string; width: number; dashed?: boolean; stacked?: boolean; hatch?: boolean; selected?: boolean; live?: boolean }
/** Space around the circle inside the node's sketch box: outline wobble plus the progress ring. */
export const SKETCH_M = 16;
const C = SKETCH_M + NODE_D / 2;
/** Node outline: a hand-drawn circle in a (D+2M)² box. `frame` varies the seed so running nodes "boil". */
export function cardMarkup(id: string, look: CardLook, frame = 0) {
  const seed = seedOf(id) + frame * 97, D = NODE_D;
  const base = { stroke: look.color, strokeWidth: look.width, roughness: 1.1, bowing: 1, seed, ...(look.dashed ? { strokeLineDash: [6, 6] } : {}) };
  let out = '';
  if (look.stacked) out += draw(gen.circle(C + 9, C + 7, D, { ...base, stroke: 'var(--faint)', strokeWidth: 1.1, seed: seed + 1 }), gen.circle(C + 5, C + 4, D, { ...base, stroke: 'var(--line-strong)', strokeWidth: 1.1, seed: seed + 2 }));
  if (look.hatch) out += `<g opacity=".2">${draw(gen.circle(C, C, D - 8, { stroke: 'none', fill: look.color, fillStyle: 'hachure', hachureGap: 10, hachureAngle: -41, fillWeight: .8, roughness: 1.2, seed }))}</g>`;
  out += draw(gen.circle(C, C, D, base));
  if (look.selected) out += draw(gen.circle(C, C, D - 7, { ...base, strokeWidth: 1, seed: seed + 5, roughness: 1.5 }));
  return out;
}

/** One agent's arc of the progress ring: its share of the circle, how much of that share is done, and whether it is working now. */
export interface RingSegment { agentId: string; color: string; share: number; done: number; running: boolean; single: boolean }
/**
 * Progress drawn as a stroke around the node: each agent owns an arc in its own colour, sized by its share of the work,
 * and inks it clockwise from the top as its steps and tests pass. Work still ahead is a faint dotted trace.
 */
export function ringMarkup(id: string, segments: RingSegment[]) {
  const r = NODE_D / 2 + RING_GAP, gap = segments.length > 1 ? .09 : 0, seed = seedOf(`ring:${id}`);
  let a = -Math.PI / 2, out = '';
  segments.forEach((s, i) => {
    const span = Math.PI * 2 * s.share - gap, drawn = span * Math.min(1, s.done), sd = seed + i * 13;
    const arc = (from: number, to: number, x: object) => gen.arc(C, C, r * 2, r * 2, from, to, false, { stroke: s.color, seed: sd, disableMultiStroke: true, ...x });
    if (span - drawn > .03) out += `<g class="ring-rest" opacity=".55">${draw(arc(a + drawn, a + span, { strokeWidth: 1.3, roughness: .5, strokeLineDash: [2, 7] }))}</g>`;
    if (drawn > .02) out += `<g class="ring-done" data-agent="${s.agentId}">${draw(arc(a, a + drawn, { strokeWidth: RING_W, roughness: .7, bowing: .6 }))}</g>`;
    if (s.running) {
      const t = a + drawn;
      if (s.single) out += `<g class="ring-spin" style="transform-origin:${C}px ${C}px" data-agent="${s.agentId}">${draw(arc(t, t + 1.1, { strokeWidth: RING_W, roughness: .6 }))}</g>`;
      else out += `<circle class="ring-tip" cx="${C + r * Math.cos(t)}" cy="${C + r * Math.sin(t)}" r="4.6" style="fill:${s.color};transform-origin:${C + r * Math.cos(t)}px ${C + r * Math.sin(t)}px" data-agent="${s.agentId}"/>`;
    }
    a += span + gap;
  });
  return out;
}
export function frameMarkup(id: string, w: number, h: number, color: string, solid: boolean) {
  return draw(gen.rectangle(6, 6, w, h, { stroke: color, strokeWidth: solid ? 1.4 : 1.1, roughness: 1.4, bowing: 2, seed: seedOf(`frame:${id}`), ...(solid ? {} : { strokeLineDash: [10, 7] }) }));
}
export function edgeMarkup(pts: Point[], key: string, color: string, width: number, dashed = false) {
  const z = pts[pts.length - 1], y = pts[pts.length - 2], ang = Math.atan2(z.y - y.y, z.x - y.x), seed = seedOf(key);
  const head: [number, number][] = [[z.x - 8 * Math.cos(ang - .5), z.y - 8 * Math.sin(ang - .5)], [z.x, z.y], [z.x - 8 * Math.cos(ang + .5), z.y - 8 * Math.sin(ang + .5)]];
  return draw(gen.linearPath(pts.map(pt), { stroke: color, strokeWidth: width, roughness: .75, bowing: 1.4, seed, ...(dashed ? { strokeLineDash: [5, 6] } : {}) }), gen.linearPath(head, { stroke: color, strokeWidth: Math.min(width, 1.6), roughness: .4, seed }));
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
export function messageMarkup(d: Curve, key: string, color: string, received: boolean) {
  const e = bez(d, 1), near = bez(d, .96), ang = Math.atan2(e.y - near.y, e.x - near.x), seed = seedOf(key);
  const samples = Array.from({ length: 13 }, (_, k) => pt(bez(d, k / 12)));
  return draw(gen.curve(samples, { stroke: color, strokeWidth: 1.6, roughness: .9, seed, ...(received ? {} : { strokeLineDash: [7, 6] }) }),
    gen.linearPath([[e.x - 9 * Math.cos(ang - .5), e.y - 9 * Math.sin(ang - .5)], [e.x, e.y], [e.x - 9 * Math.cos(ang + .5), e.y - 9 * Math.sin(ang + .5)]], { stroke: color, strokeWidth: 1.6, roughness: .4, seed }));
}
