// Draws the plugin icon in the product's look: black ground, off-white hand-drawn tree
// (start, trunk, results branching to the side, acceptance at the end). Output: SVG + 512px PNG.
import rough from 'roughjs';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const gen = rough.generator(), ink = '#efe7d4', bg = '#0d0d0b', seed = 7;
const paths = d => gen.toPaths(d).map(p => `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || 'none'}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
const line = (pts, w = 34, s = seed) => paths(gen.linearPath(pts, { stroke: ink, strokeWidth: w, roughness: 1.1, bowing: 1.4, seed: s }));
const dot = (x, y, r, s, solid = true) => paths(gen.circle(x, y, r * 2, { stroke: ink, strokeWidth: 26, roughness: .9, seed: s, ...(solid ? { fill: ink, fillStyle: 'solid' } : {}) }));
const body = [
  paths(gen.rectangle(40, 40, 944, 944, { stroke: 'none', fill: bg, fillStyle: 'solid', roughness: 0, seed })),
  line([[380, 250], [380, 780]], 36, 11),                                   // trunk
  line([[380, 470], [520, 470], [520, 400], [650, 400]], 30, 12),           // branch to results
  line([[520, 470], [520, 560], [650, 560]], 30, 13),
  dot(380, 230, 62, 21),                                                     // start
  dot(700, 400, 50, 22), dot(700, 560, 50, 23, false),                       // results: one done, one open
  dot(380, 800, 70, 24, false), dot(380, 800, 26, 25),                       // acceptance: ring with centre
].join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><clipPath id="c"><rect x="40" y="40" width="944" height="944" rx="210"/></clipPath></defs><g clip-path="url(#c)">${body}</g></svg>`;
await writeFile('plugins/arborun/assets/logo.svg', svg);
const browser = await chromium.launch({ channel: process.env.ARBORUN_TEST_BROWSER_CHANNEL || undefined });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`);
await page.screenshot({ path: 'plugins/arborun/assets/logo.png', omitBackground: true });
await browser.close();
console.log('plugins/arborun/assets/logo.svg + logo.png');
