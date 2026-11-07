import { build } from 'esbuild';
import { mkdir, writeFile, cp } from 'node:fs/promises';

await mkdir('dist-mcp', { recursive: true });
const ui = await build({ entryPoints: ['src/mcp-ui/main.tsx'], bundle: true, platform: 'browser', format: 'iife',
  outfile: 'dist-mcp/tree.js', write: false, minify: true, loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, target: 'es2022' });
const js = ui.outputFiles.find(f => f.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
const css = ui.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arborun</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
await writeFile('dist-mcp/tree.html', html);
await build({ entryPoints: ['src/mcp/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: 'dist-mcp/index.mjs', minify: false,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
await mkdir('plugins/arborun/dist-mcp', { recursive: true });
await cp('dist-mcp', 'plugins/arborun/dist-mcp', { recursive: true });
console.log('Arborun MCP: dist-mcp/index.mjs + tree.html');
// A dependency-free package for any MCP client:  npx -y github:arboreon-lab/arborun#mcp  (published by scripts/publish-mcp-branch.mjs)
const { readFile } = await import('node:fs/promises');
const version = JSON.parse(await readFile('plugins/arborun/plugin.json', 'utf8')).version;
await mkdir('dist-mcp-package', { recursive: true });
await writeFile('dist-mcp-package/index.mjs', '#!/usr/bin/env node\n' + await readFile('dist-mcp/index.mjs', 'utf8'));
await cp('dist-mcp/tree.html', 'dist-mcp-package/tree.html');
await writeFile('dist-mcp-package/package.json', JSON.stringify({
  name: 'arborun-mcp', version, description: 'Arborun MCP server: editable, acceptance-centred execution trees for agents',
  type: 'module', bin: { 'arborun-mcp': 'index.mjs' }, files: ['index.mjs', 'tree.html'], engines: { node: '>=22' },
  repository: 'github:arboreon-lab/arborun', license: 'UNLICENSED',
}, null, 2) + '\n');
await cp('scripts/mcp-package-README.md', 'dist-mcp-package/README.md');
console.log('Arborun MCP package: dist-mcp-package/');
await import('./install-codex-plugin.mjs');
