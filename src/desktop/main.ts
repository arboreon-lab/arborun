import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, utilityProcess, type UtilityProcess, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSelectedFiles, exportTask } from './files';
import { validateConfig } from '../harness/provider';
import type { AppState, Command, ModelConfig, PublicModelConfig } from '../shared/types';

let window: BrowserWindow | null = null;
let runtime: UtilityProcess;
let config: ModelConfig | null = null;
let storage: PublicModelConfig['storage'] = 'none';
let sequence = 0;
let shuttingDown = false;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const indexPath = path.join(__dirname, '../dist/index.html');
const devUrl = process.env.ARBORUN_DEV_URL === 'http://127.0.0.1:5187' ? process.env.ARBORUN_DEV_URL : undefined;
if (process.env.ARBORUN_DATA_DIR) app.setPath('userData', path.resolve(process.env.ARBORUN_DATA_DIR));
const dataDir = app.getPath('userData');
const settingsFile = path.join(dataDir, 'model.json');
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
function rpc(type: string, payload: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('执行引擎响应超时，请重新打开应用核对任务。')); }, 180000);
    pending.set(id, { resolve, reject, timer });
    runtime.postMessage({ type, id, ...payload });
  });
}
function publicConfig(): PublicModelConfig { return { baseUrl: config?.baseUrl ?? '', model: config?.model ?? '', hasKey: Boolean(config?.apiKey), storage }; }
async function secureStorageAvailable(): Promise<boolean> {
  if (process.env.ARBORUN_TEST === '1') return false;
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  if (process.platform === 'linux') return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
  return true;
}
async function loadConfig() {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    config = validateConfig({ baseUrl: saved.baseUrl, model: saved.model, apiKey: '' });
    if (saved.encryptedKey && await secureStorageAvailable()) {
      config.apiKey = (await safeStorage.decryptStringAsync(Buffer.from(saved.encryptedKey, 'base64'))).result;
      storage = 'encrypted';
    }
  } catch { /* Missing or unavailable credentials leave the connection unconfigured. */ }
}
function assertSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知界面请求。');
  const url = event.senderFrame?.url ?? '';
  if (devUrl ? new URL(url).origin !== devUrl : url !== pathToFileURL(indexPath).toString()) throw new Error('拒绝外部页面请求。');
}
function handle(channel: string, fn: (...args: any[]) => Promise<any>) {
  ipcMain.handle(channel, async (event, ...args) => { assertSender(event); return fn(...args); });
}
function taskId(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 200) throw new Error('任务标识无效。'); return value; }
async function findTask(id: unknown) { const state: AppState = await rpc('state'); const task = state.tasks.find(t => t.id === taskId(id)); if (!task) throw new Error('任务不存在。'); return task; }
function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width: Math.min(1440, area.width), height: Math.min(960, area.height), minWidth: Math.min(1000, area.width), minHeight: Math.min(700, area.height), title: 'Arborun', backgroundColor: '#f6f5f1', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(indexPath);
  window.on('closed', () => { window = null; });
}
app.whenReady().then(async () => {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await loadConfig();
  runtime = utilityProcess.fork(path.join(__dirname, 'runtime.cjs'), [], { serviceName: 'Arborun Harness', stdio: 'pipe' });
  runtime.on('message', message => {
    if (message.type === 'state') { window?.webContents.send('arborun:changed', message.state); return; }
    const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  });
  runtime.on('exit', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('执行引擎已停止，请重启应用恢复任务。')); }
    pending.clear();
    if (!shuttingDown) dialog.showErrorBox('运行引擎停止', '已保存的任务保留在本机。请重新打开 Arborun，核对后继续。');
  });
  const wasmPath = app.isPackaged ? path.join(process.resourcesPath, 'sql-wasm.wasm') : path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
  await rpc('init', { dataDir, wasmPath, config, test: process.env.ARBORUN_TEST === '1' });
  handle('arborun:state', () => rpc('state'));
  handle('arborun:command', async (command: Command) => {
    // Source snapshots can only enter via the native file picker, not arbitrary renderer commands.
    if (!command || command.type === 'sources' || JSON.stringify(command).length > 100000) throw new Error('无效或超出范围的任务请求。');
    return rpc('command', { command });
  });
  handle('arborun:import', async (id: string) => {
    const task = await findTask(id);
    if (['running', 'planning'].includes(task.status)) throw new Error('请暂停执行后导入资料。');
    const picked = await dialog.showOpenDialog(window!, { title: '选择本次任务可读取的资料', properties: ['openFile', 'multiSelections'], filters: [{ name: '文本资料', extensions: ['md', 'txt', 'json'] }] });
    if (picked.canceled) return rpc('state');
    const sources = await readSelectedFiles(picked.filePaths);
    return rpc('command', { command: { type: 'sources', taskId: task.id, sources } });
  });
  handle('arborun:export', async (id: string) => {
    const task = await findTask(id);
    const picked = await dialog.showOpenDialog(window!, { title: '导出任务树、资料快照和所有产物版本', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled) return null;
    return exportTask(task, picked.filePaths[0]);
  });
  handle('arborun:config', async () => publicConfig());
  handle('arborun:save-config', async (input: ModelConfig) => {
    const state: AppState = await rpc('state');
    if (state.tasks.some(t => ['running', 'planning'].includes(t.status))) throw new Error('请先暂停运行，再修改模型连接。');
    const next = validateConfig(input);
    if (!next.apiKey && config?.baseUrl === next.baseUrl) next.apiKey = config.apiKey;
    let encryptedKey: string | undefined;
    storage = next.apiKey ? 'session' : 'none';
    if (next.apiKey && await secureStorageAvailable()) { encryptedKey = (await safeStorage.encryptStringAsync(next.apiKey)).toString('base64'); storage = 'encrypted'; }
    await rpc('configure', { config: next });
    config = next;
    const temporary = `${settingsFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ baseUrl: next.baseUrl, model: next.model, encryptedKey }), { mode: 0o600 });
    await fs.rename(temporary, settingsFile);
    return publicConfig();
  });
  createWindow();
}).catch(error => { dialog.showErrorBox('Arborun 启动失败', error instanceof Error ? error.message : String(error)); shuttingDown = true; app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown || !runtime) return;
  event.preventDefault(); shuttingDown = true;
  void rpc('shutdown').finally(() => { runtime.kill(); app.quit(); });
});
