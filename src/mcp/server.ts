import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ArborunService } from './core';
import { activitySchema, proposeSchema, claimSchema, reportSchema, submitSchema, userActionSchema, type ArborunSnapshot, type Session } from './schema';

const RESOURCE = 'ui://arborun/tree.html';
// Codex reads this per tool: fullscreen shows the tree in the side panel (inline would place it in the conversation).
const display = { preferredModelDisplayMode: 'fullscreen' } as const;
const uiMeta = { ui: { resourceUri: RESOURCE }, 'openai/ui': { entrypoints: [{ type: 'thread' }], ...display } };
const readSchema = z.object({ sessionId: z.string().optional(), afterSequence: z.number().int().nonnegative().optional() }).strict();

export interface RuntimeOptions {
  snapshot?: ArborunSnapshot;
  save(snapshot: ArborunSnapshot): Promise<void>;
  html: string;
  /** Opens the local panel for hosts that cannot render MCP Apps. Returns whether it was opened. */
  openUrl?: (url: string) => boolean;
}

export class ArborunRuntime {
  private service: ArborunService;
  private queue: Promise<unknown> = Promise.resolve();
  readonly uiToken = randomBytes(32).toString('base64url');
  panelUrl = '';
  readonly mcp: McpServer;

  constructor(private readonly options: RuntimeOptions) {
    this.service = new ArborunService(options.snapshot, { recover: true });
    this.mcp = new McpServer({ name: 'arborun', version: '0.2.3' }, {
      instructions: 'Arborun coordinates a user-editable execution tree, built around what the user will check. Before proposing a plan, ask the user in the normal conversation to resolve missing requirements and decisions; record confirmed answers in clarifications and never put unanswered requirements into the tree. Plan with the root children as the trunk in order; put each visible outcome in a kind=result node, with kind=test nodes under it ("when ..., you should see ...", by=user for tests the user stated or confirmed, by=agent for tests you add) and the action nodes that implement it. Each action/test states target, input, output, a one-paragraph mapping of how the input becomes the output, constraints, acceptance and failure route, and generate cases: concrete samples with at least one normal value, one boundary case and one extreme case, each with input and expected output. Show the tree and stop for the user to approve it in the Arborun panel; never approve or accept for the user and never use browser automation on the panel. After approval read the latest revision, claim each node before acting, do the work with your own tools, report actual evidence and checks, report observable actions and messages through arborun_activity, then submit the results tree for human acceptance. Continue normal conversation output. A changed plan revokes approval; do not continue with old claims. If the host cannot show the panel, Arborun opens it in the local browser.',
    });
    this.register();
  }

  async persistRecovery() { await this.options.save(this.service.snapshot()); }

