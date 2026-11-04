import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { Session, UserActionInput } from '../mcp/schema';

export interface ViewData { session?: Session; sessions?: Array<Pick<Session, 'id' | 'title' | 'status' | 'revision'>> }
type ToolReply = { structuredContent?: unknown; _meta?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** The model never receives this capability via structuredContent. */
export class TreeBridge {
  private app?: App;
  private uiToken?: string;
  private localToken = new URLSearchParams(location.hash.slice(1)).get('token');
  onData?: (data: ViewData) => void;
  onError?: (message: string) => void;
  get local() { return Boolean(this.localToken); }

  async connect() {
    if (this.local) return;
    if (window.parent === window) throw new Error('请从 MCP 宿主打开 Arborun，或使用服务生成的本地预览链接。');
    this.app = new App({ name: 'Arborun', version: '0.2.0' }, {}, { autoResize: true });
    this.app.ontoolresult = result => {
      try { this.unpack(result as ToolReply); }
      catch (error) { this.onError?.(error instanceof Error ? error.message : '读取执行树失败'); }
    };
    const theme = (context: ReturnType<App['getHostContext']>) => {
      if (context?.theme) applyDocumentTheme(context.theme);
      if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    };
    this.app.onhostcontextchanged = context => theme(context);
    await this.app.connect(undefined, { timeout: 10000 });
    theme(this.app.getHostContext());
  }

  private unpack(reply: ToolReply): ViewData {
    if (reply.isError) throw new Error(reply.content?.find(c => c.type === 'text')?.text || '操作未完成');
    if (typeof reply._meta?.uiToken === 'string') this.uiToken = reply._meta.uiToken;
    const data = (reply.structuredContent || {}) as ViewData;
    this.onData?.(data);
    return data;
  }

  private async http(path: string, body?: object): Promise<ViewData> {
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
    return this.unpack({ structuredContent: value });
  }

  async read(sessionId?: string): Promise<ViewData> {
    if (this.local) return this.http(`/api/read${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`);
    if (!this.app) throw new Error('尚未连接宿主');
    return this.unpack(await this.app.callServerTool({ name: 'arborun_read', arguments: sessionId ? { sessionId } : {} }));
  }

  async act(action: UserActionInput): Promise<ViewData> {
    if (this.local) return this.http('/api/user', { action });
    if (!this.app || !this.uiToken) throw new Error('缺少用户界面授权，请重新打开执行树。');
    return this.unpack(await this.app.callServerTool({ name: 'arborun_user', arguments: { action, uiToken: this.uiToken } }));
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
