import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentSpec, CaseResult, NodeSpec, NodeState, Proof, Session, TestCase } from '../mcp/schema';
import { ACCEPT_ID, TASK_ID, activeAttempts, agentColor, aggregateStatus, buildView, taskEnds, counts, isContainer, stateLabel, viewDescendants, type ViewNode } from './canvas-model';
import { currentWork, nodeActivities } from './collaboration-model';
import { deletionImpact, nodeSpecification, previewImpact, subtreeIds } from './inspector-model';
import { Avatar, Glyph, MiniBar } from './TreeCanvas';
import './inspector.css';

export interface NodeInspectorProps {
  session: Session;
  /** A plan node, the virtual acceptance node, or a result's virtual work card. */
  nodeId: string;
  mode: 'detail' | 'edit' | 'add';
  busy: boolean;
  editRevision: number;
  onClose: () => void;
  onEdit: () => void;
  onSave: (node: NodeSpec) => Promise<void>;
  onDelete: (nodeId: string) => Promise<void>;
  onAdd: (parentId: string) => void;
  onAskAi: (nodeId: string | null, rework?: boolean) => void;
  /** Ask the host agent to generate normal, boundary and extreme samples for a node. */
  onGenerateCases?: (nodeId: string) => void;
  /** Not satisfied with a finished node: stop the run and go back to that node. */
  onRollback?: (nodeId: string, message?: string) => Promise<void>;
  /** Saves edited agent settings (a new version that needs approval). */
  onSaveAgents?: (agents: AgentSpec[]) => Promise<void>;
  /** Loads a stored screenshot or recording as a data: URL. */
  loadArtifact?: (id: string) => Promise<string>;
  onLocate: (nodeId: string) => void;
  onResetPosition?: (nodeId?: string) => void;
  /** Approve / pause / accept controls for the whole task. */
  taskActions?: ReactNode;
  onRecords?: () => void;
}

const kindNames: Record<NodeSpec['kind'], string> = { group: '分组', result: '效果', test: '测试', action: '执行步骤', condition: '条件判断', agent: 'Agent 分支' };
const splitLines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
const caseKinds = [['normal', '正常情况'], ['boundary', '边界情况'], ['extreme', '极端情况']] as const;
/** Samples are edited one per line as "输入 → 期望输出". */
const casesText = (cases: TestCase[] | undefined, kind: TestCase['kind']) => (cases ?? []).filter(c => c.kind === kind).map(c => `${c.input} → ${c.expected}`).join('\n');
const parseCases = (kind: TestCase['kind'], value: string): TestCase[] => splitLines(value).map(line => {
  const [input, ...rest] = line.split(/\s*(?:→|->|=>)\s*/);
  return { kind, input: input.trim(), expected: rest.join(' → ').trim() };
});
const isImage = (value: string) => /^data:image\//i.test(value) || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(value);

function Field({ label, value, onChange, multiline = false, required = false, maxLength, hint }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; maxLength?: number; hint?: string;
}) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{multiline
    ? <textarea id={id} value={value} onChange={event => onChange(event.target.value)} rows={3} required={required} maxLength={maxLength} placeholder={hint} />
    : <input id={id} value={value} onChange={event => onChange(event.target.value)} required={required} maxLength={maxLength} placeholder={hint} />}</div>;
}

