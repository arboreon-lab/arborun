// Draws the plugin icon in the product's look: a clay tile with a clean ivory tree
// (a trunk of stages with results branching to the side, the last one still open). Output: SVG + 512px PNG.
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const clay = '#c96442', ivory = '#faf9f5';
const stroke = `stroke="${ivory}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
const body = [
  `<rect x="40" y="40" width="944" height="944" rx="220" fill="${clay}"/>`,
  `<path d="M372 300 V724" ${stroke}/>`,                                       // trunk of stages
  `<path d="M372 512 H500 Q532 512 532 480 V432 Q532 400 564 400 H612" ${stroke}/>`, // branch to a result
  `<path d="M532 512 V592 Q532 624 564 624 H612" ${stroke}/>`,
  `<circle cx="372" cy="262" r="58" fill="${ivory}"/>`,                       // first stage
  `<circle cx="372" cy="762" r="58" fill="${ivory}"/>`,                       // last stage
  `<circle cx="666" cy="400" r="50" fill="${ivory}"/>`,                       // result done
  `<circle cx="666" cy="624" r="42" ${stroke.replace('34', '26')}/>`,          // result still open
].join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${body}</svg>`;
await writeFile('plugins/arborun/assets/logo.svg', svg);
const browser = await chromium.launch({ channel: process.env.ARBORUN_TEST_BROWSER_CHANNEL || undefined });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`);
await page.screenshot({ path: 'plugins/arborun/assets/logo.png', omitBackground: true });
await browser.close();
console.log('plugins/arborun/assets/logo.svg + logo.png');
