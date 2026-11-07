import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NodeSpec, NodeState, Session, TestCase } from '../mcp/schema';
import { ACCEPT_ID, activeAttempts, agentColor, aggregateStatus, buildView, counts, isContainer, stateLabel, viewDescendants, type ViewNode } from './canvas-model';
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
    {draft.kind === 'result' && <Field label="要达到的效果" value={draft.action} onChange={value => change('action', value)} multiline required maxLength={12000} hint="用户能看到什么、在哪里看到" />}
    {isTest && <>
      <Field label="用什么数据" value={draft.input} onChange={value => change('input', value)} multiline required maxLength={12000} />
      <Field label="在哪里测" value={draft.target} onChange={value => change('target', value)} required maxLength={2000} hint="页面、文件或命令" />
      <Field label="应该看到（每行一项）" value={criteria} onChange={setCriteria} multiline required />
      <Field label="测试内容" value={draft.action} onChange={value => change('action', value)} multiline required maxLength={12000} hint="当……时，应该看到……" />
    </>}
    {!container && !isTest && <>
      <Field label="输入" value={draft.input} onChange={value => change('input', value)} multiline required maxLength={12000} />
      <Field label="在哪" value={draft.target} onChange={value => change('target', value)} required maxLength={2000} />
      <Field label="输出" value={draft.output ?? ''} onChange={value => change('output', value)} multiline maxLength={12000} hint="这一步产出什么" />
      <Field label="做到这些才算完成（每行一项）" value={criteria} onChange={setCriteria} multiline required />
      <Field label="具体动作" value={draft.action} onChange={value => change('action', value)} multiline required maxLength={12000} />
    </>}
    {!container && <>
      <Field label={isTest ? '怎么测' : '怎么做'} value={draft.mapping ?? ''} onChange={value => change('mapping', value)} multiline maxLength={12000} hint="一两句话：输入怎么变成输出" />
      <Field label="注意（每行一项）" value={constraints} onChange={setConstraints} multiline />
      <Field label="没做到时" value={draft.failure} onChange={value => change('failure', value)} multiline required maxLength={12000} />
      <fieldset className="cases-edit"><legend>测试样例（每行：输入 → 应该得到）</legend>
        {caseKinds.map(([k, name]) => <Field key={k} label={name} value={cases[k]} onChange={value => setCases(c => ({ ...c, [k]: value }))} multiline />)}
      </fieldset>
      {isTest && <p className="note">保存后这是你的验收标准，Agent 不能改。</p>}
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

function Evidence({ node, session }: { node: NodeState; session: Session }) {
  const attempt = session.attempts.find(a => a.id === node.attemptId);
  const checks = attempt?.checks ?? [];
  if (!checks.length && !node.evidence?.length) return <p className="note">{node.status === 'running' ? '正在测试，做完后这里显示结果和截图。' : '做完后这里显示截图和结果。'}</p>;
  return <div className="evidence">
    {!!checks.length && <ul className="checks">{checks.map((check, index) => <li key={index} data-passed={check.passed}><span className="mark" aria-hidden="true">{check.passed ? '✓' : '✗'}</span><div>{check.criterion}<small>{check.evidence}</small></div></li>)}</ul>}
    {node.evidence?.map((item, index) => isImage(item) ? <img key={index} src={item} alt={`${node.title} 的证据 ${index + 1}`} /> : <p key={index} className="mono">{item}</p>)}
    <p className="note">以上由 Agent 提供，仍需你确认。</p>
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
function Links({ session, view, ids, onLocate }: { session: Session; view: Map<string, ViewNode>; ids: string[]; onLocate: (id: string) => void }) {
  return <div className="links">{ids.map(id => <button type="button" key={id} className="link-chip" onClick={() => onLocate(id)}><Glyph session={session} view={view} id={id} size={13} />{view.get(id)?.title ?? id}</button>)}</div>;
}
function TestRows({ session, view, ids, onLocate }: { session: Session; view: Map<string, ViewNode>; ids: string[]; onLocate: (id: string) => void }) {
  return <ul className="test-list">{ids.map(id => { const n = view.get(id)!.node!; return <li key={id}><button type="button" className="test-row" onClick={() => onLocate(id)}>
    <Glyph session={session} view={view} id={id} size={15} /><span className="t">{n.title}</span><span className={`by ${n.by ?? 'agent'}`}>{n.by === 'user' ? '你设定' : 'Agent 补充'}</span>
    <span className={`s ${n.status}`}>{stateLabel(session, view, id)}</span></button></li>; })}</ul>;
}

/** How a step or test reads in the panel: what goes in, what comes out, how (with its limits), and samples. Plain words only. */
function Spec({ node, session, view, onLocate, onGenerateCases, busy }: { node: NodeState; session: Session; view: Map<string, ViewNode>; onLocate: (id: string) => void; onGenerateCases?: (id: string) => void; busy: boolean }) {
  const isTest = node.kind === 'test';
  const name = (id: string) => view.get(id)?.title ?? id;
  return <>
    <Section title="输入"><p>{node.input}</p>{node.target && <p className="where"><span>在哪</span><span className="mono">{node.target}</span></p>}</Section>
    <Section title="输出">{node.output && <p>{node.output}</p>}
      {!!node.acceptance.length && <ul className="plain outcome">{node.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul>}
      {node.conditionOutcome !== undefined && <p>结果：{node.conditionOutcome === 'unknown' ? '还不确定' : node.conditionOutcome ? '成立' : '不成立'}</p>}</Section>
    <Section title={isTest ? '怎么测' : '怎么做'}><p>{node.mapping || node.action}</p>
      <ul className="plain rules">
        {(node.constraints ?? []).map((item, i) => <li key={i}>{item}</li>)}
        {!!node.dependsOn.length && <li>先等{node.dependsOn.map(id => <button key={id} type="button" className="link-plain" onClick={() => onLocate(id)}>「{name(id)}」</button>)}完成</li>}
        {node.when && <li>只在<button type="button" className="link-plain" onClick={() => onLocate(node.when!.nodeId)}>「{name(node.when.nodeId)}」</button>{node.when.outcome ? '成立' : '不成立'}时做</li>}
        {node.failure && <li>没做到：{node.failure}</li>}
      </ul></Section>
    <Section title="测试样例">{node.cases?.length
      ? caseKinds.map(([k, label]) => { const rows = node.cases!.filter(c => c.kind === k); return <div key={k} className="case-group" data-case-kind={k}>
          <h4>{label}</h4>
          {rows.length ? <ul className="cases">{rows.map((c, i) => <li key={i}><span className="in">{c.input}</span><span className="arrow" aria-label="得到">→</span><span className="out">{c.expected}</span></li>)}</ul> : <p className="note">暂无</p>}
        </div>; })
      : <p className="note">还没有样例。</p>}
      {onGenerateCases && (!node.cases?.length || caseKinds.some(([k]) => !node.cases!.some(c => c.kind === k))) && <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => onGenerateCases(node.id)}>让 Agent 补样例</button></div>}
    </Section>
  </>;
}

function Details(props: NodeInspectorProps & { node: NodeState; view: Map<string, ViewNode> }) {
  const { node, session, view, onLocate } = props;
  const kids = view.get(node.id)?.children ?? [];
  const attempts = session.attempts.filter(attempt => attempt.nodeId === node.id);
  const agent = session.agents.find(item => item.id === node.agentId);
  if (node.parentId === null) return <>
    <Section><p>{session.goal}</p></Section>
    {!!session.clarifications?.length && <Section title="已确认的要求"><dl className="qa">{session.clarifications.map((item, index) => <div key={index}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl></Section>}
    {props.taskActions && <Section><div className="decision">{props.taskActions}</div></Section>}
    <Section title="Agent 分工"><ul className="agents">{session.agents.map(a => <li key={a.id}><Avatar session={session} agentId={a.id} /><div><strong>{a.name}</strong> · {a.role}<p>负责：{a.scope}</p><p>上限：{a.budget}</p></div></li>)}</ul></Section>
    {!!session.context.length && <details className="panel-section fold"><summary>上下文依据</summary><ul>{session.context.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
  </>;
  if (node.kind === 'result') {
    const tests = kids.filter(id => view.get(id)?.node?.kind === 'test'), workId = kids.find(id => view.get(id)?.kind === 'work');
    return <>
      <Section title="要达到的效果"><p>{node.action}</p></Section>
      <Section title="测试"><TestRows session={session} view={view} ids={tests} onLocate={onLocate} /><p className="note">你设定的测试是验收标准；Agent 补充的只是额外检查。</p></Section>
      <Section title="证据">{tests.map(id => { const t = view.get(id)!.node!; return (t.evidence?.length || t.attemptId) ? <div key={id} className="evidence-group"><h4>{t.title}</h4><Evidence node={t} session={session} /></div> : null; })}
        {!tests.some(id => view.get(id)?.node?.evidence?.length) && <p className="note">还没有证据。</p>}</Section>
      {workId && <details className="panel-section fold"><summary>Agent 工作 · {view.get(workId)!.children.length} 步 · {stateLabel(session, view, workId)}</summary><Links session={session} view={view} ids={view.get(workId)!.children} onLocate={onLocate} /></details>}
    </>;
  }
  if (node.kind === 'test') {
    const result = view.get(node.parentId!)?.kind === 'result' ? node.parentId! : undefined;
    const fixing = node.status === 'failed' && result ? activeAttempts(session).find(a => viewDescendants(view, result).includes(a.nodeId) && session.nodes.find(n => n.id === a.nodeId)?.kind !== 'test') : undefined;
    return <>
      <Live session={session} nodeId={node.id} />
      {node.result && <Section><div className={`callout ${node.status === 'failed' ? 'fail' : node.status === 'passed' ? 'pass' : ''}`}><p>{node.result}</p></div></Section>}
      <Spec node={node} session={session} view={view} onLocate={onLocate} onGenerateCases={props.onGenerateCases} busy={props.busy} />
      <Section title="证据"><Evidence node={node} session={session} /></Section>
      {fixing && <Section title="处理"><p>Agent 正在自动修复，你不用处理：</p><Live session={session} nodeId={fixing.nodeId} /><Links session={session} view={view} ids={[fixing.nodeId]} onLocate={onLocate} /></Section>}
      {result && <Section title="所属效果"><Links session={session} view={view} ids={[result]} onLocate={onLocate} /></Section>}
      <Messages session={session} nodeId={node.id} />
    </>;
  }
  if (isContainer(node)) return <>
    {node.action && <Section><p>{node.action}</p></Section>}
    <Section title="包含"><Links session={session} view={view} ids={kids} onLocate={onLocate} /></Section>
  </>;
  return <>
    <Live session={session} nodeId={node.id} />
    {node.result && <Section><div className={`callout ${node.status === 'failed' ? 'fail' : node.status === 'passed' ? 'pass' : ''}`}><p>{node.result}</p></div></Section>}
    <Spec node={node} session={session} view={view} onLocate={onLocate} onGenerateCases={props.onGenerateCases} busy={props.busy} />
    {(node.evidence?.length || node.attemptId) ? <Section title="证据"><Evidence node={node} session={session} /></Section> : null}
    <Messages session={session} nodeId={node.id} />
    {agent && <details className="panel-section fold"><summary>Agent 负责什么</summary><dl className="fields"><div><dt>负责</dt><dd>{agent.scope}</dd></div><div><dt>上限</dt><dd>{agent.budget}</dd></div></dl></details>}
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

function Shell({ session, view, id, title, status, menu, onClose, busy, children, foot }: {
  session: Session; view: Map<string, ViewNode>; id: string; title: string; status: ReactNode; menu?: ReactNode; onClose: () => void; busy: boolean; children: ReactNode; foot?: ReactNode;
}) {
  return <aside className="node-inspector" aria-label="节点详情" data-inspector-node={id}
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

  if (nodeId === ACCEPT_ID) {
    const results = session.nodes.filter(n => n.kind === 'result');
    const reviewing = session.status === 'review';
    return <Shell session={session} view={view} id={ACCEPT_ID} title="用户验收" status={status(ACCEPT_ID)} onClose={onClose} busy={busy} foot={props.taskActions}>
      <Section><p>逐项查看每个效果的测试与证据。{reviewing ? '某一项不满意时，只退回这一项。' : 'Agent 全部完成并提交验收后，这里才能验收。'}</p></Section>
      {results.map(r => { const tests = (view.get(r.id)?.children ?? []).filter(id => view.get(id)?.node?.kind === 'test'); return <section key={r.id} className="panel-section accept-item">
        <h3><button type="button" className="link-plain" onClick={() => onLocate(r.id)}><Glyph session={session} view={view} id={r.id} size={15} />{r.title}</button></h3>
        <TestRows session={session} view={view} ids={tests} onLocate={onLocate} />
        {reviewing && <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => props.onAskAi(r.id, true)}>退回这一项</button></div>}
      </section>; })}
      {!results.length && <Section><p className="note">没有标出效果，请直接看各节点的结果。</p></Section>}
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
  const title = mode === 'add' ? `添加到「${node.title}」` : mode === 'edit' ? `编辑「${node.title}」` : node.title;
  const nodeStatus = mode === 'detail' && current ? <>{status(nodeId)}{node.kind === 'test' && <span className={`by ${node.by ?? 'agent'}`}>{node.by === 'user' ? '你设定' : 'Agent 补充'}</span>}
    {!isContainer(node) && node.parentId !== null && <span className="agent"><Avatar session={session} agentId={node.agentId} /><span className="name">{session.agents.find(a => a.id === node.agentId)?.name ?? node.agentId}</span></span>}</> : null;
  const menu = mode === 'detail' && current ? <div className="menu-wrap"><button type="button" className="icon-btn" aria-label="节点操作" aria-expanded={menuOpen} aria-haspopup="menu" disabled={busy} onClick={() => setMenuOpen(!menuOpen)}>
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg></button>
    {menuOpen && <><div className="menu-dismiss" onClick={() => setMenuOpen(false)} aria-hidden="true" /><div className="menu" role="menu" aria-label="节点操作">
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onEdit(); }}>{node.kind === 'test' ? '编辑测试' : '编辑内容'}</button>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onAskAi(nodeId); }}>让 AI 修改</button>
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
    : current.status === 'failed' && !isContainer(current) ? <button type="button" className="btn primary" disabled={busy} onClick={() => props.onAskAi(nodeId)}>让 AI 修正</button>
    : node.parentId === null ? undefined : isContainer(current) ? <button type="button" className="btn" disabled={busy} onClick={() => props.onAskAi(nodeId)}>让 AI 修改</button>
    : <><button type="button" className="btn" disabled={busy} onClick={() => props.onAskAi(nodeId)}>让 AI 修改</button><button type="button" className="btn" disabled={busy} onClick={props.onEdit}>编辑</button></>;
  return <Shell session={session} view={view} id={nodeId} title={title} status={nodeStatus} menu={menu} onClose={onClose} busy={busy} foot={foot}>
    <div ref={contentRef} data-inspector-mode={mode}>
      {mode === 'detail' ? current ? <>
        {confirmDelete && <DeletionConfirmation node={current} {...props} onCancel={() => setConfirmDelete(false)} />}
        <Details key={current.id} {...props} node={current} view={view} />
      </> : <p role="status">此节点已在最新版本中删除。</p>
        : <Editor key={`${nodeId}:${mode}`} node={mode === 'add' ? newNode : node} session={session} busy={busy}
            editRevision={editRevision} onSave={props.onSave} onCancel={onClose} adding={mode === 'add'} />}
    </div>
  </Shell>;
}
