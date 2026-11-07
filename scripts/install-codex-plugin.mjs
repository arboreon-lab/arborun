// Reinstalls the freshly built plugin into the local Codex so it picks up the new files.
// Codex caches plugins by version, so an unchanged version keeps serving the old build unless it is removed and added again.
// Skipped in CI, when ARBORUN_SKIP_CODEX_INSTALL=1, when the codex CLI is absent, or when the local marketplace is not registered.
import { execFileSync } from 'node:child_process';

const plugin = 'arborun@arborun';
const run = (...args) => execFileSync('codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (process.env.CI || process.env.ARBORUN_SKIP_CODEX_INSTALL === '1') process.exit(0);
let marketplaces;
try { marketplaces = run('plugin', 'marketplace', 'list'); }
catch { console.log('Codex 插件：未找到 codex 命令，跳过安装。'); process.exit(0); }
// Only reinstall when this checkout is the registered `arborun` marketplace (not a GitHub copy).
if (!marketplaces.includes(process.cwd())) { console.log('Codex 插件：本目录未登记为 arborun 插件市场，跳过安装。'); process.exit(0); }
try {
  try { run('plugin', 'remove', plugin); } catch { /* not installed yet */ }
  const added = run('plugin', 'add', plugin);
  console.log(`Codex 插件：已安装最新构建。${(added.match(/Installed plugin root: .*/) ?? [''])[0]}`);
  console.log('Codex 插件：重启 Codex 桌面端后生效。');
} catch (error) {
  console.warn(`Codex 插件：安装失败，构建产物不受影响。${error instanceof Error ? error.message : error}`);
}
