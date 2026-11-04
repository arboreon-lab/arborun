import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, ChevronRight, Circle, CircleAlert, Clock3, Code2, CornerDownRight,
  FileCheck2, FileText, FolderOpen, GitBranch, GitFork, History, Layers3,
  LoaderCircle, MoreHorizontal, Pause, Play, Plus, RotateCcw, Save, Search,
  Settings2, ShieldCheck, Square, Trash2, Workflow, X,
} from 'lucide-react';
import type { AppState, Artifact, Command, ModelConfig, NodePatch, NodeStatus, PublicModelConfig, Task, TreeNode } from '../shared/types';
import './styles.css';

type View = 'plan' | 'execution' | 'results';
type DetailTab = 'content' | 'history' | 'artifacts';
type Toast = { message: string; error: boolean };

const nodeLabels: Record<NodeStatus, string> = {
  draft: '待确认', ready: '待执行', running: '执行中', waiting: '等待处理', passed: '已通过',
  failed: '失败', skipped: '未启用', stale: '待更新', cancelled: '已取消',
};
const taskLabels: Record<Task['status'], string> = {
  draft: '计划草稿', planning: '整理计划中', approved: '已确认', running: '执行中', paused: '已暂停',
  waiting: '等待决策', completed: '执行完成', cancelled: '已取消', failed: '执行失败', interrupted: '运行已中断',
};
const kindLabels: Record<TreeNode['kind'], string> = {
  group: '任务', task: '执行步骤', condition: '条件判断', decision: '用户决策', agent: '子 Agent', artifact: '交付',
};
const kindIcons = { group: GitBranch, task: FileText, condition: GitFork, decision: CircleAlert, agent: Workflow, artifact: FileCheck2 };
const clock = (date: string) => new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const asTree = (text: string) => /[├└]─/.test(text) ? text : `内容\n${text.split('\n').filter(Boolean).map((line, index, lines) => `${index === lines.length - 1 ? '└' : '├'}─ ${line}`).join('\n')}`;

