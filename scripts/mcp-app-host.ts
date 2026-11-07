// Isolated MCP Apps protocol host. This is not the Codex native panel.
import { AppBridge, PostMessageTransport, McpUiHostStylesSchema, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

z.config({ jitless: true });
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = element<HTMLIFrameElement>('app-frame');
const stage = element('stage');
// This capability remains in the parent closure. The opaque-origin iframe cannot
// read the parent document, URL, cookies, storage, or this authenticated channel.
const capability = new URLSearchParams(location.hash.slice(1)).get('hostToken');
const mode = 'fullscreen' as const;
const theme = 'light' as const;
let bridge: AppBridge | undefined;
let initialized = false;
const events: string[] = [];

function log(message: string) {
  events.push(message);
  if (events.length > 30) events.shift();
}
function error(value: unknown) {
  element('error').textContent = value instanceof Error ? value.message : String(value);
  element('error').hidden = false;
}
async function api<T>(path: string, body: unknown = {}): Promise<T> {
  if (!capability) throw new Error('请使用 connection.json 中的完整测试宿主地址。');
  const response = await fetch(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}
function context(): McpUiHostContext {
  const dimensions = iframe.getBoundingClientRect();
  return {
    displayMode: mode, availableDisplayModes: ['fullscreen'], theme,
    containerDimensions: { width: Math.round(dimensions.width), height: Math.round(dimensions.height) },
    platform: 'desktop', locale: 'zh-CN', timeZone: 'Asia/Shanghai',
    styles: McpUiHostStylesSchema.parse({ variables: {
      '--color-background-primary': '#ffffff', '--color-background-secondary': '#f4f6f8',
      '--color-text-primary': '#1e252e', '--color-text-secondary': '#626c78', '--color-border-primary': '#d8dfe6',
    } }),
  };
}
function updateContext() {
  const next = context();
  if (initialized) bridge?.setHostContext(next);
}
new ResizeObserver(updateContext).observe(stage);

async function start() {
  const initial = await api<{ html: string; result: CallToolResult; sessionId: string }>('/api/bootstrap');
  bridge = new AppBridge(null, { name: 'Arborun SDK test host (not Codex)', version: '1.0.0' },
    { serverTools: {}, logging: {}, message: { text: {} } }, { hostContext: context() });
  bridge.oncalltool = async params => {
    const result = await api<CallToolResult>('/api/tool', params);
    log(`tools/call ${params.name}${result.isError ? ' → error' : ' → ok'}`);
    return result;
  };
  bridge.onrequestdisplaymode = async () => {
    log(`ui/request-display-mode → ${mode}`);
    return { mode };
  };
  bridge.onmessage = async () => {
    log('ui/message → 仅测试宿主接收，未发送给模型');
    return {};
  };
  bridge.onsizechange = dimensions => {
    log(`ui/notifications/size-changed → ${dimensions.width ?? 'auto'} × ${dimensions.height ?? 'auto'}`);
    // Observe the notification without resizing a viewport-filling canvas again.
  };
  bridge.oninitialized = () => {
    initialized = true;
    stage.dataset.connected = 'true';
    log('ui/initialize → ui/notifications/initialized');
    updateContext();
    void (async () => {
      await bridge!.sendToolInput({ arguments: { sessionId: initial.sessionId } });
      await bridge!.sendToolResult(initial.result);
      log('ui/notifications/tool-input → tool-result');
    })().catch(error);
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  iframe.srcdoc = initial.html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

void start().catch(error);
window.addEventListener('pagehide', () => { void bridge?.close(); });
