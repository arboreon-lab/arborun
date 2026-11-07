import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSpec, NodeSpec, NodeState, Session, UserActionInput } from '../mcp/schema';
import { TreeBridge, type ViewData } from './bridge';
import { TreeCanvas } from './TreeCanvas';
import { ACCEPT_ID, TASK_ID } from './canvas-model';
import { NodeInspector } from './NodeInspector';
import { Overview } from './Overview';
import { nodeSpecification, previewImpact } from './inspector-model';
import './styles.css';

const bridge = new TreeBridge();
/**
 * Hover previews pop up from the top or bottom of the canvas, on the side away from the node, so the node stays visible.
 * The preview takes the free space on that side (at least 240px, at most half the canvas). A click opens the full-screen page.
 */
type SheetPlace = { top: boolean; height: number };
function placeFor(id: string): SheetPlace {
  const area = document.querySelector('.workspace-area')?.getBoundingClientRect();
  const node = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  if (!area) return { top: false, height: 320 };
  // Top bar (52px) plus the sheet's 12px inset.
  const head = 64, max = (area.height - head) * .5;
  if (!node) return { top: false, height: Math.round(Math.max(240, max)) };
  const top = (node.top + node.bottom) / 2 > area.top + area.height / 2;
  const free = top ? node.top - area.top - head : area.bottom - node.bottom - 12;
  return { top, height: Math.round(Math.max(240, Math.min(max, free - 10))) };
}
const loadArtifact = (id: string) => bridge.artifact(id);
const EXPANDED_HEIGHT = 640;
const phaseNames: Record<Session['status'], string> = {
  draft: '待批准', approved: '已批准', running: '执行中', paused: '已暂停', review: '待验收', accepted: '用户已验收',
};
const specs = (nodes: NodeState[]): NodeSpec[] => nodes.map(nodeSpecification);
const sequence = (session: Session) => session.events.at(-1)?.sequence ?? 0;
type UserOperation = UserActionInput extends infer T ? T extends UserActionInput ? Omit<T, 'sessionId' | 'expectedRevision'> : never : never;
type InspectorMode = 'detail' | 'edit' | 'add';