function BrandMark({ size = 28 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 27V8M16 19L7 11M16 22L25 14M16 13L23 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="16" cy="6" r="2.5" fill="currentColor"/><circle cx="6" cy="10" r="2.5" fill="currentColor"/><circle cx="26" cy="13" r="2.5" fill="currentColor"/><circle cx="24" cy="5" r="2.5" fill="currentColor"/><path d="M11 28h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
}

function StatusIcon({ status, size = 15 }: { status: NodeStatus; size?: number }) {
  if (status === 'running') return <LoaderCircle size={size} className="spin"/>;
  if (status === 'passed') return <Check size={size}/>;
  if (status === 'failed') return <CircleAlert size={size}/>;
  if (status === 'waiting') return <Pause size={size}/>;
  if (status === 'stale') return <RotateCcw size={size}/>;
  if (status === 'cancelled' || status === 'skipped') return <span className="status-dash">—</span>;
  return <Circle size={size} strokeWidth={1.2}/>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]') ?? []);
    const firstInput = focusable().find(element => element.tagName === 'INPUT' || element.tagName === 'TEXTAREA');
    (firstInput ?? focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={19}/></button></div>
      {children}
    </div>
  </div>;
}

function App() {
  const bridge = window.arborun;
  const [state, setState] = useState<AppState | null>(null);
  const [initialError, setInitialError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('plan');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'new' | 'model' | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [model, setModel] = useState<PublicModelConfig | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('content');
  const [showSources, setShowSources] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const closeModal = useCallback(() => setModal(null), []);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.getState().then(value => { if (live) setState(value); }).catch(error => setInitialError(String(error.message || error)));
    bridge.modelConfig().then(value => { if (live) setModel(value); }).catch(() => {});
    const unsubscribe = bridge.onState(value => { if (live) setState(value); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);

  const task = state?.tasks.find(item => item.id === state.activeTaskId) ?? state?.tasks[0];
  const selected = task?.nodes.find(node => node.id === selectedId) ?? task?.nodes[0];
  useEffect(() => { setSelectedId(null); setCollapsed(new Set()); setView('plan'); setDetailTab('content'); setShowSources(false); setShowApproval(false); }, [task?.id]);
  useEffect(() => { if (!toast || toast.error) return; const timeout = setTimeout(() => setToast(null), 7000); return () => clearTimeout(timeout); }, [toast]);

  const execute = useCallback(async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'schemaVersion' in result) setState(result as AppState);
      if (success) setToast({ message: success, error: false });
      return true;
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : String(error), error: true });
      return false;
    } finally { setBusy(false); }
  }, []);
  const dispatch = useCallback((command: Command, success?: string) => execute(() => bridge.command(command), success), [execute, bridge]);
  const toggle = (id: string) => setCollapsed(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const visibleNodes = useMemo(() => {
    if (!task) return [];
    const rows: { node: TreeNode; depth: number; hasChildren: boolean }[] = [];
    const seen = new Set<string>();
    const visit = (parentId: string | null, depth: number) => {
      for (const node of task.nodes.filter(item => item.parentId === parentId)) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const hasChildren = task.nodes.some(item => item.parentId === node.id);
        const matches = !search || `${node.title} ${node.action} ${node.target}`.toLowerCase().includes(search.toLowerCase());
        if (matches) rows.push({ node, depth: search ? 0 : depth, hasChildren });
        if (!collapsed.has(node.id) || search) visit(node.id, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
  }, [task, collapsed, search]);

  function treeKey(event: React.KeyboardEvent, node: TreeNode, hasChildren: boolean) {
    if ((event.target as HTMLElement).closest('input, textarea, select')) return;
    const index = visibleNodes.findIndex(row => row.node.id === node.id);
    const focus = (id?: string) => { if (id) { setSelectedId(id); document.getElementById(`node-${id}`)?.focus(); } };
    if (event.key === 'ArrowDown') { event.preventDefault(); focus(visibleNodes[index + 1]?.node.id); }
    if (event.key === 'ArrowUp') { event.preventDefault(); focus(visibleNodes[index - 1]?.node.id); }
    if (event.key === 'ArrowRight' && hasChildren) { event.preventDefault(); if (collapsed.has(node.id)) toggle(node.id); else focus(visibleNodes[index + 1]?.node.id); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if (hasChildren && !collapsed.has(node.id)) toggle(node.id); else focus(node.parentId ?? undefined); }
    if (event.key === 'Home') { event.preventDefault(); focus(visibleNodes[0]?.node.id); }
    if (event.key === 'End') { event.preventDefault(); focus(visibleNodes.at(-1)?.node.id); }
  }

  async function approveAndRun() {
    if (!task) return;
    const ok = await execute(async () => {
      await bridge.command({ type: 'approve', taskId: task.id });
      return bridge.command({ type: 'run', taskId: task.id });
    });
    if (ok) { setShowApproval(false); setView('execution'); }
  }

  const needApproval = task && (!task.approval || task.approval.revision !== task.revision);
  const running = task?.status === 'running' || task?.status === 'planning';
  const executable = task?.nodes.filter(node => node.kind !== 'group' && node.enabled) ?? [];
  const complete = executable.filter(node => node.status === 'passed').length;
  const pending = task?.nodes.filter(node => node.status === 'waiting' || node.status === 'failed') ?? [];
  const latest = task?.events.at(-1);

  if (!bridge) return <div className="standalone-message"><BrandMark size={46}/><h1>Arborun</h1><p>请在桌面应用中打开</p><p className="muted">任务执行、资料访问和本地保存由桌面运行时提供。</p><code>pnpm build &amp;&amp; pnpm start</code></div>;
  if (!state) return <div className="standalone-message"><BrandMark size={46}/><h1>Arborun</h1>{initialError ? <><p role="alert">{initialError}</p><button className="button" onClick={() => window.location.reload()}>重试</button></> : <><LoaderCircle size={18} className="spin"/><p>正在打开工作区</p></>}</div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><BrandMark/><span>Arborun</span></div>
      <button className="new-task-button" onClick={() => setModal('new')}><Plus size={17}/><span>新建任务</span><span className="button-hint">＋</span></button>
      <div className="sidebar-section-title"><span>工作区</span><span className="tiny-dot"/></div>
      <nav className="task-list" aria-label="任务列表">
        {state.tasks.map(item => <button key={item.id} className={`task-link ${task?.id === item.id ? 'active' : ''}`} onClick={() => dispatch({ type: 'select', taskId: item.id })}>
          <GitBranch size={16}/><span>{item.title}</span>{item.status === 'running' && <span className="live-dot"/>}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="sidebar-control" onClick={() => setModal('model')}><Settings2 size={16}/><span>模型连接</span><span className={`connection-dot ${model?.hasKey ? 'connected' : ''}`}/></button>
        <div className="lab-signature"><span>Arboreon Lab</span><span>v0.1</span></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="workspace-header">
        <div className="breadcrumb"><span>工作区</span><ChevronRight size={13}/><span>{task?.title ?? '新任务'}</span></div>
        <div className="header-actions"><span className="local-label"><span className="tiny-dot"/> 本地工作区</span>{task && <button data-testid="export-task" className="button button-quiet small" disabled={busy} onClick={() => execute(async () => { const path = await bridge.exportTask(task.id); if (path) setToast({ message: `已导出到 ${path}`, error: false }); })}><ArrowDownToLine size={15}/>导出</button>}</div>
      </header>
      {task ? <>
        <section className="task-heading">
          <div className="task-heading-main"><div className="task-eyebrow"><span className={`task-state ${running ? 'active' : ''}`}>{running && <span className="live-dot"/>}{taskLabels[task.status]}</span><span className="divider-dot">·</span><span>计划 v{task.revision}</span><span className="divider-dot">·</span><span className="mode-label">{task.mode === 'demo' ? '演示任务 · 无模型调用' : '模型任务'}</span></div><h1>{task.title}</h1><p className="task-prompt" title={task.prompt}>{task.prompt}</p></div>
          <div className="primary-actions">
            {running ? <><button data-testid="pause-run" className="button" disabled={busy} onClick={() => dispatch({ type: 'pause', taskId: task.id })}><Pause size={15}/>暂停</button><button data-testid="cancel-run" className="icon-button bordered" aria-label="取消执行" title="取消执行" disabled={busy} onClick={() => dispatch({ type: 'cancel', taskId: task.id })}><Square size={14}/></button></> : task.status === 'completed' ? <span className="complete-label"><CheckCheck size={18}/>执行完成</span> : task.nodes.length === 0 ? <button className="button button-primary" disabled={busy} onClick={() => dispatch({ type: 'plan', taskId: task.id })}><GitBranch size={16}/>生成计划</button> : needApproval ? <button data-testid="review-run" className="button button-primary" disabled={busy} onClick={() => setShowApproval(true)}><Play size={15}/>确认并运行</button> : task.status === 'waiting' ? <button className="button button-attention" onClick={() => { const node = pending[0]; if (node) { setSelectedId(node.id); setDetailTab('content'); } }}><CircleAlert size={15}/>{pending[0]?.kind === 'decision' ? '处理待决策节点' : '查看等待原因'}</button> : task.status === 'failed' || task.status === 'cancelled' ? <button className="button" onClick={() => { const node = task.nodes.find(item => item.status === 'failed' || item.status === 'cancelled'); if (node) { setSelectedId(node.id); setDetailTab('content'); } }}><RotateCcw size={15}/>选择节点重试</button> : <button data-testid="resume-run" className="button button-primary" disabled={busy} onClick={() => { dispatch({ type: 'run', taskId: task.id }); setView('execution'); }}><Play size={15}/>{task.status === 'approved' ? '开始执行' : '继续执行'}</button>}
          </div>
        </section>

        <div className="workspace-body">
          <main className="tree-pane">
            <div className="tree-toolbar"><div className="view-tabs" role="tablist" aria-label="任务视图">{([{ id: 'plan', label: '规划', icon: GitBranch }, { id: 'execution', label: '执行', icon: Play }, { id: 'results', label: '结果', icon: FileCheck2 }] as const).map(item => <button key={item.id} role="tab" aria-selected={view === item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><item.icon size={15}/>{item.label}</button>)}</div><button className={`button button-quiet small ${showSources ? 'active' : ''}`} onClick={() => setShowSources(!showSources)}><FolderOpen size={15}/>资料 {task.sources.length}</button></div>
            {showSources && <div className="source-panel"><div className="section-caption"><span>本次任务的资料快照</span><button className="text-button" disabled={busy || running} onClick={() => execute(() => bridge.importSources(task.id))}><Plus size={14}/>导入资料</button></div>{task.mode === 'model' && task.nodes.length > 0 && <button className="text-button replan-button" disabled={busy || running} onClick={() => dispatch({ type: 'plan', taskId: task.id })}><GitBranch size={14}/>根据当前资料重新生成计划</button>}{task.sources.length ? task.sources.map(source => <details key={source.id} className="source-item"><summary><FileText size={14}/><span>{source.name}</span><span className="muted">{Math.ceil(source.content.length / 1024) || 1} KB</span></summary><pre>{source.content}</pre></details>) : <p className="empty-inline">选择 TXT、Markdown 或 JSON 文件作为任务输入。</p>}</div>}
            {task.lastError && <div className="inline-alert" role="alert"><CircleAlert size={16}/><span>{task.lastError}</span></div>}
            {view === 'results' ? <div className="results-view"><div className="section-caption"><span>交付产物</span><span>{task.artifacts.filter(item => item.adopted).length} 份已采用</span></div>{task.artifacts.length ? [...task.artifacts].reverse().map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} task={task} onLocate={() => { setSelectedId(artifact.nodeId); setView('execution'); setDetailTab('artifacts'); }}/>) : <div className="empty-state"><FileCheck2 size={30}/><h3>产物将在这里汇集</h3><p>执行完成的文件会关联回对应节点。</p><button className="button button-quiet" onClick={() => setView('plan')}>查看执行计划<ArrowRight size={15}/></button></div>}</div> : <>
              <div className="tree-meta"><span>{view === 'plan' ? '执行计划' : '执行树'}<span className="meta-count">{executable.length} 个步骤</span></span><label className="tree-search"><Search size={13}/><input aria-label="查找节点" value={search} onChange={event => setSearch(event.target.value)} placeholder="查找节点"/></label></div>
              <div className="tree-scroll" role="tree" aria-label="执行计划树">
                {visibleNodes.map(({ node, depth, hasChildren }) => <TreeRow key={node.id} node={node} depth={depth} hasChildren={hasChildren} expanded={!collapsed.has(node.id)} selected={selected?.id === node.id} view={view} onSelect={() => { setSelectedId(node.id); }} onToggle={() => toggle(node.id)} onKeyDown={event => treeKey(event, node, hasChildren)} onRename={title => dispatch({ type: 'edit', taskId: task.id, nodeId: node.id, patch: { title } })}/>)}
                {!visibleNodes.length && <div className="empty-state"><GitBranch size={30}/><h3>{search ? '没有匹配的节点' : '从意图长出执行计划'}</h3><p>{search ? '尝试其他名称、动作或操作对象。' : '导入资料后生成计划，或直接添加第一步。'}</p>{!search && <button className="button" disabled={busy} onClick={() => dispatch({ type: 'plan', taskId: task.id })}><GitBranch size={15}/>生成计划</button>}</div>}
                {!search && <button className="add-step" disabled={busy} onClick={() => dispatch({ type: 'add', taskId: task.id, parentId: task.nodes.find(node => node.kind === 'group' && !node.parentId)?.id ?? null })}><Plus size={15}/>添加步骤</button>}
              </div>
              {pending.length > 0 && <button className="pending-strip" onClick={() => { setSelectedId(pending[0].id); setDetailTab('content'); }}><CircleAlert size={16}/><span>{pending.length} 个节点需要处理</span><span className="pending-title">{pending[0].title}</span><ArrowRight size={15}/></button>}
            </>}
            <footer className="execution-footer"><div className="execution-summary"><span className={`footer-state ${running ? 'running' : ''}`}>{running ? <LoaderCircle size={14} className="spin"/> : <GitBranch size={14}/>}<span>{complete}/{executable.length} 已通过</span></span><span className="budget">模型调用 {task.budget.usedCalls}/{task.budget.maxCalls}<span>·</span>工具步骤 {task.budget.usedSteps}/{task.budget.maxSteps}</span></div>{latest && <button className="latest-event" onClick={() => { if (latest.nodeId) setSelectedId(latest.nodeId); setDetailTab('history'); }}><span>{clock(latest.at)}</span><span>{latest.message}</span><ChevronRight size={12}/></button>}</footer>
          </main>

          <aside className="inspector" aria-label="节点详情">
            {selected ? <NodeInspector key={`${task.id}:${selected.id}`} task={task} node={selected} tab={detailTab} onTab={setDetailTab} busy={busy} onEdit={patch => dispatch({ type: 'edit', taskId: task.id, nodeId: selected.id, patch }, '节点修改已应用，请确认新版本后继续')} onCommand={command => dispatch(command)} onSelect={setSelectedId}/> : <div className="empty-state"><CornerDownRight size={25}/><p>选择节点查看具体动作与完成条件</p></div>}
          </aside>
        </div>
      </> : <div className="empty-workspace"><BrandMark size={48}/><h1>把意图变成可执行的树</h1><p>创建任务，逐步检查、调整和引导执行。</p><button className="button button-primary" onClick={() => setModal('new')}><Plus size={16}/>新建任务</button></div>}
    </div>

    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={17}/> : <Check size={17}/>}<span>{toast.message}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={15}/></button></div>}
    {modal === 'new' && <NewTaskModal onClose={closeModal} busy={busy} hasModel={!!model?.model} onCreate={async (prompt, mode, title) => { if (await dispatch({ type: 'create', prompt, mode, title: title || prompt.slice(0, 28) })) setModal(null); }}/>}
    {modal === 'model' && <ModelModal onClose={closeModal} current={model} busy={busy} onSave={async config => { const ok = await execute(async () => { const value = await bridge.saveModelConfig(config); setModel(value); }, '模型连接已保存'); if (ok) setModal(null); }}/>}
    {showApproval && task && <Modal title="确认本次执行" subtitle={`计划 v${task.revision} · ${task.title}`} onClose={() => setShowApproval(false)}><div className="approval-tree"><div><ShieldCheck size={17}/><strong>本次执行范围</strong></div><ul><li>只读本次选定的 {task.sources.length} 份资料</li><li>在任务产物中生成新文件版本</li><li>最多 {task.budget.maxCalls} 次模型调用、{task.budget.maxSteps} 次工具步骤</li><li>{task.nodes.some(node => node.enabled && node.kind === 'agent') ? '允许一层子 Agent，使用同一份任务预算' : '本计划未授权子 Agent 派生'}</li></ul></div>{task.mode === 'demo' && <p className="form-note">演示任务使用固定执行器，不调用远端模型。</p>}<div className="modal-footer"><button className="button" onClick={() => setShowApproval(false)}>继续编辑</button><button data-testid="approve-run" className="button button-primary" disabled={busy} onClick={approveAndRun}><Play size={15}/>确认并运行</button></div></Modal>}
  </div>;
}

function TreeRow({ node, depth, hasChildren, expanded, selected, view, onSelect, onToggle, onKeyDown, onRename }: {
  node: TreeNode; depth: number; hasChildren: boolean; expanded: boolean; selected: boolean; view: View;
  onSelect: () => void; onToggle: () => void; onKeyDown: (event: React.KeyboardEvent) => void; onRename: (title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  useEffect(() => { if (!editing) setTitle(node.title); }, [node.title, editing]);
  const Icon = kindIcons[node.kind];
  const commit = async () => { const value = title.trim(); if (value && value !== node.title) await onRename(value); setEditing(false); };
  const summary = view === 'execution' && node.result ? node.result.split('\n').find(line => line.trim()) : node.action || node.description;
  return <div id={`node-${node.id}`} data-testid={`tree-node-${node.id}`} data-node-id={node.id} className={`tree-row ${selected ? 'selected' : ''} kind-${node.kind} status-${node.status} ${!node.enabled ? 'disabled-node' : ''}`} role="treeitem" aria-level={depth + 1} aria-selected={selected} aria-expanded={hasChildren ? expanded : undefined} tabIndex={selected ? 0 : -1} style={{ '--depth': depth } as React.CSSProperties} onClick={onSelect} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); setEditing(true); } onKeyDown(event); }}>
    {depth > 0 && <span className="tree-connector"/>}
    <button className={`tree-expander ${hasChildren ? '' : 'invisible'}`} tabIndex={-1} aria-label={expanded ? '收起子节点' : '展开子节点'} onClick={event => { event.stopPropagation(); onToggle(); }}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
    <span className={`node-kind-icon ${node.kind}`}><Icon size={17} strokeWidth={1.6}/></span>
    <div className="node-main">{editing ? <input className="node-rename" aria-label="编辑节点名称" autoFocus value={title} onChange={event => setTitle(event.target.value)} onClick={event => event.stopPropagation()} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); setTitle(node.title); setEditing(false); } }}/>: <span className="node-title" onDoubleClick={event => { event.stopPropagation(); setEditing(true); }}>{node.title}</span>}{summary && <span className="node-summary">{summary}</span>}</div>
    <span className={`node-status ${node.status}`}><StatusIcon status={node.status}/><span>{!node.enabled ? '未启用' : nodeLabels[node.status]}</span></span>
  </div>;
}