function Editor({ node, session, busy, editRevision, onSave, onCancel, adding }: {
  node: NodeSpec; session: Session; busy: boolean; editRevision: number;
  onSave: (node: NodeSpec) => Promise<void>; onCancel: () => void; adding: boolean;
}) {
  const [draft, setDraft] = useState(() => nodeSpecification(node));
  const [criteria, setCriteria] = useState(node.acceptance.join('\n'));
  const [constraints, setConstraints] = useState((node.constraints ?? []).join('\n'));
  const [cases, setCases] = useState(() => Object.fromEntries(caseKinds.map(([k]) => [k, casesText(node.cases, k)])) as Record<TestCase['kind'], string>);
  const [error, setError] = useState('');
  const change = <K extends keyof NodeSpec>(key: K, value: NodeSpec[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const descendants = subtreeIds(session.nodes, draft.id);
  const impact = previewImpact(session, { ...draft, acceptance: splitLines(criteria) });
  const deleted = !adding && !session.nodes.some(item => item.id === draft.id);
  const conflict = editRevision !== session.revision;
  const isRoot = !adding && node.parentId === null;
  const hasChildren = session.nodes.some(item => item.parentId === draft.id);
  const container = isContainer(draft), isTest = draft.kind === 'test';

  const save = async () => {
    setError('');
    if (deleted) { setError('此节点已在新版本中删除。草稿仍保留，请复制所需内容后关闭。'); return; }
    // A test the person saves is theirs: it becomes part of the acceptance contract.
    const samples = caseKinds.flatMap(([k]) => parseCases(k, cases[k]));
    const next: NodeSpec = { ...draft, title: draft.title.trim(), acceptance: splitLines(criteria), ...(isTest ? { by: 'user' as const } : { by: undefined }),
      output: draft.output?.trim() || undefined, mapping: draft.mapping?.trim() || undefined,
      constraints: splitLines(constraints).length ? splitLines(constraints) : undefined, cases: samples.length ? samples : undefined };
    if (samples.some(c => !c.input || !c.expected)) { setError('测试样例每行写成：输入 → 应该得到。'); return; }
    if (!next.title) { setError('请填写标题。'); return; }
    if (next.kind === 'result' && !next.action.trim()) { setError('请写明要达到的效果。'); return; }
    if (!container && (!next.action.trim() || !next.target.trim() || !next.input.trim() || !next.failure.trim() || !next.acceptance.length)) {
      setError(isTest ? '请填完：用什么数据、在哪里测、应该看到、测试内容、没做到时。' : '请填完：输入、在哪、做到这些才算完成、具体动作、没做到时。'); return;
    }
    if (next.parentId && descendants.has(next.parentId)) { setError('父节点不能是当前节点或其子节点。'); return; }
    if (container && next.dependsOn.length) { setError('分组或效果不能设“先完成”，请设在具体步骤上。'); return; }
    if (container && !hasChildren && !adding) { setError('分组或效果至少需要一个子节点。'); return; }
    try { await onSave(next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，草稿已保留。'); }
  };

  return <form className="editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    {conflict && <p className="callout wait" role="status">当前树已更新到 v{session.revision}；此草稿基于 v{editRevision}。保存仍校验原版本，冲突时不会覆盖新内容。</p>}
    {deleted && <p className="callout wait" role="alert">节点已被删除，当前草稿保留供复制。</p>}
    <section className="callout wait" aria-label="修改影响范围"><p><strong>保存后生成 v{session.revision + 1}，当前批准撤销。</strong></p>
      <p>{impact.length} 个节点可能需要重新执行；已有记录保留在 v{session.revision}。</p></section>
    <Field label="标题" value={draft.title} onChange={value => change('title', value)} required maxLength={300} />
    <div className="pair">
      <label className="field"><span>类型</span><select value={draft.kind} disabled={isRoot} onChange={event => change('kind', event.target.value as NodeSpec['kind'])}>
        {Object.entries(kindNames).map(([key, name]) => <option key={key} value={key} disabled={hasChildren && !['group', 'result', 'agent'].includes(key)}>{name}</option>)}
      </select></label>
      {!container && <label className="field"><span>执行 Agent</span><select value={draft.agentId} onChange={event => change('agentId', event.target.value)}>
        {session.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select></label>}
    </div>
    <h4 className="part">输入</h4>
    <Field label={isTest ? '用什么数据' : '输入'} value={draft.input} onChange={value => change('input', value)} multiline required={!container} maxLength={12000} hint={container ? '这一部分从什么开始' : undefined} />
    {!container && <Field label={isTest ? '在哪里测' : '在哪'} value={draft.target} onChange={value => change('target', value)} required maxLength={2000} hint={isTest ? '页面、文件或命令' : undefined} />}
    <h4 className="part">输出</h4>
    {draft.kind === 'result' && <Field label="要达到的效果" value={draft.action} onChange={value => change('action', value)} multiline required maxLength={12000} hint="用户能看到什么、在哪里看到" />}
    {draft.kind !== 'result' && !isTest && <Field label={container ? '这一部分交出什么' : '产出什么'} value={draft.output ?? ''} onChange={value => change('output', value)} multiline maxLength={12000} />}
    {!container && <Field label={isTest ? '应该看到（每行一项）' : '做到这些才算完成（每行一项）'} value={criteria} onChange={setCriteria} multiline required />}
    <h4 className="part">描述</h4>
    <Field label="怎么做" value={draft.mapping ?? ''} onChange={value => change('mapping', value)} multiline maxLength={12000} hint="一两句话：输入怎么变成输出" />
    {!container && <Field label={isTest ? '测试内容' : '具体动作'} value={draft.action} onChange={value => change('action', value)} multiline required maxLength={12000} hint={isTest ? '当……时，应该看到……' : undefined} />}
    <Field label="注意（每行一项）" value={constraints} onChange={setConstraints} multiline />
    {!container && <Field label="没做到时" value={draft.failure} onChange={value => change('failure', value)} multiline required maxLength={12000} />}
    {!container && <>
      <h4 className="part">测试</h4>
      <fieldset className="cases-edit"><legend>测试样例（每行：输入 → 应该得到）</legend>
        {caseKinds.map(([k, name]) => <Field key={k} label={name} value={cases[k]} onChange={value => setCases(c => ({ ...c, [k]: value }))} multiline />)}
      </fieldset>
    </>}
    <label className="field"><span>属于</span><select value={draft.parentId || ''} disabled={isRoot} onChange={event => change('parentId', event.target.value || null)}>
      {isRoot && <option value="">无（根节点）</option>}{session.nodes.filter(item => !descendants.has(item.id) && ['group', 'result', 'agent'].includes(item.kind)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
    {!container && <fieldset className="dependencies"><legend>先完成</legend>
      {session.nodes.filter(item => item.id !== draft.id && !isContainer(item)).map(item => <label className="check" key={item.id}>
        <input type="checkbox" checked={draft.dependsOn.includes(item.id)} onChange={event => change('dependsOn', event.target.checked ? [...draft.dependsOn, item.id] : draft.dependsOn.filter(id => id !== item.id))} /><span>{item.title}</span>
      </label>)}
    </fieldset>}
    {!container && session.nodes.some(item => item.kind === 'condition' && item.id !== draft.id) && <div className="pair">
      <label className="field"><span>触发条件</span><select value={draft.when?.nodeId || ''} onChange={event => change('when', event.target.value ? { nodeId: event.target.value, outcome: draft.when?.outcome ?? true } : undefined)}>
        <option value="">无条件</option>{session.nodes.filter(item => item.kind === 'condition' && item.id !== draft.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      {draft.when && <label className="field"><span>何时执行</span><select value={String(draft.when.outcome)} onChange={event => change('when', { ...draft.when!, outcome: event.target.value === 'true' })}><option value="true">条件成立</option><option value="false">条件不成立</option></select></label>}
    </div>}
    {error && <p role="alert" className="callout fail">{error}</p>}
    <div className="panel-foot"><button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="btn primary" disabled={busy || deleted}>保存为 v{session.revision + 1}</button></div>
  </form>;
}

/** Loads stored screenshots and recordings; provided by the host bridge. */
const ArtifactLoader = createContext<((id: string) => Promise<string>) | undefined>(undefined);

function Media({ proof }: { proof: Proof }) {
  const load = useContext(ArtifactLoader);
  const [src, setSrc] = useState<string | undefined>(proof.artifact ? undefined : proof.url);
  const [error, setError] = useState('');
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!proof.artifact) return;
    if (!load) { setError('此处无法加载文件'); return; }
    let live = true;
    load(proof.artifact).then(url => { if (live) setSrc(url); }, failure => { if (live) setError(failure instanceof Error ? failure.message : '加载失败'); });
    return () => { live = false; };
  }, [proof.artifact, load]);
  if (error || (!src && !proof.artifact)) return <p className="note">{error || '没有可显示的文件'}{proof.path ? `：${proof.path}` : ''}</p>;
  if (!src) return <p className="note">正在加载…</p>;
  const video = proof.kind === 'video' && !/\.gif$|image\/gif/.test(proof.artifact ?? src);
  return video
    ? <video className="media" src={src} controls muted loop playsInline preload="metadata" />
    : <img className={`media${zoomed ? ' zoomed' : ''}`} src={src} alt={proof.caption ?? '截图'} onClick={() => setZoomed(z => !z)} />;
}
/** One piece of proof, shown the way a person reads it: a terminal, a picture, a clip, a sentence or a link. */
function ProofView({ proof }: { proof: Proof }) {
  return <figure className={`proof ${proof.kind}`} data-proof-kind={proof.kind}>
    {proof.caption && <figcaption>{proof.caption}</figcaption>}
    {proof.kind === 'command' && <pre className="term"><span className="prompt">$ </span>{proof.command}{proof.output ? `\n${proof.output}` : ''}</pre>}
    {(proof.kind === 'image' || proof.kind === 'video') && <Media proof={proof} />}
    {proof.kind === 'text' && <p>{proof.output}</p>}
    {proof.kind === 'link' && <a href={proof.url} target="_blank" rel="noreferrer noopener">{proof.url}</a>}
  </figure>;
}

const resultOf = (node: NodeState, i: number): CaseResult | undefined => node.caseResults?.find(r => r.case === i);
/** Samples by kind; once the node has run, each sample shows what actually happened and its proof. */
function Samples({ node, onGenerateCases, busy }: { node: NodeState; onGenerateCases?: (id: string) => void; busy: boolean }) {
  const cases = (node.cases ?? []).map((c, i) => ({ c, i, r: resultOf(node, i) }));
  return <>
    {caseKinds.map(([k, label]) => { const rows = cases.filter(x => x.c.kind === k); return rows.length ? <div key={k} className="case-group" data-case-kind={k}>
      <h4>{label}</h4>
      <ul className="cases">{rows.map(({ c, i, r }) => <li key={i} data-case={i} data-result={r ? (r.passed ? 'passed' : 'failed') : 'pending'}>
        <div className="case-line"><span className="in">{c.input}</span><span className="arrow" aria-label="应该得到">→</span><span className="out">{c.expected}</span>
          <span className="verdict">{r ? (r.passed ? '✓ 通过' : '✗ 未通过') : node.status === 'running' ? '测试中' : '待测试'}</span></div>
        {r && <div className="case-result"><p className="actual">实际：{r.actual}</p>{r.proof.map((p, j) => <ProofView key={j} proof={p} />)}</div>}
      </li>)}</ul>
    </div> : null; })}
    {onGenerateCases && (!cases.length || caseKinds.some(([k]) => !cases.some(x => x.c.kind === k))) && <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => onGenerateCases(node.id)}>让 Agent 补样例</button></div>}
  </>;
}
/** Checks and free-form evidence reported outside the samples. */
function OtherEvidence({ node, session }: { node: NodeState; session: Session }) {
  const checks = session.attempts.find(a => a.id === node.attemptId)?.checks ?? [];
  if (!checks.length && !node.evidence?.length) return null;
  return <div className="evidence"><h4>其他证据</h4>
    {!!checks.length && <ul className="checks">{checks.map((check, index) => <li key={index} data-passed={check.passed}><span className="mark" aria-hidden="true">{check.passed ? '✓' : '✗'}</span><div>{check.criterion}<small>{check.evidence}</small></div></li>)}</ul>}
    {node.evidence?.map((item, index) => isImage(item) ? <img key={index} className="media" src={item} alt={`${node.title} 的证据 ${index + 1}`} /> : <p key={index} className="mono">{item}</p>)}
  </div>;
}
function Live({ session, nodeId }: { session: Session; nodeId: string }) {
  const work = currentWork(session).find(w => w.attempt.nodeId === nodeId);
  if (!work) return null;
  const action = [...(session.activities ?? [])].reverse().find(x => x.attemptId === work.attempt.id && x.kind === 'action');
  return <div className="callout live" style={{ '--agent': agentColor(session, work.attempt.agentId) } as React.CSSProperties}>
    <p><Avatar session={session} agentId={work.attempt.agentId} /> <strong>{work.agent?.name ?? work.attempt.agentId}</strong> · {new Date(work.attempt.startedAt).toLocaleTimeString()} 开始</p>
    <p>{action?.summary ?? '已领取，等待上报实际动作'}</p>{action?.target && <p className="mono">{action.target}</p>}
  </div>;
}
function Messages({ session, nodeId }: { session: Session; nodeId: string }) {
  const activities = nodeActivities(session, nodeId).filter(a => a.kind !== 'action');
  if (!activities.length) return null;
  const name = (id?: string) => session.agents.find(a => a.id === id)?.name ?? id ?? '';
  return <Section title="协作消息"><ul className="timeline">{activities.map(a => <li key={a.id} data-activity-kind={a.kind}><Avatar session={session} agentId={a.agentId} /><div>
    <div className="meta">{new Date(a.at).toLocaleTimeString()} · {a.kind === 'message_sent' ? `${name(a.agentId)} → ${name(a.toAgentId)} · 已发送` : `${name(a.fromAgentId)} → ${name(a.agentId)} · 已接收`}{a.revision !== session.revision ? ` · v${a.revision}` : ''}</div>{a.summary}</div></li>)}</ul></Section>;
}
const Section = ({ title, children }: { title?: string; children: ReactNode }) => <section className="panel-section">{title && <h3>{title}</h3>}{children}</section>;
const Unfilled = () => <p className="note">未填写</p>;
function Links({ session, view, ids, onLocate }: { session: Session; view: Map<string, ViewNode>; ids: string[]; onLocate: (id: string) => void }) {
  return <div className="links">{ids.map(id => <button type="button" key={id} className="link-chip" onClick={() => onLocate(id)}><Glyph session={session} view={view} id={id} size={13} />{view.get(id)?.title ?? id}</button>)}</div>;
}
function TestRows({ session, view, ids, onLocate }: { session: Session; view: Map<string, ViewNode>; ids: string[]; onLocate: (id: string) => void }) {
  return <ul className="test-list">{ids.map(id => { const n = view.get(id)!.node!, total = n.cases?.length ?? 0, passed = n.caseResults?.filter(r => r.passed).length ?? 0;
    return <li key={id}><button type="button" className="test-row" onClick={() => onLocate(id)}>
      <Glyph session={session} view={view} id={id} size={15} /><span className="t">{n.title}</span><span className={`by ${n.by ?? 'agent'}`}>{n.by === 'user' ? '你设定' : 'Agent 补充'}</span>
      {total > 0 && <span className="n">样例 {passed}/{total}</span>}<span className={`s ${n.status}`}>{stateLabel(session, view, id)}</span></button></li>; })}</ul>;
}

/** 描述: how the input becomes the output, then what to watch for, what comes first, when it applies and what happens if it falls short. */
function Describe({ node, view, onLocate, fallback }: { node: NodeState; view: Map<string, ViewNode>; onLocate: (id: string) => void; fallback?: string }) {
  const name = (id: string) => view.get(id)?.title ?? id;
  const text = node.mapping || fallback;
  const rules = [
    ...(node.constraints ?? []).map((item, i) => <li key={`c${i}`}>{item}</li>),
    !!node.dependsOn.length && <li key="d">先等{node.dependsOn.map(id => <button key={id} type="button" className="link-plain" onClick={() => onLocate(id)}>「{name(id)}」</button>)}完成</li>,
    node.when && <li key="w">只在<button type="button" className="link-plain" onClick={() => onLocate(node.when!.nodeId)}>「{name(node.when.nodeId)}」</button>{node.when.outcome ? '成立' : '不成立'}时做</li>,
    !isContainer(node) && node.failure && <li key="f">没做到：{node.failure}</li>,
  ].filter(Boolean);
  return <>{text ? <p>{text}</p> : !rules.length && <Unfilled />}{!!rules.length && <ul className="plain rules">{rules}</ul>}</>;
}
const Outcome = ({ node }: { node: NodeState }) => node.result ? <Section><div className={`callout ${node.status === 'failed' ? 'fail' : node.status === 'passed' ? 'pass' : ''}`}><p>{node.result}</p></div></Section> : null;

const effortNames = { low: '低', medium: '中', high: '高', xhigh: '很高' } as const;
/** Offered in the model picker; anything else can be typed under 自定义. Hosts apply what they support. */
// Planning picks one of two: sonnet for simple work, opus for hard work.
const KNOWN_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
/** A real dropdown of models (default, known ones, the ones in use) plus 自定义 for any other name. */
function ModelPicker({ value, known, onChange }: { value?: string; known: string[]; onChange: (model?: string) => void }) {
  const [custom, setCustom] = useState(Boolean(value && !known.includes(value)));
  const id = useId();
  return <label htmlFor={id}>模型{custom
    ? <span className="model-custom"><input id={id} value={value ?? ''} placeholder="输入模型名称" maxLength={100} autoFocus onChange={e => onChange(e.target.value || undefined)} />
        <button type="button" className="icon-btn" aria-label="从列表选择" title="从列表选择" onClick={() => { setCustom(false); if (value && !known.includes(value)) onChange(undefined); }}>×</button></span>
    : <select id={id} value={value ?? ''} onChange={e => { if (e.target.value === '__custom') { setCustom(true); onChange(undefined); } else onChange(e.target.value || undefined); }}>
        {!value && <option value="" disabled hidden>选择模型</option>}{known.map(m => <option key={m} value={m}>{m}</option>)}<option value="__custom">自定义…</option>
      </select>}</label>;
}
/**
 * Who does what, and with which model, effort and mode. The planning agent sets them by how hard the work is; the person
 * changes them here (all agents in the task sheet, or the agents behind one node on its page). Saving makes a new version.
 */
function Agents({ session, busy, onSave, ids, title = 'Agent 分工与模型' }: { session: Session; busy: boolean; onSave?: (agents: AgentSpec[]) => Promise<void>; ids?: string[]; title?: string }) {
  const [draft, setDraft] = useState<AgentSpec[] | null>(null);
  const [error, setError] = useState('');
  const shown = (draft ?? session.agents).filter(a => !ids || ids.includes(a.id));
  const models = [...new Set([...KNOWN_MODELS, ...session.agents.map(a => a.model).filter((m): m is string => Boolean(m))])];
  if (!shown.length) return null;
  const set = (id: string, patch: Partial<AgentSpec>) => setDraft(d => d!.map(a => a.id === id ? { ...a, ...patch } : a));
  const save = async () => {
    setError('');
    try { await onSave!(draft!.map(a => ({ ...a, model: a.model?.trim() || undefined }))); setDraft(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败'); }
  };
  return <section className="panel-section agents-section" aria-label={title}><h3>{title}</h3>
    <ul className="agents">{shown.map(a => <li key={a.id} data-agent-id={a.id}><Avatar session={session} agentId={a.id} /><div>
      <strong>{a.name}</strong> · {a.role}
      {draft ? <div className="agent-config edit">
        <ModelPicker value={a.model} known={models} onChange={model => set(a.id, { model })} />
        <label>思考力度<select value={a.effort ?? ''} onChange={e => set(a.id, { effort: (e.target.value || undefined) as AgentSpec['effort'] })}><option value="">默认</option>{Object.entries(effortNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div> : <p className="agent-config">{[a.model ?? '默认模型', a.effort ? `思考${effortNames[a.effort]}` : '默认力度'].map((t, i) => <span key={i} className="chip-flat">{t}</span>)}</p>}
      {!ids && <><p>负责：{a.scope}</p><p>上限：{a.budget}</p></>}</div></li>)}</ul>
    {onSave && (draft
      ? <>{error && <p role="alert" className="callout fail">{error}</p>}
          <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>保存为 v{session.revision + 1}</button></div></>
      : <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => setDraft(session.agents.map(a => ({ ...a })))}>调整模型与力度</button></div>)}
  </section>;
}

/** The whole task, opened from the title: where it starts, what it delivers, the stages between, and every test. */
function WholeTask(props: NodeInspectorProps & { view: Map<string, ViewNode> }) {
  const { session, view, onLocate } = props;
  const node = session.nodes.find(n => n.parentId === null)!;
  const kids = view.get(node.id)?.children ?? [];
  const testsUnder = (id: string) => viewDescendants(view, id).filter(x => view.get(x)?.node?.kind === 'test');
    const ends = taskEnds(session), stages = kids.filter(id => id !== ACCEPT_ID), results = session.nodes.filter(n => n.kind === 'result');
  return <>
      {props.taskActions && <Section><div className="decision">{props.taskActions}</div></Section>}
      <Parts
        describe={<><Describe node={node} view={view} onLocate={onLocate} fallback={node.action || session.goal} />
          <ol className="path" aria-label="从输入到输出">
            {stages.map(id => <li key={id}><button type="button" className="link-chip" onClick={() => onLocate(id)}><Glyph session={session} view={view} id={id} size={13} />{view.get(id)?.title ?? id}</button></li>)}
          </ol>
          {!!session.clarifications?.length && <details className="fold"><summary>已确认的要求（{session.clarifications.length}）</summary><dl className="qa">{session.clarifications.map((item, index) => <div key={index}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl></details>}
</>}
        input={<>{ends.input ? <p>{ends.input}</p> : <Unfilled />}
          {!!session.context.length && <details className="fold"><summary>依据的资料（{session.context.length}）</summary><ul>{session.context.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</>}
        output={<><p>{ends.output}</p></>}
        tests={results.length ? results.map(r => <div key={r.id} className="accept-item"><h4><button type="button" className="link-plain" onClick={() => onLocate(r.id)}><Glyph session={session} view={view} id={r.id} size={14} />{r.title}</button></h4>
          <TestRows session={session} view={view} ids={testsUnder(r.id)} onLocate={onLocate} /></div>) : <TestRows session={session} view={view} ids={testsUnder(node.id)} onLocate={onLocate} />} />
    <Agents session={session} busy={props.busy} onSave={props.onSaveAgents} />
    </>;
  }

/**
 * Each node's own acceptance, at the end of its tests: once it has run, the person looks at the results and, if not
 * satisfied, stops the whole run and goes back to this node to change it.
 */
function NodeCheck({ node, session, view, busy, onRollback }: { node: NodeState; session: Session; view: Map<string, ViewNode>; busy: boolean; onRollback?: (id: string, message?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const status = aggregateStatus(session, view, node.id);
  const ran = session.attempts.some(a => a.nodeId === node.id || viewDescendants(view, node.id).includes(a.nodeId));
  if (!onRollback || !ran || !['passed', 'failed', 'blocked'].includes(status) || session.status === 'draft' || session.status === 'accepted') return null;
  return <div className="node-check" data-node-check={node.id}>
    {open
      ? <><label className="field"><span>哪里不满意（可不填）</span><textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} /></label>
          <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void onRollback(node.id, note.trim() || undefined)}>中止并回到这里</button></div>
          <p className="note">将停止全部执行；这一步及依赖它的步骤需重做。</p></>
      : <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => setOpen(true)}>不满意，中止并回到这里</button></div>}
  </div>;
}

/** Every node reads the same way: 描述 on top, 输入 → 输出 side by side, 测试 below. */
function Parts({ describe, input, output, tests }: { describe: ReactNode; input: ReactNode; output: ReactNode; tests: ReactNode }) {
  return <>
    <section className="panel-section part part-describe" aria-label="描述"><h3>描述</h3>{describe}</section>
    <section className="panel-section part part-io" aria-label="输入与输出">
      <div className="io io-in"><h3>输入</h3>{input}</div>
      <span className="io-arrow" aria-hidden="true">→</span>
      <div className="io io-out"><h3>输出</h3>{output}</div>
    </section>
    <section className="panel-section part part-tests" aria-label="测试"><h3>测试</h3>{tests}</section>
  </>;
}
/** Every node reads the same way: 输入, 输出, 描述, 测试. */
function Details(props: NodeInspectorProps & { node: NodeState; view: Map<string, ViewNode> }) {
  const { node, session, view, onLocate } = props;
  const kids = view.get(node.id)?.children ?? [];
  const attempts = session.attempts.filter(attempt => attempt.nodeId === node.id);
  const agent = session.agents.find(item => item.id === node.agentId);
  const testsUnder = (id: string) => viewDescendants(view, id).filter(x => view.get(x)?.node?.kind === 'test');
  const samples = <Samples node={node} onGenerateCases={props.onGenerateCases} busy={props.busy} />;

  if (node.parentId === null) {
    // The start node is only where the path begins: what the task starts from, handed to the first step.
    const ends = taskEnds(session), first = kids.find(id => id !== ACCEPT_ID);
    return <Parts
      describe={<p>任务从这里出发：把下面的输入交给第一步{first && <button type="button" className="link-plain" onClick={() => onLocate(first)}>「{view.get(first)?.title}」</button>}。整个任务的说明请点左上角标题。</p>}
      input={<>{ends.input ? <p>{ends.input}</p> : <Unfilled />}
        {!!session.context.length && <details className="fold"><summary>依据的资料（{session.context.length}）</summary><ul>{session.context.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</>}
      output={first ? <><p>{view.get(first)?.node?.input || ends.input || '—'}</p><p className="note">交给「{view.get(first)?.title}」</p></> : <Unfilled />}
      tests={<p className="note">起点不做测试，检查从第一步开始。</p>} />;
  }
  if (isContainer(node)) {
    const result = node.kind === 'result', tests = result ? kids.filter(id => view.get(id)?.node?.kind === 'test') : testsUnder(node.id);
    const workId = kids.find(id => view.get(id)?.kind === 'work');
    const doers = [...new Set(session.nodes.filter(n => !isContainer(n) && viewDescendants(view, node.id).includes(n.id)).map(n => n.agentId))];
    return <><Parts
      describe={<><Describe node={node} view={view} onLocate={onLocate} fallback={!result && node.output ? node.action : undefined} />
        {!result && <><Links session={session} view={view} ids={kids} onLocate={onLocate} /></>}
        {workId && <details className="fold"><summary>Agent 要做的步骤（{view.get(workId)!.children.length}）</summary><Links session={session} view={view} ids={view.get(workId)!.children} onLocate={onLocate} /></details>}</>}
      input={node.input ? <p>{node.input}</p> : <Unfilled />}
      output={<>{result ? <p>{node.action}</p> : node.output || node.action ? <p>{node.output || node.action}</p> : <Unfilled />}{result && node.output && <p>{node.output}</p>}</>}
      tests={<>{tests.length ? <TestRows session={session} view={view} ids={tests} onLocate={onLocate} /> : <Unfilled />}
        {!!node.cases?.length && samples}
        <NodeCheck node={node} session={session} view={view} busy={props.busy} onRollback={props.onRollback} /></>} />
      <Agents session={session} busy={props.busy} onSave={props.onSaveAgents} ids={doers} title="执行的 Agent" /></>;
  }
  const isTest = node.kind === 'test';
  const result = isTest && view.get(node.parentId!)?.kind === 'result' ? node.parentId! : undefined;
  const fixing = isTest && node.status === 'failed' && result ? activeAttempts(session).find(a => viewDescendants(view, result).includes(a.nodeId) && session.nodes.find(n => n.id === a.nodeId)?.kind !== 'test') : undefined;
  return <>
    <Live session={session} nodeId={node.id} />
    <Outcome node={node} />
    <Parts
      describe={<><Describe node={node} view={view} onLocate={onLocate} fallback={node.action} />
        </>}
      input={<><p>{node.input}</p>{node.target && <p className="where"><span>在哪</span><span className="mono">{node.target}</span></p>}</>}
      output={<>{node.output && <p>{node.output}</p>}
        {!!node.acceptance.length && <ul className="plain outcome">{node.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {node.conditionOutcome !== undefined && <p>结果：{node.conditionOutcome === 'unknown' ? '还不确定' : node.conditionOutcome ? '成立' : '不成立'}</p>}</>}
      tests={<>{samples}<OtherEvidence node={node} session={session} />

        <NodeCheck node={node} session={session} view={view} busy={props.busy} onRollback={props.onRollback} /></>} />
    <Agents session={session} busy={props.busy} onSave={props.onSaveAgents} ids={[node.agentId]} title="执行的 Agent" />
    {fixing && <Section title="处理"><p>Agent 正在自动修复，你不用处理：</p><Live session={session} nodeId={fixing.nodeId} /><Links session={session} view={view} ids={[fixing.nodeId]} onLocate={onLocate} /></Section>}
    {result && <Section title="所属效果"><Links session={session} view={view} ids={[result]} onLocate={onLocate} /></Section>}
    <Messages session={session} nodeId={node.id} />
    {!isTest && agent && <details className="panel-section fold"><summary>Agent 负责什么</summary><dl className="fields"><div><dt>负责</dt><dd>{agent.scope}</dd></div><div><dt>上限</dt><dd>{agent.budget}</dd></div></dl></details>}
    {!!attempts.length && <details className="panel-section fold"><summary>历史执行（{attempts.length}）</summary><ul className="history">{[...attempts].reverse().map(a => <li key={a.id}>
      <p>v{a.revision} · {session.agents.find(x => x.id === a.agentId)?.name ?? a.agentId} · {({ passed: '通过', running: '执行中', interrupted: '已中断', stale: '需重做', failed: '未通过', blocked: '需要处理' } as const)[a.status]}{a.invalidated ? ' · 已失效' : ''}</p><p>{a.summary || '尚无结果'}</p>
    </li>)}</ul></details>}
  </>;
}

function DeletionConfirmation({ node, session, busy, onDelete, onLocate, onCancel }: {
  node: NodeState; session: Session; busy: boolean; onDelete: (id: string) => Promise<void>; onLocate: (id: string) => void; onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const deletion = deletionImpact(session, node.id);
  return <section className="callout fail delete" aria-label="删除影响范围"><p><strong>删除「{node.title}」</strong></p><p>删除后生成新版本，需要重新批准；旧执行记录仍会保留。</p>
    {!!deletion.descendants.length && <><p>先移动或删除以下子节点：</p><ul>{deletion.descendants.map(item => <li key={item.id}><button type="button" className="link-plain" onClick={() => onLocate(item.id)}>{item.title}</button></li>)}</ul></>}
    {!!deletion.references.length && <><p>先调整以下节点的依赖与条件：</p><ul>{deletion.references.map(item => <li key={item.id}><button type="button" className="link-plain" onClick={() => onLocate(item.id)}>{item.title}</button></li>)}</ul></>}
    {deletion.leavesEmptyGroup && <p>删除会留下空分组，请先添加替代节点或移动该节点。</p>}
    {error && <p role="alert">{error}</p>}
    <div className="row"><button type="button" className="btn" disabled={busy || !deletion.canDelete} onClick={() => { void onDelete(node.id).catch(failure => setError(failure instanceof Error ? failure.message : '删除失败。')); }}>确认删除</button><button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button></div>
  </section>;
}

function Shell({ session, view, id, title, status, menu, onClose, busy, children, foot, label = '节点详情' }: {
  session: Session; view: Map<string, ViewNode>; id: string; title: string; status: ReactNode; menu?: ReactNode; onClose: () => void; busy: boolean; children: ReactNode; foot?: ReactNode; label?: string;
}) {
  return <aside className="node-inspector" aria-label={label} data-inspector-node={id}
    onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <div className="panel-head"><Glyph session={session} view={view} id={id} size={19} /><h2>{title}</h2>{menu}
      <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="关闭节点详情"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
    <div className="panel-status">{status}</div>
    <div className="panel-scroll">{children}</div>
    {foot && <div className="panel-foot">{foot}</div>}
  </aside>;
}

/** Keep this component keyed by session/node/mode, never by the polling revision. */
export function NodeInspector(props: NodeInspectorProps) {
  const { session, nodeId, mode, busy, onClose, editRevision, onLocate } = props;
  const view = useMemo(() => buildView(session), [session]);
  const [original] = useState(() => session.nodes.find(node => node.id === nodeId));
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [newNode] = useState<NodeSpec>(() => ({ id: `node-${crypto.randomUUID()}`, parentId: nodeId,
    kind: original?.kind === 'result' ? 'test' : 'action', title: '', action: '', target: '', input: '', acceptance: [], failure: '', dependsOn: [],
    agentId: original?.agentId || session.agents[0]?.id || 'main' }));
  const v = view.get(nodeId);
  const status = (id: string) => <><span className={`state-text ${aggregateStatus(session, view, id)}`}>{stateLabel(session, view, id)}</span>
    {(() => { const c = counts(session, view, id); return c.total ? <><MiniBar c={c} /><span>{c.passed} / {c.total} {session.nodes.some(n => n.kind === 'test') ? '项测试通过' : '步完成'}</span></> : null; })()}</>;

  if (nodeId === TASK_ID) {
    const root = session.nodes.find(n => n.parentId === null);
    if (!root) return null;
    return <Shell session={session} view={view} id={root.id} title={session.title} status={status(root.id)} onClose={onClose} busy={busy} label="整体任务详情">
      <div data-inspector-mode="task"><WholeTask {...props} view={view} /></div>
    </Shell>;
  }
  if (nodeId === ACCEPT_ID) {
    const results = session.nodes.filter(n => n.kind === 'result');
    const reviewing = session.status === 'review';
    return <Shell session={session} view={view} id={ACCEPT_ID} title="用户验收" status={status(ACCEPT_ID)} onClose={onClose} busy={busy} foot={props.taskActions}>
      <Section title="要交付"><p>{taskEnds(session).output}</p></Section>
      <Section><p>逐项查看每个效果的测试与证据。{reviewing ? '某一项不满意时，只退回这一项。' : 'Agent 全部完成并提交验收后，这里才能验收。'}</p></Section>
      {results.map(r => { const tests = (view.get(r.id)?.children ?? []).filter(id => view.get(id)?.node?.kind === 'test'); return <section key={r.id} className="panel-section accept-item">
        <h3><button type="button" className="link-plain" onClick={() => onLocate(r.id)}><Glyph session={session} view={view} id={r.id} size={15} />{r.title}</button></h3>
        <TestRows session={session} view={view} ids={tests} onLocate={onLocate} />
        {reviewing && <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => props.onAskAi(r.id, true)}>退回这一项</button></div>}
      </section>; })}
    </Shell>;
  }
  if (v?.kind === 'work') {
    return <Shell session={session} view={view} id={nodeId} title={`Agent 工作 · ${view.get(v.parentId!)?.title ?? ''}`} status={status(nodeId)} onClose={onClose} busy={busy}>
      <Section><p>Agent 为通过「{view.get(v.parentId!)?.title}」的测试要做的步骤。</p></Section>
      <Section title="步骤"><Links session={session} view={view} ids={v.children} onLocate={onLocate} /></Section>
      <Section title="所属效果"><Links session={session} view={view} ids={[v.parentId!]} onLocate={onLocate} /></Section>
    </Shell>;
  }
  const current = session.nodes.find(node => node.id === nodeId);
  const node = current || original;
  if (!node) return null;
  const title = mode === 'add' ? `添加到「${node.title}」` : mode === 'edit' ? `编辑「${node.title}」` : node.parentId === null ? '起点' : node.title;
  // The start node carries no task-wide numbers; those belong to the whole-task view under the title.
  const nodeStatus = mode === 'detail' && current && node.parentId !== null ? <>{status(nodeId)}{node.kind === 'test' && <span className={`by ${node.by ?? 'agent'}`}>{node.by === 'user' ? '你设定' : 'Agent 补充'}</span>}</> : null;
  const menu = mode === 'detail' && current ? <div className="menu-wrap"><button type="button" className="icon-btn" aria-label="节点操作" aria-expanded={menuOpen} aria-haspopup="menu" disabled={busy} onClick={() => setMenuOpen(!menuOpen)}>
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg></button>
    {menuOpen && <><div className="menu-dismiss" onClick={() => setMenuOpen(false)} aria-hidden="true" /><div className="menu" role="menu" aria-label="节点操作">
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onEdit(); }}>{node.kind === 'test' ? '编辑测试' : '编辑内容'}</button>
      {['group', 'result', 'agent'].includes(node.kind) && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onAdd(nodeId); }}>{node.kind === 'result' ? '添加测试' : '添加子节点'}</button>}
      {props.onResetPosition && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onResetPosition?.(nodeId); }}>恢复卡片默认位置</button>}
      {props.onResetPosition && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onResetPosition?.(); }}>恢复所有卡片位置</button>}
      {props.onRecords && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onRecords?.(); }}>任务记录</button>}
      <hr /><button type="button" role="menuitem" className="danger" disabled={node.parentId === null} onClick={() => { setMenuOpen(false); setConfirmDelete(true); contentRef.current?.scrollTo({ top: 0 }); }}>删除</button>
    </div></>}</div> : undefined;
  const foot = mode !== 'detail' || !current ? undefined
    : node.kind === 'test' ? (node.by === 'user'
      ? <button type="button" className="btn" disabled={busy} onClick={props.onEdit}>编辑测试</button>
      : <button type="button" className="btn" disabled={busy} onClick={() => { void props.onSave({ ...nodeSpecification(current), by: 'user' }); }}>设为验收标准</button>)
    : node.parentId === null ? undefined : <button type="button" className="btn" disabled={busy} onClick={props.onEdit}>编辑</button>;
  return <ArtifactLoader.Provider value={props.loadArtifact}><Shell session={session} view={view} id={nodeId} title={title} status={nodeStatus} menu={menu} onClose={onClose} busy={busy} foot={foot}>
    <div ref={contentRef} data-inspector-mode={mode}>
      {mode === 'detail' ? current ? <>
        {confirmDelete && <DeletionConfirmation node={current} {...props} onCancel={() => setConfirmDelete(false)} />}
        <Details key={current.id} {...props} node={current} view={view} />
      </> : <p role="status">此节点已在最新版本中删除。</p>
        : <Editor key={`${nodeId}:${mode}`} node={mode === 'add' ? newNode : node} session={session} busy={busy}
            editRevision={editRevision} onSave={props.onSave} onCancel={onClose} adding={mode === 'add'} />}
    </div>
  </Shell></ArtifactLoader.Provider>;
}