function Arborun() {
  const [session, setSession] = useState<Session>();
  const [sessions, setSessions] = useState<ViewData['sessions']>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<{ id: string; mode: InspectorMode; revision: number }>();
  const [request, setRequest] = useState<{ target: string | null; rework: boolean; revision: number; completed?: boolean }>();
  const [note, setNote] = useState('');
  const [continuation, setContinuation] = useState('');
  const [showRecords, setShowRecords] = useState(false);
  // The whole task drops down under the title; hovering a node previews its details on the right.
  const [taskOpen, setTaskOpen] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverPlace, setHoverPlace] = useState<SheetPlace>({ top: false, height: 320 });
  const hoverTimer = useRef<number | undefined>(undefined);
  const overPanel = useRef(false);
  const inspectorRef = useRef<string | undefined>(undefined);
  const [locateRequest, setLocateRequest] = useState<{ id: string; key: number }>();
  const [resetRequest, setResetRequest] = useState<{ id?: string; key: number }>();
  // Inline in the conversation the tree starts folded as an overview; elsewhere it starts expanded.
  const [overview, setOverview] = useState(false);
  const [inline, setInline] = useState(false);
  const overviewRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | undefined>(new URLSearchParams(location.hash.slice(1)).get('sessionId') || undefined);
  const sessionStateRef = useRef<Session | undefined>(undefined);
  const refreshRef = useRef(false);
  const connectedRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  inspectorRef.current = inspector?.id;

  useEffect(() => {
    let alive = true;
    bridge.onData = data => {
      if (!alive) return;
      if (data.sessions) setSessions(data.sessions);
      if (!data.session) return;
      const next = data.session;
      const previous = sessionStateRef.current;
      // A poll started before a mutation may finish after it. Never roll the tree back.
      if (previous?.id === next.id && (next.revision < previous.revision ||
        (next.revision === previous.revision && sequence(next) < sequence(previous)))) return;
      if (previous && previous.id !== next.id) {
        setSelectedId(null); setInspector(undefined); setRequest(undefined); setNote(''); setContinuation('');
      }
      sessionIdRef.current = next.id;
      sessionStateRef.current = next;
      setSession(next);
      setNetworkError('');
    };
    bridge.onError = message => { if (alive) setError(message); };
    let firstView = true;
    bridge.onHostView = view => {
      if (!alive) return;
      setInline(view.mode === 'inline');
      if (firstView) { firstView = false; setOverview(view.mode === 'inline'); }
    };
    const refresh = async () => {
      if (refreshRef.current || busyRef.current || !alive) return;
      refreshRef.current = true;
      try { await bridge.read(sessionIdRef.current); if (alive) setNetworkError(''); }
      catch (err) { if (alive) setNetworkError(err instanceof Error ? err.message : '连接失败'); }
      finally { refreshRef.current = false; }
    };
    void bridge.connect().then(async () => {
      if (!alive) return;
      connectedRef.current = true; setConnected(true); await refresh();
    }).catch(err => { if (alive) setNetworkError(String(err.message || err)); });
    const timer = window.setInterval(() => { if (!document.hidden && connectedRef.current) void refresh(); }, 1200);
    const foreground = () => { if (!document.hidden && connectedRef.current) void refresh(); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground);
      bridge.onData = undefined; bridge.onError = undefined; bridge.onHostView = undefined;
      void bridge.dispose();
    };
  }, []);


  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true); busyRef.current = true; setError(''); setNotice('');
    try { await operation(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作未完成'); }
    finally { setBusy(false); busyRef.current = false; }
  };
  const act = (operation: UserOperation, revision = session?.revision) => {
    if (!session || !revision) throw new Error('没有打开的执行树');
    return bridge.act({ ...operation, sessionId: session.id, expectedRevision: revision } as UserActionInput);
  };
  const signalHost = async (message: string) => {
    const sent = await bridge.notify(message);
    setContinuation(sent === 'sent' ? '' : message);
    setNotice(sent === 'sent' ? '已请求宿主 Agent 继续。' : sent === 'composed' ? '指令已交给宿主；若停留在输入框，请点击发送。' : '操作已保存。请将接续指令发送到当前对话。');
    return sent;
  };
  const openInspector = (id: string, mode: InspectorMode = 'detail') => {
    if (!session) return;
    window.clearTimeout(hoverTimer.current); setHoverId(null);
    if (inspector?.mode === 'edit' || inspector?.mode === 'add' || request) { setNotice('请先保存或取消当前编辑。'); return; }
    setSelectedId(id); setRequest(undefined); setInspector({ id, mode, revision: session.revision });
  };
  // Hover previews a node's details after a short pause and hides them when the pointer leaves the node. The preview
  // is display-only (the pointer passes through it to the tree); clicking a node pins its details. Drafts are never replaced.
  const hover = (id: string | null) => {
    window.clearTimeout(hoverTimer.current);
    if (inspector?.mode === 'edit' || inspector?.mode === 'add' || request || taskOpen) return;
    hoverTimer.current = window.setTimeout(() => {
      if (!id && overPanel.current) return;
      // Hovering the node whose details are already pinned shows nothing extra.
      if (id && id === inspectorRef.current) id = null;
      if (id) setHoverPlace(placeFor(id));
      setHoverId(id);
    }, id ? 140 : 260);
  };
  // Esc leaves the full-screen node page (drafts stay until saved or cancelled).
  useEffect(() => {
    if (inspector?.mode !== 'detail') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setInspector(undefined); setSelectedId(null); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [inspector?.mode, inspector?.id]);
  const select = (id: string | null) => {
    // Canvas navigation must not move selection away from an open draft.
    if (inspector?.mode === 'edit' || inspector?.mode === 'add' || request) return;
    setSelectedId(id);
    if (id) setTaskOpen(false);
    setInspector(id && session ? { id, mode: 'detail', revision: session.revision } : undefined);
  };
  const saveNode = (node: NodeSpec) => perform(async () => {
    if (!session || !inspector) return;
    const next = specs(session.nodes).map(n => n.id === node.id ? node : n);
    if (!next.some(n => n.id === node.id)) next.push(node);
    const result = await act({ type: 'edit', nodes: next }, inspector.revision);
    if (sessionStateRef.current?.id !== session.id) return;
    setSelectedId(node.id);
    setInspector({ id: node.id, mode: 'detail', revision: result.session?.revision ?? session.revision + 1 });
    setNotice('已保存新版本。整任务需重新批准，旧执行记录保留。');
  });
  const saveAgents = (agents: AgentSpec[]) => perform(async () => {
    if (!session) return;
    await act({ type: 'edit', nodes: specs(session.nodes), agents }, session.revision);
    setNotice('已保存 Agent 设置。整任务需重新批准。');
  });
  // Not satisfied with a finished node: stop everything, go back to it, and open it for editing.
  const rollback = (id: string, message?: string) => perform(async () => {
    if (!session) return;
    const target = session.nodes.find(n => n.id === id);
    await act({ type: 'rollback', nodeId: id, ...(message ? { message } : {}) });
    await signalHost(`用户对 Arborun 执行树 ${session.id} 中的「${target?.title ?? id}」不满意，已中止执行并回退到这个节点${message ? `：${message}` : ''}。请立即停止所有正在进行的动作，读取最新树；${message ? '按用户意见修改这个节点后用 arborun_plan 提交，' : ''}等待用户修改并重新批准，勿继续执行。`);
    setHoverId(null); setTaskOpen(false);
    if (session.nodes.some(n => n.id === id)) { setSelectedId(id); setInspector({ id, mode: 'edit', revision: session.revision }); }
  });
  const removeNode = (id: string) => perform(async () => {
    if (!session || !inspector) return;
    if (session.nodes.some(n => n.parentId === id)) throw new Error('请先移动或删除子节点。');
    if (session.nodes.some(n => n.dependsOn.includes(id) || n.when?.nodeId === id)) throw new Error('其他节点仍引用此节点，请先调整依赖和条件。');
    await act({ type: 'edit', nodes: specs(session.nodes).filter(n => n.id !== id) }, inspector.revision);
    if (sessionStateRef.current?.id !== session.id) return;
    setInspector(undefined); setSelectedId(null); setNotice('节点已删除，旧执行记录保留。');
  });
  const askAi = (id: string | null = null, rework = false) => {
    if (!session) return;
    setInspector(undefined); setRequest({ target: id, rework, revision: session.revision }); setNote(''); setContinuation('');
  };
  const requestAi = () => perform(async () => {
    if (!session || !request || !note.trim()) return;
    const target = request.target ? session.nodes.find(n => n.id === request.target) : undefined;
    const message = `${target ? `${request.rework ? '返工' : '修改'}「${target.title}」及其子树（${target.id}）：` : ''}${note.trim()}`;
    await act({ type: request.rework ? 'requestChanges' : 'requestAi', message }, request.revision);
    const sent = await signalHost(`请读取 Arborun 执行树 ${session.id}，根据用户要求更新计划：${message}。更新后等待用户在树中批准，勿提前执行。`);
    setRequest(sent === 'sent' ? undefined : { ...request, completed: true }); setNote('');
  });
  // One click asks the host agent for samples; the plan change still needs the user's approval.
  const generateCases = (id: string) => perform(async () => {
    const target = session?.nodes.find(n => n.id === id);
    if (!session || !target) return;
    const message = `为「${target.title}」（${id}）生成测试样例：正常值、边界情况、极端情况各至少一个，写明具体输入与期望输出；同时补全输出、映射说明与约束`;
    await act({ type: 'requestAi', message });
    const sent = await signalHost(`请读取 Arborun 执行树 ${session.id}，${message}。更新后等待用户在树中批准，勿提前执行。`);
    if (sent !== 'sent') { setInspector(undefined); setRequest({ target: id, rework: false, revision: session.revision, completed: true }); }
  });
  const locate = (id: string) => {
    setShowRecords(false); setLocateRequest({ id, key: Date.now() });
    openInspector(id);
  };
  const active = session?.attempts.filter(a => a.status === 'running' && !a.invalidated && a.revision === session.revision && session.nodes.find(n => n.id === a.nodeId)?.attemptId === a.id) ?? [];
  const editing = inspector?.mode === 'edit' || inspector?.mode === 'add' || Boolean(request);

  const taskActions = session && <div className="task-detail-actions">
    <div className="row">
      {['draft', 'paused'].includes(session.status) && <button className="btn primary" disabled={busy || editing} onClick={() => void perform(async () => {
        await act({ type: 'approve' }); await signalHost(`用户已批准 Arborun 执行树 ${session.id} 的 v${session.revision}。请读取最新状态，逐节点领取并执行，持续上报 Agent 位置、结果与问题，完成后提交验收树。`);
      })}>批准 v{session.revision} 并执行</button>}
      {['running', 'approved'].includes(session.status) && <button className="btn" disabled={busy} onClick={() => void perform(async () => {
        await act({ type: 'pause' }); await signalHost(`用户已暂停 Arborun 执行树 ${session.id}。请停止领取节点，在安全边界停止当前动作并读取最新状态。`);
      })}>暂停执行</button>}
      {session.status === 'review' && <><button className="btn primary" disabled={busy || editing} onClick={() => void perform(async () => { await act({ type: 'accept' }); setNotice('验收已记录。'); })}>验收通过</button><button className="btn" disabled={busy || editing} onClick={() => askAi(null, true)}>退回修改</button></>}
    </div>
    {continuation && <details className="continuation"><summary>发送到当前对话的接续指令</summary><textarea aria-label="发送到当前对话" readOnly value={continuation} rows={3} /></details>}
  </div>;

  const expand = (id?: string) => { setOverview(false); if (id) locate(id); };
  // Inline views report their height: the overview hugs its content, the expanded tree gets room to work.
  useEffect(() => {
    if (!inline) return;
    if (!overview || !session) { void bridge.resize(EXPANDED_HEIGHT); return; }
    const element = overviewRef.current; if (!element) return;
    const report = () => void bridge.resize(element.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report); observer.observe(element);
    return () => observer.disconnect();
  }, [inline, overview, Boolean(session)]);

  return <main className={`arborun-app${overview && session ? ' is-overview' : ''}`}>
    {(error || networkError) && <div className="message error" role="alert" onClick={() => { setError(''); setNetworkError(''); }}>{error || networkError}</div>}
    {notice && <div className="message" role="status" onClick={() => setNotice('')}>{notice}</div>}
    {session && overview ? <div ref={overviewRef}><Overview session={session} onExpand={expand} taskActions={taskActions} /></div>
    : !session ? <section className="empty"><h1>{connected ? '等待决策执行树' : '连接执行树'}</h1><p>{connected ? '向当前 Agent 说明任务，让它结合上下文生成 Arborun 执行树。' : '正在连接 MCP 服务。'}</p>{!!sessions?.length && <ul>{sessions.map(s => <li key={s.id}><button onClick={() => void perform(() => bridge.read(s.id))}>{s.title}</button></li>)}</ul>}</section> : <>
      <div className="workspace-area" data-details={Boolean(inspector || request || showRecords)}>
        <TreeCanvas key={session.id} session={session} selectedId={selectedId} onSelect={id => { setHoverId(null); select(id); }} taskOpen={taskOpen} onTaskToggle={open => setTaskOpen(open ?? !taskOpen)} onHover={hover} onEnter={id => {
            if (editing) return;
            // Entering a single step or test opens its detail; entering a subtree starts with the tree alone.
            const entered = session.nodes.find(n => n.id === id);
            if (entered && entered.kind !== 'group' && entered.kind !== 'result') select(id);
            else { setInspector(undefined); setSelectedId(null); }
          }}
          editing={editing} locateRequest={locateRequest} resetRequest={resetRequest} panelOpen={Boolean(inspector || request || showRecords)}
          impact={inspector?.mode === 'edit' && session.nodes.some(n => n.id === inspector.id) ? new Set(previewImpact(session, specs(session.nodes).find(n => n.id === inspector.id)!).map(n => n.id)) : undefined} />
        {taskOpen && <div className="task-sheet" role="region" aria-label="整体任务">
          <NodeInspector key={`${session.id}:task`} session={session} nodeId={TASK_ID} mode="detail" busy={busy} editRevision={session.revision}
            onClose={() => setTaskOpen(false)} onEdit={() => {}} onSave={saveNode} onDelete={removeNode} onAdd={() => {}} onAskAi={askAi} onGenerateCases={generateCases} onRollback={rollback} loadArtifact={loadArtifact}
            onLocate={id => { setTaskOpen(false); locate(id); }} onSaveAgents={saveAgents} taskActions={taskActions} />
        </div>}
        {(hoverId && hoverId !== inspector?.id && !request && !showRecords) ? <div className={`node-sheet hover-panel ${hoverPlace.top ? 'top' : 'bottom'}`} style={{ height: hoverPlace.height }} aria-hidden="true">
          <NodeInspector key={`${session.id}:hover:${hoverId}`} session={session} nodeId={hoverId} mode="detail" busy={busy} editRevision={session.revision}
            onClose={() => setHoverId(null)} onEdit={() => { setHoverId(null); openInspector(hoverId, 'edit'); }} onSave={saveNode} onDelete={removeNode} onAdd={id => { setHoverId(null); openInspector(id, 'add'); }} onAskAi={askAi} onGenerateCases={generateCases} onRollback={rollback} loadArtifact={loadArtifact}
            onLocate={id => { setHoverId(null); locate(id); }} taskActions={hoverId === ACCEPT_ID ? taskActions : undefined} />
        </div> : inspector && <div className="node-page" role="dialog" aria-modal="true" aria-label="节点详情页"><NodeInspector key={`${session.id}:${inspector.id}:${inspector.mode}`} session={session} nodeId={inspector.id} mode={inspector.mode} busy={busy} editRevision={inspector.revision}
          onClose={() => { setInspector(undefined); setSelectedId(null); }} onEdit={() => openInspector(inspector.id, 'edit')} onSave={saveNode} onDelete={removeNode} onAdd={id => openInspector(id, 'add')} onAskAi={askAi} onGenerateCases={generateCases} onRollback={rollback} onSaveAgents={saveAgents} loadArtifact={loadArtifact} onLocate={locate}
          onRecords={() => { setInspector(undefined); setShowRecords(true); }} onResetPosition={id => setResetRequest({ id, key: Date.now() })}
          taskActions={inspector.mode === 'detail' && (inspector.id === TASK_ID || inspector.id === ACCEPT_ID) ? taskActions : undefined} /></div>}
        {request && <aside className="side-panel request-panel" aria-label={request.rework ? '返工要求' : 'AI 修改要求'}><div className="panel-head"><h2>{request.completed ? '修改要求已保存' : request.rework ? '要求返工' : '让 AI 修改'}</h2><button className="icon-btn" aria-label="关闭" onClick={() => setRequest(undefined)}>×</button></div>
          <p className="panel-status">范围：{request.target ? `${session.nodes.find(n => n.id === request.target)?.title ?? request.target} 及其下所有内容` : '整个任务'}</p>
          {request.completed ? <section className="continuation"><p>若宿主尚未继续，请把这段指令发送到当前对话。</p><textarea aria-label="发送到当前对话" readOnly value={continuation} rows={7} /></section> : <form onSubmit={e => { e.preventDefault(); void requestAi(); }}><label htmlFor="change-request">{request.rework ? '验收意见' : '说明如何修改执行树'}</label><textarea id="change-request" value={note} onChange={e => setNote(e.target.value)} required rows={6} />
            <p className="impact-note">要求会保存到当前任务并撤销整任务批准。Agent 更新计划后，需要重新批准。</p>
            {request.revision !== session.revision && <p role="alert">当前已有 v{session.revision}。草稿保留，旧版本提交将被拒绝；请复制要求并重新打开。</p>}
            <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => setRequest(undefined)}>取消</button><button type="submit" className="btn primary" disabled={busy || !note.trim()}>发送给 Agent</button></div>
          </form>}</aside>}
        {showRecords && <aside className="side-panel records-panel" aria-label="任务记录"><div className="panel-head"><h2>任务记录</h2><button className="icon-btn" aria-label="关闭" onClick={() => setShowRecords(false)}>×</button></div>
          <p>{session.goal}</p><details><summary>Agent（{session.agents.length}）</summary><ul>{session.agents.map(agent => <li key={agent.id}><strong>{agent.name}</strong><p>{agent.role}</p><dl><dt>范围</dt><dd>{agent.scope}</dd><dt>预算</dt><dd>{agent.budget}</dd><dt>实际位置</dt><dd>{active.filter(a => a.agentId === agent.id).map(a => <button key={a.id} onClick={() => locate(a.nodeId)}>{session.nodes.find(n => n.id === a.nodeId)?.title}</button>)}{!active.some(a => a.agentId === agent.id) && '当前无活跃执行'}</dd></dl></li>)}</ul></details>
          {!!session.context.length && <details><summary>上下文依据</summary><ul>{session.context.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
          {!!session.aiRequests.length && <details><summary>用户修改要求</summary><ul>{session.aiRequests.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
          {!!session.events.length && <details><summary>执行记录（{session.events.length}）</summary><ol className="event-list">{session.events.slice(-80).reverse().map(event => <li key={event.id}><div className="event-meta"><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> · v{event.revision} · {event.provenance === 'user_confirmed' ? '用户操作' : event.provenance === 'agent_reported' ? 'Agent 上报' : '执行树'}</div><p>{event.message}</p>{event.nodeId && <button onClick={() => locate(event.nodeId!)}>{session.nodes.find(n => n.id === event.nodeId)?.title || event.nodeId}</button>}</li>)}</ol></details>}
          {session.review && <details><summary>验收记录</summary><pre>{session.review.tree}</pre></details>}
        </aside>}
      </div>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Arborun />);