  async mutate<T>(fn: (service: ArborunService) => T): Promise<T> {
    const pending = this.queue.then(async () => {
      const next = new ArborunService(this.service.snapshot());
      const result = fn(next);
      await this.options.save(next.snapshot());
      this.service = next;
      return result;
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async read(sessionId?: string, afterSequence?: number) {
    await this.queue;
    if (!sessionId) return { sessions: this.service.list() };
    const session = this.service.get(sessionId);
    return { session, ...(afterSequence === undefined ? {} : { events: session.events.filter(e => e.sequence > afterSequence) }) };
  }

  // Hosts without MCP Apps get the panel in the local browser, once per task. The URL holds the user token and stays out of tool output.
  private opened = new Set<string>();
  private openPanel(session: Session) {
    if (!this.options.openUrl || !this.panelUrl || this.opened.has(session.id)) return false;
    if (getUiCapability(this.mcp.server.getClientCapabilities() as Parameters<typeof getUiCapability>[0])) return false;
    this.opened.add(session.id);
    return this.options.openUrl(`${this.panelUrl}&sessionId=${encodeURIComponent(session.id)}`);
  }

  private result(data: Record<string, unknown>) {
    const session = data.session as Session | undefined;
    const opened = session ? this.openPanel(session) : false;
    return {
      content: [{ type: 'text' as const, text: (session ? this.service.renderTree(session.id) : 'Arborun\n└─ 请选择或创建任务树。')
        + (opened ? '\n\nArborun 面板已在用户本机浏览器中打开；请让用户在面板中修改、批准或验收。' : '') }],
      structuredContent: data,
      _meta: { uiToken: this.uiToken, panelUrl: this.panelUrl },
    };
  }

  private authorized(value: unknown) {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value); const expected = Buffer.from(this.uiToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private register() {
    registerAppResource(this.mcp, 'Arborun tree', RESOURCE, {
      description: '可编辑计划、执行位置和结果验收树',
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } },
    }, async () => ({ contents: [{ uri: RESOURCE, mimeType: RESOURCE_MIME_TYPE, text: this.options.html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }] }));

    const safe = (fn: (args: any) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>) => async (args: any) => {
      try { return await fn(args); }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '操作失败' }] }; }
    };
    registerAppTool(this.mcp, 'arborun_read', {
      title: 'Arborun', description: 'Open the editable execution tree. Read latest approval, revision, pending user requests, agents and node results. With no sessionId list sessions for explicit selection. Never infer approval from chat text.',
      inputSchema: readSchema, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: uiMeta,
    }, safe(async args => this.result(await this.read(args.sessionId, args.afterSequence))));
    registerAppTool(this.mcp, 'arborun_plan', {
      title: '生成或修改执行树', description: 'Ask unresolved requirement questions in the normal host conversation first, then propose a concrete tree from confirmed requirements and relevant context. Provide confirmed question/answer records in clarifications; unanswered records are rejected without creating or changing a tree. Organise the tree around what the user will check: the children of the root are the trunk in order; put each visible outcome in a kind=result node whose action states the effect, and under it kind=test nodes ("当……时，应该看到……", with by=user for tests the user stated or confirmed, by=agent for tests you add) plus the action nodes that implement it. Each action/test needs target, input, output, mapping (one paragraph: how the input becomes the output), constraints, acceptance and failure route, plus generated cases with kind normal, boundary and extreme (at least one of each; concrete input and expected output). Tests the user set cannot be changed or removed by a plan update. Parent is containment; dependsOn is execution dependency. Conditional nodes use when; each planned agent has role/scope/budget. Updating requires expectedRevision and always revokes old approval. Then show UI and wait for the user.',
      inputSchema: proposeSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { resourceUri: RESOURCE }, 'openai/ui': display },
    }, safe(async args => this.result({ session: await this.mutate(s => s.propose(args)) })));
    registerAppTool(this.mcp, 'arborun_claim', {
      title: '领取执行节点', description: 'Claim an approved, ready node for its declared agent immediately before actual host work. Returns attemptId and claimToken; do not perform work when rejected. Registration in a plan is not creation of a real subagent. Use host agent tools to create workers only after corresponding approval.',
      inputSchema: claimSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['model'] } },
    }, safe(async args => this.result(await this.mutate(s => s.claim(args)))));
    registerAppTool(this.mcp, 'arborun_report', {
      title: '记录执行进度与结果', description: 'Report actual host work for the claimed attempt using claimToken and unique eventId. Include evidence and checks matching every acceptance criterion before passed. Condition must report true/false/unknown explicitly. Evidence is agent-reported, never automatically host-verified. Late results go to history; read current tree before continuing.',
      inputSchema: reportSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['model'] } },
    }, safe(async args => this.result({ session: await this.mutate(s => s.report(args)) })));
    registerAppTool(this.mcp, 'arborun_activity', {
      title: '记录 Agent 动作与消息', description: 'Observe actual host actions and inter-agent messages for a current approved running attempt. Authenticate with its claimToken and unique eventId. action records observable work, never private reasoning; runtimeAgentId identifies the actual host instance as an agent-reported label. After a real host message send, record message_sent with a unique messageId and declared recipient; only that recipient can record message_received using its own active claim. This tool does not send messages, start agents, infer delivery, or replace normal Codex conversation output. Old/invalid attempts are rejected.',
      inputSchema: activitySchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['model'] } },
    }, safe(async args => {
      const session = await this.mutate(s => s.activity(args));
      const activity = session.activities!.find(item => item.id === args.eventId)!;
      return { content: [{ type: 'text' as const, text: `已记录${activity.kind === 'action' ? '动作' : activity.kind === 'message_sent' ? '消息发送' : '消息接收'}：${activity.summary}` }],
        structuredContent: { sessionId: session.id, revision: session.revision, activity, sequence: activity.sequence } };
    }));
    registerAppTool(this.mcp, 'arborun_submit', {
      title: '提交验收树', description: 'When all applicable nodes pass with evidence, generate final acceptance tree from the same node IDs. This does not accept on behalf of the user. Any unresolved or running node prevents completion.',
      inputSchema: submitSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { resourceUri: RESOURCE }, 'openai/ui': display },
    }, safe(async args => this.result({ session: await this.mutate(s => s.submit(args)) })));
    registerAppTool(this.mcp, 'arborun_user', {
      title: '树的用户操作', description: 'App-only user gestures: edit plan, request AI changes, approve current revision, pause, accept or return results. Do not invoke from the model.',
      inputSchema: z.object({ uiToken: z.string(), action: userActionSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'], resourceUri: RESOURCE }, 'openai/ui': display },
    }, safe(async ({ uiToken, action }) => {
      if (!this.authorized(uiToken)) throw new Error('此操作需要树界面的用户操作凭证。');
      return this.result({ session: await this.mutate(s => s.userAction(action)) });
    }));
  }

  async listen(port = 0) {
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const origin = new URL(this.panelUrl).origin;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
        response.writeHead(403).end('Origin rejected'); return;
      }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/' && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src data:; frame-ancestors 'self'");
        response.end(this.options.html); return;
      }
      if (!this.authorized(request.headers.authorization?.replace(/^Bearer /, ''))) {
        response.writeHead(401).end('需要从 Arborun 本地预览链接打开。'); return;
      }
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        if (url.pathname === '/api/read' && request.method === 'GET') {
          response.end(JSON.stringify(await this.read(url.searchParams.get('sessionId') ?? undefined))); return;
        }
        if (url.pathname === '/api/user' && request.method === 'POST') {
          const body = await readBody(request);
          const action = userActionSchema.parse(body.action);
          const session = await this.mutate(s => s.userAction(action));
          response.end(JSON.stringify({ session })); return;
        }
        response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      } catch (error) {
        response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败' }));
      }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动本地预览');
    this.panelUrl = `http://127.0.0.1:${address.port}/#token=${this.uiToken}`;
    return server;
  }
}

async function readBody(request: IncomingMessage): Promise<any> {
  let size = 0; const parts: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求超过 1 MB。');
    parts.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
