// Publishes dist-mcp-package/ to the `mcp` branch so any MCP client can run `npx -y github:arboreon-lab/arborun#mcp`.
// The branch holds only the built, dependency-free package. Run after `pnpm build:mcp`.
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remote = process.env.ARBORUN_REMOTE ?? 'git@github.com:arboreon-lab/arborun.git';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'inherit' });
const source = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dir = await mkdtemp(join(tmpdir(), 'arborun-mcp-branch-'));
try {
  await cp('dist-mcp-package', dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'mcp');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Arborun build', '-c', 'user.email=build@arboreon.invalid', 'commit', '-q', '-m', `mcp package built from ${source}`);
  git(dir, 'push', '-f', remote, 'mcp');
  console.log(`已发布 mcp 分支（来自 ${source}）。`);
} finally { await rm(dir, { recursive: true, force: true }); }
