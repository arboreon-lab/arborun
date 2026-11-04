import { build } from 'esbuild';
await build({ entryPoints: ['src/desktop/main.ts', 'src/desktop/preload.ts', 'src/desktop/runtime.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: 'dist-desktop', outExtension: { '.js': '.cjs' }, external: ['electron', 'sql.js'], sourcemap: true });