function ArtifactCard({ artifact, task, onLocate }: { artifact: Artifact; task: Task; onLocate?: () => void }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="artifact-card"><div className="artifact-header"><button className="artifact-name" onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<FileText size={16}/><strong>{artifact.name}</strong></button><span className="artifact-version">v{artifact.version} · {artifact.adopted ? '已采用' : '待采用'}</span></div>{expanded && <pre className="tree-output">{asTree(artifact.content)}</pre>}<div className="artifact-source"><span>来源：{task.nodes.find(node => node.id === artifact.nodeId)?.title ?? artifact.nodeId}</span>{onLocate && <button className="icon-button" aria-label="定位产物来源节点" onClick={onLocate}><ArrowUpRight size={14}/></button>}</div></section>;
}

function NodeInspector({ task, node, tab, onTab, busy, onEdit, onCommand, onSelect }: {
  task: Task; node: TreeNode; tab: DetailTab; onTab: (tab: DetailTab) => void; busy: boolean;
  onEdit: (patch: NodePatch) => Promise<boolean>; onCommand: (command: Command) => Promise<boolean>; onSelect: (id: string) => void;
}) {
  const makeDraft = () => ({ title: node.title, description: node.description, action: node.action, target: node.target, acceptance: node.acceptance.join('\n'), dependencies: [...node.dependencies], choices: (node.choices ?? []).join('\n'), parentId: node.parentId, enabled: node.enabled });
  const [draft, setDraft] = useState(makeDraft);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (!dirty) setDraft(makeDraft()); }, [node.title, node.description, node.action, node.target, node.acceptance.join('\n'), node.dependencies.join(','), node.enabled, node.parentId, node.choices?.join('\n')]);
  const update = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); };
  const events = task.events.filter(event => event.nodeId === node.id || (!event.nodeId && node.kind === 'group'));
  const artifacts = task.artifacts.filter(artifact => artifact.nodeId === node.id || node.kind === 'group');
  const attempts = task.attempts.filter(attempt => attempt.nodeId === node.id);
  const extension = node as TreeNode & { conditionResult?: 'true' | 'false' | 'unknown'; runIf?: { nodeId: string; outcome: 'true' | 'false' } };
  const parentOptions = task.nodes.filter(candidate => {
    if (candidate.id === node.id) return false;
    const seen = new Set<string>();
    let parent = candidate.parentId;
    while (parent && !seen.has(parent)) { if (parent === node.id) return false; seen.add(parent); parent = task.nodes.find(item => item.id === parent)?.parentId ?? null; }
    return true;
  });
  const save = async () => {
    const { choices, acceptance, ...fields } = draft;
    const patch: NodePatch = { ...fields, title: draft.title.trim(), acceptance: acceptance.split('\n').map(value => value.trim()).filter(Boolean) };
    if (node.kind === 'decision') patch.choices = choices.split('\n').map(value => value.trim()).filter(Boolean);
    if (await onEdit(patch)) setDirty(false);
  };
  const Icon = kindIcons[node.kind];
  return <><div className="inspector-header"><div className="inspector-kicker"><Icon size={15}/><span>{kindLabels[node.kind]}</span><span className={`node-status ${node.status}`}><StatusIcon status={node.status}/>{nodeLabels[node.status]}</span></div><h2>{node.title}</h2><div className="inspector-tabs" role="tablist" aria-label="节点详情视图">{([{ id: 'content', title: '内容' }, { id: 'history', title: '记录', count: events.length }, { id: 'artifacts', title: '产物', count: artifacts.length }] as const).map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => onTab(item.id)}>{item.title}{'count' in item && item.count > 0 && <span>{item.count}</span>}</button>)}</div></div>
    <div className="inspector-scroll">
      {tab === 'content' ? <>
        {node.kind === 'decision' && node.status === 'waiting' && <div className="decision-box"><div className="section-caption"><span><CircleAlert size={15}/>需要你的选择</span></div>{node.result && <pre className="tree-output">{asTree(node.result)}</pre>}<div className="decision-choices">{node.choices?.map((choice, index) => <button data-testid={`decision-${index}`} className="decision-choice" key={choice} disabled={busy} onClick={async () => { if (await onCommand({ type: 'decide', taskId: task.id, nodeId: node.id, choice })) await onCommand({ type: 'run', taskId: task.id }); }}><span>{choice}</span><ArrowRight size={14}/></button>)}</div></div>}
        {node.decision && <div className="node-notice"><Check size={15}/><span>已选择：{node.decision}</span></div>}
        {extension.conditionResult && <div className={`node-notice ${extension.conditionResult === 'unknown' ? 'warning' : ''}`}><GitFork size={15}/><span>判断结果：{{ true: '成立', false: '不成立', unknown: '未知，需要补充依据' }[extension.conditionResult]}</span></div>}
        {extension.runIf && <div className="node-notice"><GitBranch size={15}/><span>启用条件：{task.nodes.find(item => item.id === extension.runIf!.nodeId)?.title ?? extension.runIf.nodeId} → {extension.runIf.outcome === 'true' ? '成立' : '不成立'}</span></div>}
        <label className="field-label">节点名称<input data-testid="node-title-input" value={draft.title} onChange={event => update('title', event.target.value)} placeholder="具体的执行步骤"/></label>
        <label className="field-label">工作要求<textarea rows={3} value={draft.description} onChange={event => update('description', event.target.value)} placeholder="这个节点要完成什么"/></label>
        <label className="field-label">具体动作<textarea data-testid="node-action-input" rows={3} value={draft.action} onChange={event => update('action', event.target.value)} placeholder="读取、修改或检查哪些内容"/></label>
        <label className="field-label">操作对象<input value={draft.target} onChange={event => update('target', event.target.value)} placeholder="资料、文件或产物"/></label>
        <label className="field-label">通过条件<span className="field-hint">每行一条</span><textarea rows={4} value={draft.acceptance} onChange={event => update('acceptance', event.target.value)} placeholder="完成后需要满足的条件"/></label>
        {node.kind === 'decision' && <label className="field-label">可选方案<span className="field-hint">每行一个选项</span><textarea rows={3} value={draft.choices} onChange={event => update('choices', event.target.value)}/></label>}
        <details className="detail-section"><summary><span>依赖与结构</span><ChevronDown size={14}/></summary><label className="field-label">父节点<select value={draft.parentId ?? ''} onChange={event => update('parentId', event.target.value || null)}><option value="">任务树根层</option>{parentOptions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="field-label">执行依赖</div><div className="dependency-options">{task.nodes.filter(item => item.id !== node.id && item.kind !== 'group').map(item => <label key={item.id} className="checkbox-row"><input type="checkbox" checked={draft.dependencies.includes(item.id)} onChange={event => update('dependencies', event.target.checked ? [...draft.dependencies, item.id] : draft.dependencies.filter(id => id !== item.id))}/><span>{item.title}</span></label>)}</div><label className="checkbox-row enabled-option"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)}/><span>启用此节点</span></label></details>
        {node.dependencies.length > 0 && <div className="dependencies-summary"><span>等待条件</span>{node.dependencies.map(id => { const dependency = task.nodes.find(item => item.id === id); return dependency && <button key={id} onClick={() => onSelect(id)}><StatusIcon status={dependency.status} size={13}/><span>{dependency.title}</span><ArrowUpRight size={12}/></button>; })}</div>}
        {node.result && <details className="detail-section" open><summary><span>执行结果</span><ChevronDown size={14}/></summary><pre className="tree-output small-output">{asTree(node.result)}</pre></details>}
        <div className="node-actions"><button className="button button-quiet small" disabled={busy} onClick={() => onCommand({ type: 'add', taskId: task.id, parentId: node.id })}><Plus size={14}/>添加子节点</button>{node.kind !== 'group' && <button className="button button-quiet small" disabled={busy || task.status === 'running' || task.status === 'planning'} onClick={async () => { if (await onCommand({ type: 'retry', taskId: task.id, nodeId: node.id }) && task.approval?.revision === task.revision) await onCommand({ type: 'run', taskId: task.id }); }}><RotateCcw size={14}/>重新执行</button>}<button className="icon-button danger" aria-label="删除节点" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14}/></button></div>
        {confirmDelete && <div className="delete-confirm"><p>删除此节点及其子节点？执行记录将由运行时保留。</p><div><button className="button small" onClick={() => setConfirmDelete(false)}>保留</button><button className="button small danger" disabled={busy} onClick={() => onCommand({ type: 'remove', taskId: task.id, nodeId: node.id })}>删除节点</button></div></div>}
      </> : tab === 'history' ? <>
        <div className="section-caption"><span>执行记录</span><span>{attempts.length} 次尝试</span></div>
        {events.length ? <div className="event-list">{[...events].reverse().map(event => <div className={`event-item ${event.kind}`} key={event.id}><div className="event-marker">{event.kind === 'tool' ? <Code2 size={12}/> : event.kind === 'error' ? <CircleAlert size={12}/> : event.kind === 'decision' ? <GitFork size={12}/> : <Circle size={8}/>}</div><div className="event-content"><div className="event-meta"><time>{clock(event.at)}</time><span>v{event.revision}</span></div><p>{event.message}</p>{event.detail && <details><summary>查看详情</summary><pre className="tree-output small-output">{asTree(event.detail)}</pre></details>}</div></div>)}</div> : <div className="empty-state compact"><History size={24}/><p>执行后会在这里记录每次动作</p></div>}
        {attempts.length > 0 && <details className="detail-section"><summary><span>历史尝试</span><ChevronDown size={14}/></summary>{[...attempts].reverse().map((attempt, index) => <div className="attempt-item" key={attempt.id}><div><span>尝试 {attempts.length - index} · 计划 v{attempt.revision}</span><span className={`node-status ${attempt.status}`}>{nodeLabels[attempt.status]}</span></div><p>{attempt.specification.action}</p><time>{clock(attempt.startedAt)}</time></div>)}</details>}
      </> : artifacts.length ? [...artifacts].reverse().map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} task={task}/>) : <div className="empty-state compact"><FileText size={25}/><p>此节点尚未生成产物</p></div>}
    </div>
    {tab === 'content' && dirty && <div className="inspector-save"><span>{node.status === 'running' ? '应用后将暂停并更新计划' : '应用修改会生成新的计划版本'}</span><div><button className="button button-quiet small" onClick={() => { setDraft(makeDraft()); setDirty(false); }}>撤销</button><button data-testid="node-save" className="button button-primary small" disabled={busy || !draft.title.trim()} onClick={save}><Save size={14}/>应用修改</button></div></div>}
  </>;
}

