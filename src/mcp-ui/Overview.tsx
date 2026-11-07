import React, { useMemo, type ReactNode } from 'react';
import type { Session } from '../mcp/schema';
import { ACCEPT_ID, agentColor, aggregateStatus, buildView, counts, stateLabel, type ViewNode } from './canvas-model';
import { currentWork } from './collaboration-model';
import { Avatar, Glyph, MiniBar } from './TreeCanvas';
import './overview.css';

export const EXPAND_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 9 5-5 5 5M7 15l5 5 5-5" /></svg>;

/** What the overview lists along the trunk: the results a person checks, or the trunk step itself when it holds none. */
function trunkItems(view: Map<string, ViewNode>, rootId: string): { group?: string; ids: string[] }[] {
  const root = view.get(rootId);
  if (!root) return [];
  return root.children.map(id => {
    const v = view.get(id)!;
    if (v.kind === 'result' || v.kind === 'accept') return { ids: [id] };
    const results = v.children.filter(c => view.get(c)?.kind === 'result');
    return results.length ? { group: v.title, ids: results } : { ids: [id] };
  });
}

/**
 * Folded view: one line of task state, the chain of results ending in user acceptance, and what the agents are doing.
 * Selecting a result expands the tree at that node.
 */
export function Overview({ session, onExpand, taskActions }: { session: Session; onExpand: (nodeId?: string) => void; taskActions?: ReactNode }) {
  const view = useMemo(() => buildView(session), [session]);
  const root = session.nodes.find(n => n.parentId === null);
  if (!root) return null;
  const all = counts(session, view, ACCEPT_ID);
  const items = trunkItems(view, root.id);
  const work = currentWork(session);
  const failing = session.nodes.filter(n => n.kind === 'test' && n.status === 'failed');
  const waiting = session.status === 'draft' ? `等待你批准 v${session.revision}` : session.status === 'review' ? '已提交验收，等待你逐项查看' : session.status === 'paused' ? '已暂停' : session.status === 'accepted' ? '已验收' : '';
  const action = (a: (typeof work)[number]) => [...(session.activities ?? [])].reverse().find(x => x.attemptId === a.attempt.id && x.kind === 'action')?.summary;

  return <section className="overview" aria-label="执行树概览">
    <header className="overview-head">
      <Glyph session={session} view={view} id={root.id} size={18} />
      <h1>{session.title}</h1>
      <span className="overview-state">{stateLabel(session, view, root.id)}</span>
      {all.total > 0 && <span className="overview-progress"><MiniBar c={all} wide /><span>{all.passed} / {all.total} 项测试通过</span></span>}
      <button type="button" className="tool" data-expand-tree aria-label="展开详情" title="展开详情" onClick={() => onExpand()}>{EXPAND_ICON}</button>
    </header>
    <ol className="overview-chain" aria-label="要达到的效果">
      {items.map((item, i) => <li key={i} className={item.group ? 'grouped' : undefined}>
        {item.group && <span className="overview-group">{item.group}</span>}
        <span className="overview-chips">{item.ids.map(id => {
          const v = view.get(id)!, c = counts(session, view, id), status = aggregateStatus(session, view, id);
          const live = work.find(w => id === w.attempt.nodeId || view.get(w.attempt.nodeId)?.parentId === id || session.nodes.find(n => n.id === w.attempt.nodeId)?.parentId === id);
          return <button type="button" key={id} className="overview-chip" data-node={id} data-state={status} data-kind={v.kind}
            style={live ? { '--agent': agentColor(session, live.attempt.agentId) } as React.CSSProperties : undefined}
            title={`${v.title}：${stateLabel(session, view, id)}`} onClick={() => onExpand(id)}>
            <Glyph session={session} view={view} id={id} size={14} /><span className="t">{v.title}</span>
            {v.kind === 'accept' ? <span className="n">{stateLabel(session, view, id)}</span> : c.total > 0 && <span className="n">{c.passed}/{c.total}</span>}
          </button>;
        })}</span>
      </li>)}
    </ol>
    <div className="overview-live">
      {work.slice(0, 2).map(w => <span key={w.attempt.id} className="overview-doing" style={{ '--agent': agentColor(session, w.attempt.agentId) } as React.CSSProperties}>
        <Avatar session={session} agentId={w.attempt.agentId} /><strong>{w.agent?.name ?? w.attempt.agentId}</strong>
        <span>{action(w) ?? '已领取'}</span><button type="button" className="link" onClick={() => onExpand(w.attempt.nodeId)}>{session.nodes.find(n => n.id === w.attempt.nodeId)?.title}</button>
      </span>)}
      {work.length > 2 && <span className="overview-more">另有 {work.length - 2} 个 Agent 在工作</span>}
      {!work.length && waiting && <span className="overview-waiting">{waiting}</span>}
      {!!failing.length && <button type="button" className="overview-issue" onClick={() => onExpand(failing[0].id)}>{failing.length} 项测试未通过</button>}
      {taskActions && (session.status === 'draft' || session.status === 'review' || session.status === 'paused') && <span className="overview-actions">{taskActions}</span>}
    </div>
  </section>;
}
