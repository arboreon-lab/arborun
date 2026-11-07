import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { Session, UserActionInput } from '../mcp/schema';

export interface ViewData { session?: Session; sessions?: Array<Pick<Session, 'id' | 'title' | 'status' | 'revision'>> }
type DisplayMode = 'inline' | 'fullscreen' | 'pip';
export interface HostView {
  mode: DisplayMode;
  availableModes: DisplayMode[];
  dimensions?: { width?: number; height?: number; maxWidth?: number; maxHeight?: number };
}
type ToolReply = { structuredContent?: unknown; _meta?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** The model never receives this capability via structuredContent. */
export class TreeBridge {
  private app?: App;
  private uiToken?: string;
  private localToken = new URLSearchParams(location.hash.slice(1)).get('token');
  private readSequence = 0;
  private currentSessionId?: string;
  private hostView?: HostView;
  onData?: (data: ViewData) => void;
  onError?: (message: string) => void;
  onHostView?: (view: HostView) => void;
  get local() { return Boolean(this.localToken); }

  async connect() {
    if (this.local) return;
    if (window.parent === window) throw new Error('请从 MCP 宿主打开 Arborun，或使用服务生成的本地预览链接。');
    // The canvas fills the host viewport. Measuring it as max-content can create
    // a host resize feedback loop; report only the initial, observed dimensions.
    this.app = new App({ name: 'Arborun', version: '0.2.3' }, {}, { autoResize: false });
    this.app.ontoolresult = result => {
      // A host tool result is an explicit navigation/data delivery, unlike a poll.
      // Any read started before it must not navigate back to an older session.
      ++this.readSequence;
      try { this.unpack(result as ToolReply); }
      catch (error) { this.onError?.(error instanceof Error ? error.message : '读取执行树失败'); }
    };
    // The notification is partial; the SDK merges it into getHostContext first.
    this.app.onhostcontextchanged = change => this.publishHostView(change.displayMode ?? this.hostView?.mode);
    await this.app.connect(undefined, { timeout: 10000 });
    this.publishHostView();
    const dimensions = this.hostView?.dimensions;
    const height = dimensions?.height ?? window.innerHeight;
    const width = dimensions?.width ?? window.innerWidth;
    if (Number.isFinite(height) && height > 0 && Number.isFinite(width) && width > 0) {
      // Size hints are optional; failure must not discard an established bridge.
      await this.app.sendSizeChanged({ height, width }).catch(() => undefined);
    }
  }

  private publishHostView(actualMode?: DisplayMode) {
    const context = this.app?.getHostContext();
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    this.hostView = {
      mode: actualMode ?? context?.displayMode ?? 'inline',
      availableModes: context?.availableDisplayModes ?? [],
      ...(context?.containerDimensions ? { dimensions: context.containerDimensions } : {}),
    };
    this.onHostView?.(this.hostView);
  }

  /** Inline views grow with their content: the overview is short, the detail view is tall. Hosts may ignore the hint. */
  async resize(height: number) {
    if (!this.app || this.hostView?.mode !== 'inline') return;
    await this.app.sendSizeChanged({ height: Math.ceil(height) }).catch(() => undefined);
  }
  get inline() { return !this.local && this.hostView?.mode === 'inline'; }

  async display(mode: 'inline' | 'fullscreen') {
    if (!this.app) throw new Error('当前连接不支持宿主面板切换。');
    if (!this.hostView?.availableModes.includes(mode)) throw new Error('宿主未提供此面板模式。');
    const result = await this.app.requestDisplayMode({ mode });
    // The host may keep its existing mode; never present the requested mode as fact.
    this.publishHostView(result.mode);
    return result;
  }

  private unpack(reply: ToolReply, publish = true): ViewData {
    if (reply.isError) throw new Error(reply.content?.find(c => c.type === 'text')?.text || '操作未完成');
    const data = (reply.structuredContent || {}) as ViewData;
    if (publish) {
      if (typeof reply._meta?.uiToken === 'string') this.uiToken = reply._meta.uiToken;
      if (data.session) this.currentSessionId = data.session.id;
      this.onData?.(data);
    }
    return data;
  }

  private async http(path: string, body?: object): Promise<ToolReply> {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.localToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(text || '服务连接失败'); }
    if (!response.ok) throw new Error(value.error || '服务连接失败');
    return { structuredContent: value };
  }

  async read(sessionId?: string): Promise<ViewData> {
    const sequence = ++this.readSequence;
    this.currentSessionId = sessionId;
    try {
      let reply: ToolReply;
      if (this.local) reply = await this.http(`/api/read${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`);
      else {
        if (!this.app) throw new Error('尚未连接宿主');
        reply = await this.app.callServerTool({ name: 'arborun_read', arguments: sessionId ? { sessionId } : {} });
      }
      return sequence === this.readSequence ? this.unpack(reply) : {};
    } catch (error) {
      if (sequence !== this.readSequence) return {};
      throw error;
    }
  }

  async act(action: UserActionInput): Promise<ViewData> {
    ++this.readSequence;
    let reply: ToolReply;
    if (this.local) reply = await this.http('/api/user', { action });
    else {
      if (!this.app || !this.uiToken) throw new Error('缺少用户界面授权，请重新打开执行树。');
      reply = await this.app.callServerTool({ name: 'arborun_user', arguments: { action, uiToken: this.uiToken } });
    }
    return this.unpack(reply, !this.currentSessionId || this.currentSessionId === action.sessionId);
  }

  async dispose() {
    ++this.readSequence;
    this.onData = undefined;
    this.onError = undefined;
    this.onHostView = undefined;
    const app = this.app;
    this.app = undefined;
    this.uiToken = undefined;
    this.hostView = undefined;
    if (app) { app.ontoolresult = undefined; app.onhostcontextchanged = undefined; }
    await app?.close();
  }

  async notify(message: string): Promise<'sent' | 'composed' | false> {
    if (!this.app) return false;
    try {
      const experimental = this.app.getHostCapabilities()?.experimental;
      const direct = Boolean(experimental && Object.hasOwn(experimental, 'openai/message'));
      const result = await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text: message }],
        ...(direct ? { _meta: { 'openai/message': { target: 'active', send: true } } } : {}),
      });
      return result.isError ? false : direct ? 'sent' : 'composed';
    } catch { return false; }
  }
}