function NewTaskModal({ onClose, onCreate, busy, hasModel }: { onClose: () => void; onCreate: (prompt: string, mode: 'demo' | 'model', title: string) => Promise<void>; busy: boolean; hasModel: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'demo' | 'model'>(hasModel ? 'model' : 'demo');
  return <Modal title="新建任务" subtitle="描述目标，再把它整理成可以逐步执行的树。" onClose={onClose}><form onSubmit={event => { event.preventDefault(); onCreate(prompt.trim(), mode, title.trim()); }}><label className="field-label">任务名称<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：整理产品需求" maxLength={80}/></label><label className="field-label">你希望完成什么<textarea required rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="说明目标、已有资料和完成条件。"/></label><div className="field-label">执行方式</div><div className="mode-options"><label className={mode === 'demo' ? 'selected' : ''}><input type="radio" name="mode" checked={mode === 'demo'} onChange={() => setMode('demo')}/><div><strong>演示执行</strong><span>固定执行流程，体验编辑、决策与交付</span></div></label><label className={mode === 'model' ? 'selected' : ''}><input type="radio" name="mode" checked={mode === 'model'} onChange={() => setMode('model')}/><div><strong>模型执行</strong><span>使用配置的模型处理选定资料</span></div></label></div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy || !prompt.trim()}><Plus size={15}/>创建任务</button></div></form></Modal>;
}

function ModelModal({ onClose, current, busy, onSave }: { onClose: () => void; current: PublicModelConfig | null; busy: boolean; onSave: (config: ModelConfig) => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [model, setModel] = useState(current?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  return <Modal title="模型连接" subtitle="连接支持 Chat Completions 与工具调用的模型服务。" onClose={onClose}><form onSubmit={event => { event.preventDefault(); onSave({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey }); }}><label className="field-label">服务地址<input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-provider.example/v1" spellCheck={false}/></label><label className="field-label">模型名称<input required value={model} onChange={event => setModel(event.target.value)} placeholder="供应商提供的模型标识" spellCheck={false}/></label><label className="field-label">API Key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={current?.hasKey ? '已保存；留空保留当前密钥' : '输入 API Key'} autoComplete="off" spellCheck={false}/></label><div className="model-storage-note"><ShieldCheck size={16}/><span>{current?.storage === 'encrypted' ? '当前密钥已使用系统安全存储保护。' : current?.storage === 'session' ? '当前密钥仅保存在本次会话内存中。' : '密钥由桌面运行时保存，不进入任务和导出文件。'}</span></div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy || !baseUrl.trim() || !model.trim()}><Check size={15}/>保存连接</button></div></form></Modal>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
