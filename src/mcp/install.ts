import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One-line install for MCP clients:  npx -y github:arboreon-lab/arborun#mcp install <client>
 * Copies the self-contained server to ~/.arborun/server, then registers it in the client's MCP config
 * using the absolute path of the running Node (GUI apps often lack npx on PATH). Existing configs are backed up.
 */
const home = homedir();
const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
const appSupport = (name: string) => platform() === 'darwin' ? join(home, 'Library', 'Application Support', name)
  : platform() === 'win32' ? join(appData, name) : join(home, '.config', name);

interface Client { title: string; config?: string; cli?: (command: string, args: string[], env: Record<string, string>) => string[]; cliName?: string }
export const CLIENTS: Record<string, Client> = {
  'claude-desktop': { title: 'Claude Desktop', config: join(appSupport('Claude'), 'claude_desktop_config.json') },
  'claude-code': { title: 'Claude Code', cliName: 'claude', cli: (command, args, env) => ['mcp', 'add', '-s', 'user', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'arborun', '--', command, ...args] },
  codex: { title: 'Codex', cliName: 'codex', cli: (command, args, env) => ['mcp', 'add', ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), 'arborun', '--', command, ...args] },
  antigravity: { title: 'Antigravity', config: join(home, '.gemini', 'config', 'mcp_config.json') },
  trae: { title: 'Trae', config: join(appSupport('Trae'), 'mcp.json') },
  workbuddy: { title: 'WorkBuddy', config: join(home, '.workbuddy', 'mcp.json') },
  cursor: { title: 'Cursor', config: join(home, '.cursor', 'mcp.json') },
  'gemini-cli': { title: 'Gemini CLI', config: join(home, '.gemini', 'settings.json') },
};

const usage = `Arborun MCP 安装
用法：
  npx -y github:arboreon-lab/arborun#mcp install <工具>      支持：${Object.keys(CLIENTS).join('、')}
  npx -y github:arboreon-lab/arborun#mcp install --all       为本机已安装的上述工具全部安装（Codex 建议用插件，--all 不含 Codex）
  npx -y github:arboreon-lab/arborun#mcp install --config <mcp 配置文件路径>   任何使用 mcpServers 格式的工具
  npx -y github:arboreon-lab/arborun#mcp install --print     只打印配置片段，不写文件`;

// Prefer a stable link to this Node (e.g. /opt/homebrew/bin/node) over a versioned path that breaks on upgrade.
function stableNode() {
  const real = realpathSync(process.execPath);
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try { if (realpathSync(link) === real) return link; } catch { /* absent */ }
  }
  return process.execPath;
}

async function placeServer(): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const source = dirname(fileURLToPath(import.meta.url));
  const target = join(home, '.arborun', 'server');
  if (resolve(source) !== resolve(target)) {
    await mkdir(target, { recursive: true });
    for (const file of ['index.mjs', 'tree.html']) await copyFile(join(source, file), join(target, file));
  }
  return { command: stableNode(), args: [join(target, 'index.mjs')], env: { ARBORUN_MCP_DATA_DIR: join(home, '.arborun', 'data') } };
}

async function writeConfig(path: string, entry: object) {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = await readFile(path, 'utf8');
    try { config = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`无法解析 ${path}（可能包含注释）。请手动把 --print 输出的片段加入 mcpServers。`); }
    await writeFile(`${path}.arborun-backup-${Date.now()}`, text);
  } else await mkdir(dirname(path), { recursive: true });
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  config.mcpServers = { ...servers, arborun: entry };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function hasCli(name: string) {
  try { execFileSync(platform() === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }); return true; } catch { return false; }
}
const installed = (id: string) => {
  const client = CLIENTS[id];
  return client.cliName ? hasCli(client.cliName) : existsSync(dirname(client.config!));
};

export async function install(argv: string[]) {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) { console.log(usage); return; }
  const server = await placeServer();
  const entry = { command: server.command, args: server.args, env: server.env };
  if (argv.includes('--print')) { console.log(JSON.stringify({ mcpServers: { arborun: entry } }, null, 2)); return; }
  const configIndex = argv.indexOf('--config');
  if (configIndex >= 0) {
    const path = resolve(argv[configIndex + 1] ?? '');
    if (!argv[configIndex + 1]) throw new Error('请在 --config 后提供配置文件路径。');
    await writeConfig(path, entry);
    console.log(`已写入 ${path}；重启该工具后生效。`);
    return;
  }
  // Codex is better served by its plugin (icon, skill, side panel); --all leaves it out to avoid a duplicate server.
  const targets = argv.includes('--all') ? Object.keys(CLIENTS).filter(id => id !== 'codex' && installed(id)) : argv.filter(a => !a.startsWith('-'));
  if (!targets.length) throw new Error(argv.includes('--all') ? '没有检测到支持的工具。可用 --config 指定配置文件。' : usage);
  for (const id of targets) {
    const client = CLIENTS[id];
    if (!client) throw new Error(`不认识的工具：${id}。支持：${Object.keys(CLIENTS).join('、')}；其他工具可用 --config。`);
    if (client.cli) {
      if (!hasCli(client.cliName!)) { console.log(`${client.title}：未找到 ${client.cliName} 命令，跳过。`); continue; }
      try { execFileSync(client.cliName!, ['mcp', 'remove', ...(id === 'claude-code' ? ['-s', 'user'] : []), 'arborun'], { stdio: 'ignore' }); } catch { /* not registered yet */ }
      execFileSync(client.cliName!, client.cli(server.command, server.args, server.env), { stdio: 'inherit' });
      console.log(`${client.title}：已注册 arborun。`);
    } else {
      await writeConfig(client.config!, entry);
      console.log(`${client.title}：已写入 ${client.config}；重启 ${client.title} 后生效。`);
    }
  }
  console.log(`服务端位于 ${server.args[0]}；重新运行同一命令即可更新。`);
}
