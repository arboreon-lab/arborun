import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/mcp/schema';
import { TreeBridge, type HostView, type ViewData } from '../src/mcp-ui/bridge';

const mock = vi.hoisted(() => ({
  app: undefined as any,
  theme: vi.fn(), styles: vi.fn(),
}));

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  applyDocumentTheme: mock.theme,
  applyHostStyleVariables: mock.styles,
  App: class {
    context: any = {
      theme: 'dark', styles: { variables: { '--color-text-primary': '#eee' } },
      displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { width: 420, height: 920 },
    };
    ontoolresult?: (reply: unknown) => void;
    onhostcontextchanged?: (change: unknown) => void;
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    callServerTool = vi.fn();
    requestDisplayMode = vi.fn().mockResolvedValue({ mode: 'fullscreen' });
    sendSizeChanged = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue({});
    getHostContext = () => this.context;
    getHostCapabilities = () => ({});
    constructor(public info: unknown, public capabilities: unknown, public options: unknown) { mock.app = this; }
    contextChanged(change: object) {
      this.context = { ...this.context, ...change };
      this.onhostcontextchanged?.(change);
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id: string, revision = 1) => ({ id, revision } as Session);
const reply = (id: string, revision = 1) => ({ structuredContent: { session: session(id, revision) } });
const response = (id: string) => ({ ok: true, text: async () => JSON.stringify({ session: session(id) }) });

beforeEach(() => {
  vi.clearAllMocks();
  mock.app = undefined;
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal('window', { parent: {}, innerWidth: 540, innerHeight: 780 });
});
afterEach(() => vi.unstubAllGlobals());

describe('Arborun MCP 宿主桥接', () => {
  it('连接前注册通知，应用宿主主题并只上报已知初始尺寸', async () => {
    const bridge = new TreeBridge();
    const views: HostView[] = [];
    bridge.onHostView = view => views.push(view);
    await bridge.connect();
    expect(mock.app.options).toEqual({ autoResize: false });
    expect(mock.app.connect).toHaveBeenCalledWith(undefined, { timeout: 10000 });
    expect(mock.app.ontoolresult).toBeTypeOf('function');
    expect(mock.app.onhostcontextchanged).toBeTypeOf('function');
    expect(mock.theme).toHaveBeenCalledWith('dark');
    expect(mock.styles).toHaveBeenCalledWith({ '--color-text-primary': '#eee' });
    expect(views.at(-1)).toEqual({ mode: 'inline', availableModes: ['inline', 'fullscreen'], dimensions: { width: 420, height: 920 } });
    expect(mock.app.sendSizeChanged).toHaveBeenCalledExactlyOnceWith({ width: 420, height: 920 });

    mock.app.contextChanged({ containerDimensions: { width: 1280, height: 900 } });
    expect(views.at(-1)).toEqual({ mode: 'inline', availableModes: ['inline', 'fullscreen'], dimensions: { width: 1280, height: 900 } });
    expect(mock.theme).toHaveBeenLastCalledWith('dark');
    expect(mock.app.sendSizeChanged).toHaveBeenCalledTimes(1);
  });

  it('展开采用宿主实际返回模式，partial context 不丢失能力与已确认模式', async () => {
    const bridge = new TreeBridge();
    const view = vi.fn(); bridge.onHostView = view;
    await bridge.connect();
    mock.app.requestDisplayMode.mockResolvedValueOnce({ mode: 'inline' });
    expect(await bridge.display('fullscreen')).toEqual({ mode: 'inline' });
    expect(view.mock.lastCall?.[0].mode).toBe('inline');
    expect(mock.app.requestDisplayMode).toHaveBeenCalledWith({ mode: 'fullscreen' });
    await bridge.display('fullscreen');
    expect(view.mock.lastCall?.[0].mode).toBe('fullscreen');
    mock.app.contextChanged({ theme: 'light' });
    expect(view.mock.lastCall?.[0]).toMatchObject({ mode: 'fullscreen', availableModes: ['inline', 'fullscreen'] });
    expect(mock.theme).toHaveBeenLastCalledWith('light');
    mock.app.contextChanged({ displayMode: 'inline', availableDisplayModes: ['inline'] });
    await expect(bridge.display('fullscreen')).rejects.toThrow('未提供');
    expect(mock.app.requestDisplayMode).toHaveBeenCalledTimes(2);
  });

  it('新选择已返回后忽略旧会话 read，不把过期错误显示到新树', async () => {
    const bridge = new TreeBridge();
    const data = vi.fn(); bridge.onData = data;
    await bridge.connect();
    const old = deferred<any>(), current = deferred<any>();
    mock.app.callServerTool.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldRead = bridge.read('old'), newRead = bridge.read('new');
    current.resolve(reply('new')); await newRead;
    old.resolve(reply('old')); expect(await oldRead).toEqual({});
    expect(data.mock.calls.map(c => c[0].session.id)).toEqual(['new']);

    const delayed = deferred<any>();
    mock.app.callServerTool.mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(reply('latest'));
    const delayedRead = bridge.read('new'); await bridge.read('latest');
    delayed.reject(new Error('旧请求的网络错误'));
    await expect(delayedRead).resolves.toEqual({});
    expect(data.mock.lastCall?.[0].session.id).toBe('latest');
  });

  it('宿主 tool result 可切换任务，早先轮询不能把它覆盖', async () => {
    const bridge = new TreeBridge();
    const received: ViewData[] = []; bridge.onData = data => received.push(data);
    await bridge.connect();
    const pending = deferred<any>(); mock.app.callServerTool.mockReturnValueOnce(pending.promise);
    const poll = bridge.read('a');
    mock.app.ontoolresult({ ...reply('b'), _meta: { uiToken: 'test-ui-capability' } });
    pending.resolve(reply('a')); await poll;
    expect(received.map(d => d.session?.id)).toEqual(['b']);
    mock.app.callServerTool.mockResolvedValueOnce(reply('b', 2));
    await bridge.act({ type: 'pause', sessionId: 'b', expectedRevision: 1 });
    expect(mock.app.callServerTool).toHaveBeenLastCalledWith({ name: 'arborun_user', arguments: {
      action: { type: 'pause', sessionId: 'b', expectedRevision: 1 }, uiToken: 'test-ui-capability',
    } });
    expect(received.at(-1)?.session?.revision).toBe(2);
    expect(JSON.stringify(received)).not.toContain('test-ui-capability');
  });

  it('用户操作完成前已进入另一任务时，保留新任务而返回操作结果', async () => {
    const bridge = new TreeBridge();
    const data = vi.fn(); bridge.onData = data;
    await bridge.connect();
    mock.app.ontoolresult({ ...reply('a'), _meta: { uiToken: 'test-token' } });
    const mutation = deferred<any>(); mock.app.callServerTool.mockReturnValueOnce(mutation.promise);
    const save = bridge.act({ type: 'pause', sessionId: 'a', expectedRevision: 1 });
    mock.app.ontoolresult(reply('b'));
    mutation.resolve(reply('a', 2));
    expect((await save).session?.revision).toBe(2);
    expect(data.mock.lastCall?.[0].session.id).toBe('b');
    expect(data).toHaveBeenCalledTimes(2);
  });

  it('本地 HTTP 读取使用同样的路由保护，不伪造宿主展开能力', async () => {
    vi.stubGlobal('location', { hash: '#token=test-local-token' });
    const old = deferred<any>(), current = deferred<any>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal('fetch', fetch);
    const bridge = new TreeBridge();
    const data = vi.fn(), view = vi.fn(); bridge.onData = data; bridge.onHostView = view;
    await bridge.connect();
    expect(mock.app).toBeUndefined();
    const oldRead = bridge.read('old'), newRead = bridge.read('new');
    current.resolve(response('new')); await newRead;
    old.resolve(response('old')); await oldRead;
    expect(data.mock.calls.map(c => c[0].session.id)).toEqual(['new']);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-local-token');
    expect(view).not.toHaveBeenCalled();
    await expect(bridge.display('fullscreen')).rejects.toThrow('不支持');
  });

  it('清理桥接后旧请求不再通知界面', async () => {
    const bridge = new TreeBridge();
    const data = vi.fn(); bridge.onData = data;
    await bridge.connect();
    const pending = deferred<any>(); mock.app.callServerTool.mockReturnValueOnce(pending.promise);
    const read = bridge.read('a');
    await bridge.dispose();
    pending.resolve(reply('a')); await read;
    expect(data).not.toHaveBeenCalled();
    expect(mock.app.close).toHaveBeenCalledOnce();
    expect(mock.app.ontoolresult).toBeUndefined();
    expect(mock.app.onhostcontextchanged).toBeUndefined();
  });
});
