import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSpec, NodeSpec, NodeState, Session, UserActionInput as UserAction } from '../mcp/schema';
import { TreeBridge, type ViewData } from './bridge';
import './styles.css';

const bridge = new TreeBridge();
const statusNames: Record<string, string> = {
  draft: '待批准', approved: '已批准', running: '执行中', paused: '已暂停', review: '待验收', accepted: '已验收',
  ready: '待执行', passed: '已通过', failed: '有问题', blocked: '受阻', skipped: '未触发', stale: '需重验',
};
const kindNames = { group: '分组', action: '执行步骤', condition: '条件判断', agent: 'Agent 分支' };
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
const specs = (nodes: NodeState[]): NodeSpec[] => nodes.map(({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, when, agentId }) =>
  ({ id, parentId, kind, title, action, target, input, acceptance, failure, dependsOn, ...(when ? { when } : {}), agentId }));

function Field({ label, value, onChange, multiline = false, required = false }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean;
}) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{multiline
    ? <textarea id={id} value={value} onChange={e => onChange(e.target.value)} rows={Math.min(5, Math.max(2, value.split('\n').length))} required={required} />
    : <input id={id} value={value} onChange={e => onChange(e.target.value)} required={required} />}</div>;
}

function NodeEditor({ node, nodes, agents, onSave, onCancel, busy }: {
  node: NodeSpec; nodes: NodeState[]; agents: AgentSpec[]; onSave: (node: NodeSpec) => Promise<void>; onCancel: () => void; busy: boolean;
}) {
  const [draft, setDraft] = useState(node);
  const [criteria, setCriteria] = useState(node.acceptance.join('\n'));
  const change = <K extends keyof NodeSpec>(key: K, value: NodeSpec[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const descendants = new Set([node.id]);
  for (let i = 0; i < nodes.length; i++) for (const n of nodes) if (n.parentId && descendants.has(n.parentId)) descendants.add(n.id);
  return <form className="node-editor" onSubmit={e => { e.preventDefault(); void onSave({ ...draft, acceptance: lines(criteria) }); }}>
    <Field label="节点标题" value={draft.title} onChange={v => change('title', v)} required />
    <div className="form-pair">
      <label className="field"><span>节点类型</span><select value={draft.kind} onChange={e => change('kind', e.target.value as NodeSpec['kind'])}>
        {Object.entries(kindNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      <label className="field"><span>执行 Agent</span><select value={draft.agentId} onChange={e => change('agentId', e.target.value)}>
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select></label>
    </div>
    <Field label="具体动作" value={draft.action} onChange={v => change('action', v)} multiline required={draft.kind !== 'group'} />
    <Field label="操作对象 / 文件位置" value={draft.target} onChange={v => change('target', v)} required={draft.kind !== 'group'} />
    <Field label="输入与依据" value={draft.input} onChange={v => change('input', v)} multiline required={draft.kind !== 'group'} />
    <Field label="通过条件（每行一项）" value={criteria} onChange={setCriteria} multiline required={draft.kind !== 'group'} />
    <Field label="不通过时如何处理" value={draft.failure} onChange={v => change('failure', v)} multiline required={draft.kind !== 'group'} />
    <label className="field"><span>父节点</span><select value={draft.parentId || ''} onChange={e => change('parentId', e.target.value || null)}>
      <option value="">无（根节点）</option>{nodes.filter(n => !descendants.has(n.id) && ['group', 'agent'].includes(n.kind)).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
    </select></label>
    <fieldset><legend>执行依赖</legend>{nodes.filter(n => n.id !== node.id && n.kind !== 'group').map(n =>
      <label className="check" key={n.id}><input type="checkbox" checked={draft.dependsOn.includes(n.id)} onChange={e => change('dependsOn', e.target.checked ? [...draft.dependsOn, n.id] : draft.dependsOn.filter(id => id !== n.id))} /><span>{n.title}</span></label>)}
    </fieldset>
    <div className="form-pair">
      <label className="field"><span>分支触发条件</span><select value={draft.when?.nodeId || ''} onChange={e => change('when', e.target.value ? { nodeId: e.target.value, outcome: draft.when?.outcome ?? true } : undefined)}>
        <option value="">无条件</option>{nodes.filter(n => n.kind === 'condition' && n.id !== node.id).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
      </select></label>
      {draft.when && <label className="field"><span>何时执行</span><select value={String(draft.when.outcome)} onChange={e => change('when', { ...draft.when!, outcome: e.target.value === 'true' })}><option value="true">条件成立</option><option value="false">条件不成立</option></select></label>}
    </div>
    <p className="muted">保存后生成新版本，受影响节点需要重新批准和检查；旧执行记录保留。</p>
    <div className="actions"><button type="submit" className="primary" disabled={busy}>保存节点</button><button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}

function TreeNode({ node, session, busy, editing, setEditing, saveNode, removeNode, addChild, askAi, selected, select }: {
  node: NodeState; session: Session; busy: boolean; editing: string | null; setEditing: (id: string | null) => void;
  saveNode: (node: NodeSpec) => Promise<void>; removeNode: (node: NodeState) => Promise<void>; addChild: (parent: NodeState) => void;
  askAi: (node: NodeState) => void; selected: string[]; select: (id: string, checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [details, setDetails] = useState(false);
  const children = session.nodes.filter(n => n.parentId === node.id);
  const agent = session.agents.find(a => a.id === node.agentId);
  const isEditing = editing === node.id;
  const nodeStatus = node.status === 'draft' && ['approved', 'running'].includes(session.status) ? '等待依赖' : statusNames[node.status];
  const nodeTitle = (id: string) => session.nodes.find(n => n.id === id)?.title || id;
  const visibleDetails = details || isEditing || node.status === 'failed' || node.status === 'blocked';
  return <li className={`tree-node kind-${node.kind} state-${node.status}`} id={`node-${node.id}`}>
    <div className="node-row">
      {children.length ? <button className="branch-toggle" aria-label={`${expanded ? '收起' : '展开'} ${node.title} 的子节点`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '⌄' : '›'}</button> : <span className="branch-leaf" aria-hidden="true">─</span>}
      <button className="node-title" aria-expanded={visibleDetails} onClick={() => setDetails(!details)}><span>{node.title}</span>
        {node.kind !== 'group' && <span className="node-meta">{kindNames[node.kind]}{agent ? ` · ${agent.name}` : ''}</span>}
      </button>
      {node.kind !== 'group' && <span className={`node-status ${node.status}`} aria-label={`${node.title}：${nodeStatus}`}>{node.status === 'running' && <span aria-hidden="true">↳ </span>}{nodeStatus || node.status}</span>}
      <button className="edit-button" disabled={busy} onClick={() => { setDetails(true); setEditing(node.id); }}>编辑</button>
    </div>
    {visibleDetails && <div className="node-detail">
      {isEditing ? <NodeEditor key={node.id} node={specs([node])[0]} nodes={session.nodes} agents={session.agents} onSave={saveNode} onCancel={() => setEditing(null)} busy={busy} /> : <>
        <dl className="specification">
          {node.action && <><dt>动作</dt><dd>{node.action}</dd></>}
          {node.target && <><dt>对象</dt><dd>{node.target}</dd></>}
          {node.input && <><dt>输入</dt><dd>{node.input}</dd></>}
          {!!node.acceptance.length && <><dt>通过条件</dt><dd><ul>{node.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul></dd></>}
          {node.failure && <><dt>未通过</dt><dd>{node.failure}</dd></>}
          {!!node.dependsOn.length && <><dt>执行依赖</dt><dd>{node.dependsOn.map(nodeTitle).join('；')}</dd></>}
          {node.when && <><dt>触发条件</dt><dd>「{nodeTitle(node.when.nodeId)}」{node.when.outcome ? '成立' : '不成立'}时执行</dd></>}
          {node.conditionOutcome !== undefined && <><dt>判断结果</dt><dd>{node.conditionOutcome === 'unknown' ? '未知，等待补充依据' : node.conditionOutcome ? '成立' : '不成立'}</dd></>}
        </dl>
        {node.result && <section className="node-result"><h3>{node.status === 'failed' || node.status === 'blocked' ? '问题' : '结果'}</h3><p>{node.result}</p>
          {!!node.evidence?.length && <ul className="evidence">{node.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        </section>}
        <div className="actions node-actions">{['group', 'agent'].includes(node.kind) && <button disabled={busy} onClick={() => addChild(node)}>添加子节点</button>}<button disabled={busy} onClick={() => askAi(node)}>让 AI 修改</button><button disabled={busy} onClick={() => void removeNode(node)}>删除节点</button></div>
        {session.attempts.some(a => a.nodeId === node.id) && <details className="attempt-history"><summary>历史执行</summary><ul>{session.attempts.filter(a => a.nodeId === node.id).map(attempt => <li key={attempt.id}><p>v{attempt.revision} · {session.agents.find(a => a.id === attempt.agentId)?.name || attempt.agentId} · {statusNames[attempt.status] || (attempt.status === 'interrupted' ? '已中断' : attempt.status)}{attempt.invalidated ? ' · 已失效' : ''}</p><p>{attempt.summary || '尚无结果'}</p>{attempt.checks.map((check, i) => <p key={i}>{check.passed ? '通过' : '未通过'}：{check.criterion} — {check.evidence}</p>)}</li>)}</ul></details>}
        {session.status === 'review' && node.kind !== 'group' && <label className="check review-select"><input type="checkbox" checked={selected.includes(node.id)} onChange={e => select(node.id, e.target.checked)} /><span>此节点需要返工</span></label>}
      </>}
    </div>}
    {expanded && !!children.length && <ul className="tree-children">{children.map(child => <TreeNode key={child.id} node={child} session={session} busy={busy} editing={editing} setEditing={setEditing} saveNode={saveNode} removeNode={removeNode} addChild={addChild} askAi={askAi} selected={selected} select={select} />)}</ul>}
  </li>;
}

function Arborun() {
  const [session, setSession] = useState<Session>();
  const [sessions, setSessions] = useState<ViewData['sessions']>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditingId] = useState<string | null>(null);
  const [newNode, setNewNode] = useState<NodeSpec>();
  const [aiTarget, setAiTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [continuation, setContinuation] = useState('');
  const sessionRef = useRef<string | undefined>(new URLSearchParams(location.hash.slice(1)).get('sessionId') || undefined);
  const refreshRef = useRef(false);
  const editRevision = useRef<number | undefined>(undefined);
  const setEditing = (id: string | null) => { setEditingId(id); editRevision.current = id ? session?.revision : undefined; };

  useEffect(() => {
    let alive = true;
    bridge.onData = data => {
      if (!alive) return;
      if (data.sessions) setSessions(data.sessions);
      if (data.session) { sessionRef.current = data.session.id; setSession(data.session); }
    };
    bridge.onError = message => { if (alive) setError(message); };
    const refresh = async () => {
      if (refreshRef.current || !alive) return;
      refreshRef.current = true;
      try { await bridge.read(sessionRef.current); if (alive) setNetworkError(''); }
      catch (err) { if (alive) setNetworkError(err instanceof Error ? err.message : '连接失败'); }
      finally { refreshRef.current = false; }
    };
    void bridge.connect().then(async () => { if (!alive) return; setConnected(true); await refresh(); }).catch(err => { if (alive) setNetworkError(String(err.message || err)); });
    const timer = window.setInterval(() => { if (!document.hidden && connectedRef.current) void refresh(); }, 1800);
    return () => { alive = false; clearInterval(timer); bridge.onData = undefined; bridge.onError = undefined; };
  }, []);
  const connectedRef = useRef(false);
  connectedRef.current = connected;

  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作未完成'); }
    finally { setBusy(false); }
  };
  const act = (action: Omit<UserAction, 'sessionId' | 'expectedRevision'>) => {
    if (!session) throw new Error('没有打开的执行树');
    return bridge.act({ ...action, sessionId: session.id, expectedRevision: session.revision } as UserAction);
  };
  const signalHost = async (message: string) => {
    const sent = await bridge.notify(message);
    setContinuation(sent === 'sent' ? '' : message);
    setNotice(sent === 'sent' ? '已请求宿主 Agent 继续。' : sent === 'composed' ? '已交给宿主；若指令停留在输入框，请点击发送。' : '已保存。宿主未提供消息接续，请将下方指令发送到当前对话。');
  };
  const saveNode = (node: NodeSpec) => perform(async () => {
    if (!session) return;
    const next = specs(session.nodes).map(n => n.id === node.id ? node : n);
    if (!next.some(n => n.id === node.id)) next.push(node);
    await bridge.act({ type: 'edit', sessionId: session.id, expectedRevision: editRevision.current ?? session.revision, nodes: next });
    setEditing(null); setNewNode(undefined); setNotice('已保存新版本，执行前需要重新批准。');
  });
  const removeNode = (node: NodeState) => perform(async () => {
    if (!session) return;
    if (session.nodes.some(n => n.parentId === node.id)) throw new Error('请先移动或删除子节点，再删除此节点。');
    if (session.nodes.some(n => n.dependsOn.includes(node.id) || n.when?.nodeId === node.id)) throw new Error('其他节点仍依赖此节点，请先调整依赖和条件。');
    await act({ type: 'edit', nodes: specs(session.nodes).filter(n => n.id !== node.id) } as UserAction);
    setNotice('节点已删除，旧执行记录保留。');
  });
  const addChild = (parent: NodeState) => {
    setNewNode({ id: `node-${crypto.randomUUID().slice(0, 8)}`, parentId: parent.id, kind: 'action', title: '', action: '', target: '', input: '', acceptance: [], failure: '', dependsOn: [], agentId: parent.agentId || session?.agents[0]?.id || '' });
    setEditing(null);
    editRevision.current = session?.revision;
  };
  const requestAi = () => perform(async () => {
    if (!session || !note.trim()) return;
    const target = aiTarget ? session.nodes.find(n => n.id === aiTarget) : undefined;
    const message = `${target ? `修改节点「${target.title}」（${target.id}）：` : ''}${note.trim()}`;
    await act({ type: 'requestAi', message } as UserAction);
    await signalHost(`请读取 Arborun 执行树 ${session.id}，根据用户修改要求更新计划：${message}。更新后等待用户在树中批准，勿提前执行。`);
    setAiTarget(null); setNote('');
  });
  const taskNodes = session?.nodes.filter(n => n.kind !== 'group') || [];
  const active = taskNodes.filter(n => n.status === 'running');
  const complete = taskNodes.filter(n => n.status === 'passed').length;
  const problems = taskNodes.filter(n => ['failed', 'blocked'].includes(n.status));

  return <main>
    <header className="app-header"><h1>Arborun</h1>{!!sessions?.length && sessions.length > 1 && <select aria-label="选择执行树" value={session?.id || ''} onChange={e => { sessionRef.current = e.target.value; setEditing(null); setNewNode(undefined); void perform(() => bridge.read(e.target.value)); }}><option value="" disabled>选择执行树</option>{sessions.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select>}
      <button className="text-button" disabled={!connected || busy} onClick={() => void perform(() => bridge.read(sessionRef.current))}>刷新</button></header>
    {(error || networkError) && <div className="message error" role="alert">{error || networkError}</div>}
    {notice && <div className="message" role="status">{notice}</div>}
    {continuation && <div className="continuation"><div className="field"><label htmlFor="continuation-message">发送到当前对话</label><textarea id="continuation-message" readOnly value={continuation} rows={3} /></div><div className="actions"><button onClick={() => void navigator.clipboard.writeText(continuation).then(() => setNotice('指令已复制。')).catch(() => setNotice('请选择上方指令并复制。'))}>复制指令</button><button onClick={() => { setContinuation(''); setNotice(''); }}>收起提示</button></div></div>}
    {!session ? <section className="empty"><h2>{connected ? '等待决策执行树' : '连接执行树'}</h2><p>{connected ? '向当前 Agent 说明任务，让它结合上下文生成 Arborun 执行树。计划会出现在这里，批准前不会领取执行节点。' : '正在连接 MCP 服务。'}</p>{!!sessions?.length && <ul>{sessions.map(s => <li key={s.id}><button onClick={() => void perform(() => bridge.read(s.id))}>{s.title}</button></li>)}</ul>}</section> : <>
      <section className="task-header"><div className="task-heading"><h2>{session.title}</h2><span className="task-status">{statusNames[session.status]} · v{session.revision}</span></div>
        {session.goal && <p className="goal">{session.goal}</p>}
        <div className="progress-line" aria-live="polite"><span>{complete} / {taskNodes.length} 已通过</span>{active.length > 0 && <span>{active.length} 正在执行</span>}{problems.length > 0 && <span className="problem-text">{problems.length} 个问题</span>}</div>
        <div className="actions">
          {['draft', 'paused'].includes(session.status) && <button className="primary" disabled={busy || !!editing || !!newNode} onClick={() => void perform(async () => { await act({ type: 'approve' }); await signalHost(`用户已批准 Arborun 执行树 ${session.id} 的 v${session.revision}。请重新读取最新状态，逐节点领取并执行，持续上报 Agent 位置、结果和问题；全部完成后提交验收树。`); })}>批准 v{session.revision} 并执行</button>}
          {['running', 'approved'].includes(session.status) && <button disabled={busy} onClick={() => void perform(async () => { await act({ type: 'pause' }); await signalHost(`用户已暂停 Arborun 执行树 ${session.id}。请停止领取新节点，在安全边界停止当前动作并读取最新状态。`); })}>暂停执行</button>}
          {session.status === 'review' && <button className="primary" disabled={busy || !!editing} onClick={() => void perform(async () => { await act({ type: 'accept' }); setNotice('验收已记录。'); })}>验收通过</button>}
          <button disabled={busy} onClick={() => { setAiTarget(''); setNote(''); }}>让 AI 修改树</button>
        </div>
        {session.status === 'paused' && <p className="muted">执行许可已撤销；宿主已经发出的外部操作仍需由 Agent 在安全边界停止。</p>}
      </section>
      {aiTarget !== null && <form className="request-editor" onSubmit={e => { e.preventDefault(); void requestAi(); }}>
        <Field label={aiTarget ? `修改「${session.nodes.find(n => n.id === aiTarget)?.title || aiTarget}」` : '说明如何修改执行树'} value={note} onChange={setNote} multiline required />
        <div className="actions"><button type="submit" className="primary" disabled={busy || !note.trim()}>发送修改要求</button><button type="button" disabled={busy} onClick={() => { setAiTarget(null); setNote(''); }}>取消</button></div>
      </form>}
      <ul className="execution-tree" aria-label="决策执行树">{session.nodes.filter(n => !n.parentId).map(node => <TreeNode key={node.id} node={node} session={session} busy={busy} editing={editing} setEditing={setEditing} saveNode={saveNode} removeNode={removeNode} addChild={addChild} askAi={n => { setAiTarget(n.id); setNote(''); }} selected={selected} select={(id, checked) => setSelected(prev => checked ? [...prev, id] : prev.filter(value => value !== id))} />)}</ul>
      {newNode && <section className="new-node"><h3>添加到「{session.nodes.find(n => n.id === newNode.parentId)?.title}」</h3><NodeEditor node={newNode} nodes={session.nodes} agents={session.agents} onSave={saveNode} onCancel={() => setNewNode(undefined)} busy={busy} /></section>}
      {session.status === 'review' && <form className="review-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const names = selected.map(id => session.nodes.find(n => n.id === id)?.title || id);
        const message = `${names.length ? `需返工节点：${names.join('；')}。` : ''}${note.trim()}`;
        await act({ type: 'requestChanges', message } as UserAction); await signalHost(`用户退回 Arborun 验收树 ${session.id}：${message}。请修改计划并等待重新批准。`); setNote(''); setSelected([]);
      }); }}><Field label="验收意见" value={note} onChange={setNote} multiline required /><div className="actions"><button disabled={busy || !note.trim()} type="submit">退回修改{selected.length ? `（${selected.length} 个节点）` : ''}</button></div></form>}
      <div className="supporting-tree">
        <details><summary>Agent（{session.agents.length}）</summary><ul>{session.agents.map(agent => <li key={agent.id}><strong>{agent.name}</strong> · {agent.role}<dl><dt>范围</dt><dd>{agent.scope}</dd><dt>预算</dt><dd>{agent.budget}</dd><dt>当前位置</dt><dd>{active.filter(n => n.agentId === agent.id).map(n => n.title).join('；') || '未在执行节点'}</dd></dl></li>)}</ul></details>
        {!!session.context.length && <details><summary>上下文依据</summary><ul>{session.context.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
        {!!session.aiRequests.length && <details><summary>用户修改要求</summary><ul>{session.aiRequests.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
        {session.review && <details open={session.status === 'accepted'}><summary>验收树</summary><pre>{session.review.tree}</pre></details>}
        {!!session.events.length && <details><summary>执行记录（{session.events.length}）</summary><ol className="event-list">{session.events.slice(-60).reverse().map(event => <li key={event.id}><div className="event-meta"><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>v{event.revision} · {event.provenance === 'user_confirmed' ? '用户操作' : event.provenance === 'agent_reported' ? 'Agent 上报' : '执行树'}</span></div><p>{event.message}</p>{event.nodeId && <button className="event-link" onClick={() => document.getElementById(`node-${event.nodeId}`)?.scrollIntoView({ block: 'center' })}>{session.nodes.find(n => n.id === event.nodeId)?.title || event.nodeId}</button>}</li>)}</ol></details>}
      </div>
      <footer>执行位置、结果与证据来自宿主 Agent 上报。{bridge.local ? '当前为本地预览界面。' : ''}</footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Arborun />);
