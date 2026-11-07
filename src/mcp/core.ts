import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  activitySchema, claimSchema, proposeSchema, reportSchema, submitSchema, userActionSchema,
  type ActivityInput, type AgentActivity, type AgentSpec, type ArborunEvent, type ArborunSnapshot, type AttemptView, type ClaimInput,
  type NodeSpec, type NodeState, type ProposeInput, type ReportInput, type Session,
  type PlanClarification, type SubmitInput, type UserActionInput,
} from './schema';

const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Containers hold other nodes and are never claimed: plain groups and visible results. */
export const isContainer = (node: Pick<NodeSpec, 'kind'>) => node.kind === 'group' || node.kind === 'result';
const spec = (node: NodeSpec): NodeSpec => ({
  id: node.id, parentId: node.parentId, kind: node.kind, ...(node.by ? { by: node.by } : {}), title: node.title,
  action: node.action, target: node.target, input: node.input, acceptance: [...node.acceptance],
  failure: node.failure, dependsOn: [...node.dependsOn], ...(node.when ? { when: clone(node.when) } : {}), agentId: node.agentId,
  ...(node.output ? { output: node.output } : {}), ...(node.mapping ? { mapping: node.mapping } : {}),
  ...(node.constraints?.length ? { constraints: [...node.constraints] } : {}), ...(node.cases?.length ? { cases: node.cases.map(c => ({ ...c })) } : {}),
});
function planHash(session: Session): string {
  return hash({ title: session.title, goal: session.goal, context: session.context, nodes: session.nodes.map(spec), agents: session.agents,
    ...(session.clarifications?.length ? { clarifications: session.clarifications } : {}) });
}

function confirmedClarifications(values: { question: string; answer?: string }[] = []): PlanClarification[] {
  const unanswered = values.filter(item => !item.answer?.trim());
  if (unanswered.length) throw new Error(`请先由 Codex 在对话中询问并确认以下问题，再生成执行树：${unanswered.map(item => item.question).join('；')}`);
  return values.map(item => ({ question: item.question, answer: item.answer!.trim() }));
}
function ancestorNodes(node: NodeSpec, nodes: NodeSpec[]): NodeSpec[] {
  const result: NodeSpec[] = [];
  let parent = node.parentId;
  while (parent !== null) {
    const found = nodes.find(n => n.id === parent);
    if (!found) throw new Error(`父节点不存在：${parent}`);
    if (result.some(n => n.id === found.id) || found.id === node.id) throw new Error('树包含循环父子关系');
    result.push(found); parent = found.parentId;
  }
  return result;
}
function guards(node: NodeSpec, nodes: NodeSpec[]): NonNullable<NodeSpec['when']>[] {
  return [node, ...ancestorNodes(node, nodes)].flatMap(n => n.when ? [n.when] : []);
}

/** The host executes actions. This validates Arborun's reporting and approval workflow only. */
export function validatePlan(nodes: NodeSpec[], agents: AgentSpec[]): void {
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new Error('节点 ID 不得重复');
  const roots = nodes.filter(n => n.parentId === null);
  if (roots.length !== 1 || roots[0].kind !== 'group') throw new Error('需要唯一的分组根节点');
  const agentIds = new Set(agents.map(a => a.id));
  if (agentIds.size !== agents.length) throw new Error('Agent ID 不得重复');
  for (const agent of agents) {
    const seen = new Set([agent.id]); let current = agent;
    while (current.parentId) {
      if (seen.has(current.parentId)) throw new Error('Agent 层级存在循环');
      seen.add(current.parentId);
      const parent = agents.find(a => a.id === current.parentId);
      if (!parent) throw new Error(`父 Agent 不存在：${current.parentId}`);
      current = parent;
    }
  }
  for (const node of nodes) {
    const parents = ancestorNodes(node, nodes);
    if (parents.some(n => !['group', 'result', 'agent'].includes(n.kind))) throw new Error('只有分组、效果或 Agent 节点可以包含子节点');
    if (node.kind === 'result' && !node.action.trim()) throw new Error(`请写明要达到的效果：${node.title}`);
    if (!isContainer(node) && (!node.action.trim() || !node.target.trim() || !node.input.trim() || !node.failure.trim() || !node.acceptance.length)) {
      throw new Error(`请补齐动作、对象、输入、通过条件与失败处理：${node.title}`);
    }
    if (node.by && node.kind !== 'test') throw new Error('只有测试节点可以标注设定者');
    if (!isContainer(node) && !agentIds.has(node.agentId)) throw new Error(`执行 Agent 未声明：${node.agentId}`);
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error('依赖节点不得重复');
    if (isContainer(node) && node.dependsOn.length) throw new Error('分组或效果不能声明执行依赖，请将依赖放在具体步骤');
    for (const dependency of node.dependsOn) {
      const found = nodes.find(n => n.id === dependency);
      if (!found) throw new Error(`依赖节点不存在：${dependency}`);
      if (isContainer(found)) throw new Error('执行依赖须指向具体步骤');
    }
    for (const guard of guards(node, nodes)) {
      if (nodes.find(n => n.id === guard.nodeId)?.kind !== 'condition') throw new Error('分支条件必须引用条件节点');
    }
  }
  if (nodes.some(node => isContainer(node) && !nodes.some(n => n.parentId === node.id))) throw new Error('分组至少需要一个子节点');
  for (const result of nodes.filter(n => n.kind === 'result')) {
    const inside = (n: NodeSpec) => ancestorNodes(n, nodes).some(a => a.id === result.id);
    if (!nodes.some(n => n.kind === 'test' && inside(n))) throw new Error(`效果至少需要一个测试来证明：${result.title}`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: NodeSpec) => {
    if (visiting.has(node.id)) throw new Error('执行依赖或条件存在循环');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    const childWork = node.kind === 'agent' ? nodes.filter(n => !isContainer(n) && ancestorNodes(n, nodes).some(a => a.id === node.id)).map(n => n.id) : [];
    for (const dependency of new Set([...node.dependsOn, ...guards(node, nodes).map(g => g.nodeId), ...childWork])) visit(nodes.find(n => n.id === dependency)!);
    visiting.delete(node.id); visited.add(node.id);
  };
  nodes.forEach(visit);
  if (!nodes.some(n => !isContainer(n))) throw new Error('至少需要一个具体执行步骤');
}

/** Tests the person set are the acceptance contract: an agent's plan update may add tests but never edit or drop these. */
export function assertUserTestsKept(previous: NodeSpec[], next: NodeSpec[]): void {
  const fields = (n: NodeSpec) => hash({ title: n.title, action: n.action, target: n.target, input: n.input, acceptance: n.acceptance, failure: n.failure });
  for (const test of previous.filter(n => n.kind === 'test' && n.by === 'user')) {
    const kept = next.find(n => n.id === test.id);
    if (!kept || kept.kind !== 'test' || kept.by !== 'user' || fields(kept) !== fields(test)) {
      throw new Error(`用户设定的测试不能由 Agent 修改或删除：${test.title}。如需调整，请让用户在树中编辑。`);
    }
  }
}

function subtreeIds(nodes: NodeSpec[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const n of nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); grew = true; } }
  return ids;
}

/** Which of the four parts (input, output, description, tests) a plan still leaves blank, per node, in plain words. */
export function planGaps(nodes: NodeSpec[]): string[] {
  const names = { normal: '正常情况', boundary: '边界情况', extreme: '极端情况' } as const;
  return nodes.flatMap(node => {
    const missing: string[] = [];
    if (!node.input.trim()) missing.push('输入');
    if (!(node.output || (node.kind === 'result' && node.action.trim()))) missing.push('输出');
    if (!node.mapping) missing.push('描述');
    if (!isContainer(node)) for (const [kind, name] of Object.entries(names)) if (!node.cases?.some(c => c.kind === kind)) missing.push(`${name}样例`);
    return missing.length ? [`「${node.title}」（${node.id}）：缺${missing.join('、')}`] : [];
  });
}

/** Planning uses two models only: sonnet for simple work, opus for hard work. */
export const PLAN_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
export function modelGaps(agents: AgentSpec[]): string[] {
  return agents.filter(a => !a.model || !PLAN_MODELS.includes(a.model)).map(a => `「${a.name}」（${a.id}）的模型应为 claude-sonnet-5-5（简单）或 claude-opus-5-5（难）`);
}

/** Stages that look too coarse for long work: an outcome produced by a single step. */
export function coarseStages(nodes: NodeSpec[]): string[] {
  return nodes.filter(n => n.kind === 'result').flatMap(result => {
    const ids = new Set([result.id]);
    for (let grew = true; grew;) { grew = false; for (const n of nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); grew = true; } }
    const steps = nodes.filter(n => ids.has(n.id) && n.kind === 'action').length;
    return steps < 2 ? [`「${result.title}」（${result.id}）只有 ${steps} 个步骤`] : [];
  });
}

export class ArborunService {
  private state: ArborunSnapshot;
  constructor(snapshot?: ArborunSnapshot, options: { recover?: boolean } = {}) {
    this.state = snapshot ? clone(snapshot) : { version: 1, sessions: [], grants: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.sessions) || !Array.isArray(this.state.grants)) throw new Error('不支持的 Arborun 数据格式');
    if (new Set(this.state.sessions.map(s => s.id)).size !== this.state.sessions.length) throw new Error('重复的任务 ID');
    for (const session of this.state.sessions) {
      const plan = proposeSchema.parse({ title: session.title, goal: session.goal, context: session.context, nodes: session.nodes.map(spec), agents: session.agents, clarifications: session.clarifications });
      session.clarifications = confirmedClarifications(plan.clarifications);
      session.activities ??= [];
      validatePlan(plan.nodes, plan.agents);
      if (!Number.isInteger(session.revision) || session.revision < 1 || !Array.isArray(session.events) || !Array.isArray(session.attempts) || !Array.isArray(session.history)) throw new Error('任务数据损坏');
      if (session.approval && (session.approval.revision !== session.revision || session.approval.hash !== planHash(session))) throw new Error('批准版本与计划不匹配');
      if (options.recover && session.attempts.some(a => a.status === 'running')) {
        this.invalidateRunning(session, '服务重启，宿主动作状态待核对', true);
        session.status = 'paused'; session.approval = undefined;
        this.event(session, 'recovered', '服务重启，已暂停领取；请核对宿主动作后重新批准。', 'arborun');
      }
      this.refresh(session);
    }
  }
  snapshot(): ArborunSnapshot { return clone(this.state); }
  list(): Session[] { return clone(this.state.sessions); }
  get(sessionId: string): Session { return clone(this.requireSession(sessionId)); }
  private requireSession(id: string): Session {
    const session = this.state.sessions.find(s => s.id === id);
    if (!session) throw new Error('任务不存在');
    return session;
  }
  private transaction(id: string, action: (session: Session) => void): Session {
    const original = this.requireSession(id), next = clone(original);
    action(next); this.refresh(next); next.updatedAt = now();
    this.state.sessions[this.state.sessions.indexOf(original)] = next;
    return clone(next);
  }
  private event(session: Session, type: string, message: string, provenance: ArborunEvent['provenance'], extra: Partial<ArborunEvent> = {}) {
    session.events.push({ sequence: (session.events.at(-1)?.sequence ?? 0) + 1, id: randomUUID(), at: now(), revision: session.revision, type, message, provenance, ...extra });
    session.updatedAt = now();
  }
  private history(session: Session) {
    session.history.push({ revision: session.revision, title: session.title, goal: session.goal, context: clone(session.context), nodes: session.nodes.map(spec), agents: clone(session.agents), clarifications: clone(session.clarifications ?? []), at: now() });
  }
  private assertRevision(session: Session, revision: number | undefined) {
    if (revision !== session.revision) throw new Error(`计划已更新，请读取当前版本 ${session.revision} 后重试`);
  }
  private assertApproved(session: Session, revision: number) {
    this.assertRevision(session, revision);
    if (!session.approval || session.approval.revision !== revision || session.approval.hash !== planHash(session) || !['approved', 'running'].includes(session.status)) {
      throw new Error('当前计划尚未获用户批准或已暂停');
    }
  }
  /** A node, everything inside it, and everything that depends on any of those, transitively. */
  private downstream(session: Session, id: string): Set<string> {
    const out = subtreeIds(session.nodes, id);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of session.nodes) {
        if (out.has(n.id)) continue;
        if (n.dependsOn.some(d => out.has(d)) || (n.when && out.has(n.when.nodeId))) { for (const x of subtreeIds(session.nodes, n.id)) out.add(x); grew = true; }
      }
    }
    return out;
  }
  private invalidateRunning(session: Session, message: string, interrupted = false) {
    for (const attempt of session.attempts.filter(a => a.status === 'running')) {
      attempt.status = interrupted ? 'interrupted' : 'stale'; attempt.invalidated = true; attempt.endedAt = now();
      const node = session.nodes.find(n => n.id === attempt.nodeId);
      if (node?.attemptId === attempt.id) { node.status = 'stale'; node.result = message; node.conditionOutcome = undefined; }
    }
  }
  private guardState(node: NodeSpec, session: Session): 'active' | 'inactive' | 'unknown' {
    let unknown = false;
    for (const guard of guards(node, session.nodes)) {
      const condition = session.nodes.find(n => n.id === guard.nodeId)!;
      if (condition.status === 'skipped') return 'inactive';
      if (condition.status !== 'passed' || typeof condition.conditionOutcome !== 'boolean') { unknown = true; continue; }
      if (condition.conditionOutcome !== guard.outcome) return 'inactive';
    }
    return unknown ? 'unknown' : 'active';
  }
  private dependenciesReady(node: NodeSpec, session: Session): boolean {
    return node.dependsOn.every(id => ['passed', 'skipped'].includes(session.nodes.find(n => n.id === id)!.status));
  }
  private refresh(session: Session) {
    const approved = Boolean(session.approval && ['approved', 'running'].includes(session.status));
    // Iterate because an inactive condition branch can make its dependent branches inactive.
    for (let pass = 0; pass < session.nodes.length; pass++) {
      let changed = false;
      for (const node of session.nodes.filter(n => !isContainer(n))) {
        const guard = this.guardState(node, session);
        if (guard === 'inactive' && !['running', 'passed'].includes(node.status)) {
          if (node.status !== 'skipped') changed = true;
          node.status = 'skipped'; node.result = '条件分支不适用'; node.conditionOutcome = undefined;
        } else if (!['running', 'passed', 'failed', 'blocked', 'stale'].includes(node.status)) {
          const next = approved && guard === 'active' && this.dependenciesReady(node, session) ? 'ready' : 'draft';
          if (node.status !== next) changed = true;
          node.status = next;
        }
      }
      if (!changed) break;
    }
    for (const group of session.nodes.filter(isContainer).sort((a, b) => ancestorNodes(b, session.nodes).length - ancestorNodes(a, session.nodes).length)) {
      const children = session.nodes.filter(n => n.parentId === group.id);
      if (this.guardState(group, session) === 'inactive') group.status = 'skipped';
      else if (children.some(n => n.status === 'running')) group.status = 'running';
      else if (children.some(n => n.status === 'failed')) group.status = 'failed';
      else if (children.some(n => n.status === 'blocked')) group.status = 'blocked';
      else if (children.length && children.every(n => ['passed', 'skipped'].includes(n.status))) group.status = 'passed';
      else if (children.some(n => n.status === 'stale')) group.status = 'stale';
      else group.status = approved ? 'ready' : 'draft';
    }
  }
  private replacePlan(session: Session, plan: { title: string; goal: string; context: string[]; nodes: NodeSpec[]; agents: AgentSpec[]; clarifications?: { question: string; answer?: string }[] }, provenance: ArborunEvent['provenance']) {
    validatePlan(plan.nodes, plan.agents);
    const clarifications = confirmedClarifications(plan.clarifications ?? session.clarifications);
    const oldNodes = clone(session.nodes);
    const changed = new Set<string>();
    const allChanged = session.goal !== plan.goal || hash(session.context) !== hash(plan.context) || hash(session.clarifications ?? []) !== hash(clarifications);
    const changedAgents = new Set([...session.agents, ...plan.agents].filter(a => hash(session.agents.find(old => old.id === a.id) ?? null) !== hash(plan.agents.find(next => next.id === a.id) ?? null)).map(a => a.id));
    for (const node of [...oldNodes, ...plan.nodes]) {
      const old = oldNodes.find(n => n.id === node.id), next = plan.nodes.find(n => n.id === node.id);
      if (allChanged || !old || !next || hash(spec(old)) !== hash(spec(next)) || changedAgents.has(node.agentId)) changed.add(node.id);
    }
    // Active work cannot be carried into a newly approved version, even when its text is unchanged.
    for (const attempt of session.attempts.filter(a => a.status === 'running')) changed.add(attempt.nodeId);
    for (let pass = 0; pass < oldNodes.length + plan.nodes.length; pass++) {
      const size = changed.size;
      for (const node of [...oldNodes, ...plan.nodes]) {
        if ((node.parentId && changed.has(node.parentId)) || node.dependsOn.some(d => changed.has(d)) || (node.when && changed.has(node.when.nodeId))) changed.add(node.id);
        if (node.kind === 'agent') {
          const graph = oldNodes.includes(node as NodeState) ? oldNodes : plan.nodes;
          if (graph.some(child => changed.has(child.id) && ancestorNodes(child, graph).some(parent => parent.id === node.id))) changed.add(node.id);
        }
      }
      if (changed.size === size) break;
    }
    this.invalidateRunning(session, '计划修改后原执行已失效；宿主外部动作可能仍需核对。');
    session.revision += 1; session.approval = undefined; session.review = undefined; session.status = 'draft';
    session.title = plan.title; session.goal = plan.goal; session.context = clone(plan.context); session.agents = clone(plan.agents); session.clarifications = clarifications;
    session.nodes = plan.nodes.map(node => {
      const old = oldNodes.find(n => n.id === node.id);
      if (old && !changed.has(node.id) && old.status === 'passed') return { ...clone(old), ...clone(node) };
      return { ...clone(node), status: old && (old.attemptId || ['passed', 'stale'].includes(old.status)) ? 'stale' : 'draft' };
    });
    session.aiRequests = []; this.history(session);
    this.event(session, 'plan_changed', `计划更新为版本 ${session.revision}，原批准已撤销；${changed.size} 个节点受到影响。`, provenance);
  }
  propose(input: ProposeInput): Session {
    const parsed = proposeSchema.parse(input); confirmedClarifications(parsed.clarifications); validatePlan(parsed.nodes, parsed.agents);
    if (parsed.sessionId) return this.transaction(parsed.sessionId, session => {
      this.assertRevision(session, parsed.expectedRevision);
      assertUserTestsKept(session.nodes, parsed.nodes);
      this.replacePlan(session, parsed, 'agent_reported');
    });
    if (parsed.expectedRevision !== undefined) throw new Error('新任务不能携带旧版本');
    const timestamp = now();
    const session: Session = {
      id: randomUUID(), title: parsed.title, goal: parsed.goal, context: parsed.context, revision: 1, status: 'draft',
      nodes: parsed.nodes.map(n => ({ ...n, status: 'draft' })), agents: parsed.agents,
      attempts: [], events: [], activities: [], clarifications: confirmedClarifications(parsed.clarifications), aiRequests: [], history: [], createdAt: timestamp, updatedAt: timestamp,
    };
    this.history(session); this.event(session, 'plan_created', '计划已生成，等待用户修改或批准。', 'agent_reported');
    this.refresh(session); this.state.sessions.push(session); return clone(session);
  }
  claim(input: ClaimInput): { session: Session; attemptId: string; claimToken: string } {
    const parsed = claimSchema.parse(input), attemptId = randomUUID(), claimToken = randomUUID();
    const session = this.transaction(parsed.sessionId, task => {
      this.assertApproved(task, parsed.revision);
      const node = task.nodes.find(n => n.id === parsed.nodeId);
      if (!node || isContainer(node)) throw new Error('只能领取具体执行节点');
      if (!task.agents.some(a => a.id === parsed.agentId) || node.agentId !== parsed.agentId) throw new Error('该 Agent 未声明或未分配此节点');
      if (['running', 'passed', 'skipped'].includes(node.status)) throw new Error('节点已领取、通过或不适用');
      if (this.guardState(node, task) !== 'active') throw new Error('条件分支尚未成立');
      if (!this.dependenciesReady(node, task)) throw new Error('前置依赖尚未通过');
      const attempt: AttemptView = { id: attemptId, nodeId: node.id, agentId: parsed.agentId, revision: task.revision, approvalId: task.approval!.id,
        specification: spec(node), status: 'running', startedAt: now(), evidence: [], checks: [], provenance: 'agent_reported' };
      task.attempts.push(attempt); task.status = 'running';
      node.status = 'running'; node.attemptId = attemptId; node.result = undefined; node.evidence = []; node.conditionOutcome = undefined; node.caseResults = undefined;
      this.event(task, 'node_started', `${node.title}：宿主 Agent 已领取，等待实际执行记录。`, 'agent_reported', { nodeId: node.id, agentId: parsed.agentId, attemptId });
    });
    this.state.grants.push({ attemptId, token: claimToken });
    return { session, attemptId, claimToken };
  }
  report(input: ReportInput): Session {
    const parsed = reportSchema.parse(input), digest = hash(parsed);
    // Long command output keeps its last part: that is where results and errors appear.
    for (const r of parsed.caseResults) for (const p of r.proof) if (p.output && p.output.length > 8000) p.output = `…（前面省略 ${p.output.length - 8000} 字）\n${p.output.slice(-8000)}`;
    return this.transaction(parsed.sessionId, session => {
      const duplicate = session.events.find(event => event.id === parsed.eventId);
      if (duplicate) {
        if (duplicate.requestHash !== digest) throw new Error('eventId 已用于不同的上报内容');
        return;
      }
      const attempt = session.attempts.find(a => a.id === parsed.attemptId);
      const grant = this.state.grants.find(g => g.attemptId === parsed.attemptId);
      if (!attempt || !grant || Buffer.byteLength(parsed.claimToken) !== Buffer.byteLength(grant.token) || !timingSafeEqual(Buffer.from(parsed.claimToken), Buffer.from(grant.token))) throw new Error('执行凭证无效');
      if (attempt.status !== 'running' && !attempt.invalidated) throw new Error('此执行已结束');
      if (attempt.lateStatus) throw new Error('失效执行的最终结果已记录');
      const node = session.nodes.find(n => n.id === attempt.nodeId);
      const outdated = Boolean(attempt.invalidated || attempt.revision !== session.revision || session.approval?.id !== attempt.approvalId);
      const cases = attempt.specification.cases ?? [];
      if (new Set(parsed.caseResults.map(r => r.case)).size !== parsed.caseResults.length) throw new Error('同一个测试样例只能上报一个结果');
      if (parsed.caseResults.some(r => r.case >= cases.length)) throw new Error('测试样例编号超出范围：从 0 开始，按 cases 的顺序');
      // Progress reports may add sample results one at a time; a later result for the same sample replaces the earlier one.
      const merged = [...(attempt.caseResults ?? []).filter(r => !parsed.caseResults.some(n => n.case === r.case)), ...clone(parsed.caseResults)].sort((a, b) => a.case - b.case);
      if (!outdated && parsed.status === 'passed') {
        if (parsed.evidence.length === 0 && !merged.some(r => r.proof.length)) throw new Error('通过节点需要提交证据');
        if (cases.some((_, i) => !merged.some(r => r.case === i))) throw new Error('通过前需要上报每个测试样例的结果');
        if (merged.some(r => !r.passed)) throw new Error('有测试样例未通过，节点不能报告通过');
        if (merged.some(r => !r.proof.length)) throw new Error('每个测试样例都需要看得懂的证据：命令行输出、截图、演示录像、文字或链接');
        if (attempt.specification.acceptance.some(criterion => !parsed.checks.some(check => check.criterion === criterion && check.passed))) throw new Error('每项通过条件都需要明确的成功检查与证据');
        if (parsed.checks.some(check => !check.passed || !attempt.specification.acceptance.includes(check.criterion))) throw new Error('检查失败或检查项不属于当前节点');
        if (attempt.specification.kind === 'condition' && typeof parsed.conditionOutcome !== 'boolean') throw new Error('条件节点通过需要明确 true 或 false；unknown 应报告 blocked');
        if (attempt.specification.kind === 'agent' && session.nodes.some(n => !isContainer(n) && ancestorNodes(n, session.nodes).some(a => a.id === attempt.nodeId) && !['passed', 'skipped'].includes(n.status))) {
          throw new Error('子 Agent 分支尚未完成，不能检查采用父节点结果');
        }
      }
      if (attempt.specification.kind !== 'condition' && parsed.conditionOutcome !== undefined) throw new Error('只有条件节点可报告条件结论');
      attempt.summary = parsed.summary; attempt.evidence = clone(parsed.evidence); attempt.checks = clone(parsed.checks);
      if (merged.length) attempt.caseResults = merged;
      if (parsed.conditionOutcome !== undefined) attempt.conditionOutcome = parsed.conditionOutcome;
      if (outdated) {
        attempt.invalidated = true;
        if (parsed.status !== 'progress') { attempt.lateStatus = parsed.status; attempt.endedAt = now(); }
      } else {
        if (parsed.status !== 'progress') { attempt.status = parsed.status; attempt.endedAt = now(); }
        if (node?.attemptId === attempt.id) {
          node.status = parsed.status === 'progress' ? 'running' : parsed.status;
          node.result = parsed.summary; node.evidence = clone(parsed.evidence);
          if (merged.length) node.caseResults = clone(merged);
          if (parsed.conditionOutcome !== undefined) node.conditionOutcome = parsed.conditionOutcome;
        }
      }
      this.event(session, outdated ? 'late_report' : `node_${parsed.status}`, `${outdated ? '旧版本记录：' : ''}${parsed.summary}`, 'agent_reported', {
        id: parsed.eventId, requestHash: digest, nodeId: attempt.nodeId, agentId: attempt.agentId, attemptId: attempt.id, revision: attempt.revision,
      });
    });
  }
  /** Observes actual host actions/messages; this method does not dispatch work or messages. */
  activity(input: ActivityInput): Session {
    const parsed = activitySchema.parse(input), digest = hash(parsed);
    return this.transaction(parsed.sessionId, session => {
      const attempt = session.attempts.find(item => item.id === parsed.attemptId);
      const grant = this.state.grants.find(item => item.attemptId === parsed.attemptId);
      if (!attempt || !grant || Buffer.byteLength(parsed.claimToken) !== Buffer.byteLength(grant.token) || !timingSafeEqual(Buffer.from(parsed.claimToken), Buffer.from(grant.token))) throw new Error('执行凭证无效');
      this.assertApproved(session, attempt.revision);
      const node = session.nodes.find(item => item.id === attempt.nodeId);
      if (attempt.invalidated || attempt.status !== 'running' || session.approval?.id !== attempt.approvalId || node?.attemptId !== attempt.id || node.status !== 'running') throw new Error('协作活动需要当前有效且正在执行的节点');
      const duplicate = session.events.find(event => event.id === parsed.eventId);
      if (duplicate) {
        if (duplicate.requestHash !== digest) throw new Error('eventId 已用于不同的上报内容');
        return;
      }
      const activities = session.activities ??= [];
      const entry: AgentActivity = {
        id: parsed.eventId, sequence: (activities.at(-1)?.sequence ?? 0) + 1, at: now(), revision: session.revision,
        kind: parsed.kind, summary: parsed.summary, nodeId: attempt.nodeId, agentId: attempt.agentId,
        attemptId: attempt.id, ...(parsed.runtimeAgentId ? { runtimeAgentId: parsed.runtimeAgentId } : {}), provenance: 'agent_reported',
      };
      if (parsed.kind === 'action') {
        if (parsed.target !== undefined) entry.target = parsed.target;
      } else if (parsed.kind === 'message_sent') {
        if (!session.agents.some(agent => agent.id === parsed.toAgentId)) throw new Error('消息接收 Agent 未在计划中声明');
        if (parsed.toNodeId && !session.nodes.some(target => target.id === parsed.toNodeId && !isContainer(target) && target.agentId === parsed.toAgentId)) throw new Error('消息目标节点不属于接收 Agent');
        if (activities.some(item => item.revision === session.revision && item.kind === 'message_sent' && item.messageId === parsed.messageId)) throw new Error('messageId 已用于当前版本的其他发送记录');
        entry.messageId = parsed.messageId; entry.toAgentId = parsed.toAgentId;
        if (parsed.toNodeId) entry.toNodeId = parsed.toNodeId;
      } else {
        const sent = activities.find(item => item.revision === session.revision && item.kind === 'message_sent' && item.messageId === parsed.messageId);
        if (!sent) throw new Error('当前版本没有对应的已发送消息');
        if (sent.toAgentId !== attempt.agentId || (sent.toNodeId && sent.toNodeId !== attempt.nodeId)) throw new Error('当前执行节点不是该消息的接收者');
        if (activities.some(item => item.kind === 'message_received' && item.sentActivityId === sent.id)) throw new Error('此消息的接收记录已经存在');
        entry.messageId = parsed.messageId; entry.fromAgentId = sent.agentId; entry.fromNodeId = sent.nodeId;
        entry.toAgentId = attempt.agentId; entry.toNodeId = attempt.nodeId; entry.sentActivityId = sent.id;
      }
      activities.push(entry);
      this.event(session, `activity_${parsed.kind}`, parsed.summary, 'agent_reported', {
        id: parsed.eventId, requestHash: digest, nodeId: attempt.nodeId, agentId: attempt.agentId, attemptId: attempt.id,
      });
    });
  }
  submit(input: SubmitInput): Session {
    const parsed = submitSchema.parse(input);
    return this.transaction(parsed.sessionId, session => {
      if (session.status === 'review' && session.review?.revision === parsed.revision) return;
      this.assertApproved(session, parsed.revision); this.refresh(session);
      if (session.attempts.some(a => a.status === 'running') || session.nodes.some(n => !isContainer(n) && !['passed', 'skipped'].includes(n.status))) throw new Error('还有未完成、失败、未知或失效节点，不能提交验收');
      session.status = 'review';
      session.review = { revision: session.revision, tree: this.tree(session), submittedAt: now() };
      this.event(session, 'submitted', '执行记录已汇总成验收树，等待用户验收。外部动作与证据由宿主 Agent 上报。', 'arborun');
    });
  }
  userAction(input: UserActionInput): Session {
    const parsed = userActionSchema.parse(input);
    return this.transaction(parsed.sessionId, session => {
      this.assertRevision(session, parsed.expectedRevision);
      if (parsed.type === 'approve') {
        if (session.aiRequests.length) throw new Error('存在待处理的修改要求，请先让 AI 更新计划');
        if (session.status === 'accepted' || session.status === 'review') throw new Error('当前任务已提交验收，请先提出修改');
        if (session.approval && ['approved', 'running'].includes(session.status)) return;
        session.approval = { id: randomUUID(), revision: session.revision, hash: planHash(session), at: now() }; session.status = 'approved';
        this.event(session, 'approved', `用户批准计划版本 ${session.revision}。`, 'user_confirmed');
      } else if (parsed.type === 'pause') {
        this.invalidateRunning(session, '用户已暂停；宿主外部动作可能仍需核对。');
        session.approval = undefined; session.status = 'paused'; session.review = undefined;
        this.event(session, 'paused', '用户暂停后续领取；正在进行的外部动作仍由宿主停止或核对。', 'user_confirmed');
      } else if (parsed.type === 'accept') {
        if (session.status === 'accepted') return;
        if (session.status !== 'review' || session.review?.revision !== session.revision) throw new Error('请先完成执行并提交当前版本验收树');
        session.status = 'accepted'; session.review.acceptedAt = now();
        this.event(session, 'accepted', '用户已验收当前结果树。', 'user_confirmed');
      } else if (parsed.type === 'rollback') {
        const target = session.nodes.find(n => n.id === parsed.nodeId);
        if (!target) throw new Error('节点不存在');
        const affected = this.downstream(session, target.id);
        if (!session.nodes.some(n => affected.has(n.id) && n.attemptId)) throw new Error('这个节点还没有执行，不需要回退');
        // Stop all running work, withdraw approval, and send this node and everything built on it back for redo.
        this.invalidateRunning(session, '用户中止执行并回退；宿主外部动作可能仍需核对。');
        session.approval = undefined; session.review = undefined; session.status = 'paused';
        for (const node of session.nodes) if (affected.has(node.id) && !isContainer(node)) {
          node.status = node.attemptId ? 'stale' : 'draft'; node.conditionOutcome = undefined;
        }
        const note = `用户对「${target.title}」（${target.id}）不满意，已中止执行并回退到这里${parsed.message ? `：${parsed.message}` : '。'}`;
        if (parsed.message) session.aiRequests.push(note);
        this.event(session, 'rolled_back', note, 'user_confirmed', { nodeId: target.id });
      } else if (parsed.type === 'edit') {
        this.replacePlan(session, { title: parsed.title ?? session.title, goal: parsed.goal ?? session.goal, context: parsed.context ?? session.context, nodes: parsed.nodes, agents: parsed.agents ?? session.agents }, 'user_confirmed');
      } else {
        this.invalidateRunning(session, '用户提出修改要求，等待新计划。');
        session.revision += 1; session.approval = undefined; session.review = undefined; session.status = 'draft';
        session.aiRequests.push(parsed.message);
        // Natural-language requests can affect any part of the plan until the host resolves them.
        for (const node of session.nodes) if (!isContainer(node)) {
          node.status = node.attemptId ? 'stale' : 'draft'; node.conditionOutcome = undefined;
        }
        this.history(session);
        this.event(session, parsed.type === 'requestAi' ? 'ai_change_requested' : 'changes_requested', parsed.message, 'user_confirmed');
      }
    });
  }
  renderTree(sessionId: string): string { return this.tree(this.requireSession(sessionId)); }
  private tree(session: Session): string {
    const line = (value: string) => value.replace(/\s+/g, ' ');
    const labels: Record<NodeState['status'], string> = { draft: '待执行', ready: '可执行', running: '执行中', passed: '检查通过', failed: '失败', blocked: '阻塞', skipped: '不适用', stale: '结果待重验' };
    const lines = [line(session.title), `├─ 计划版本：${session.revision}`, `├─ 目标：${line(session.goal)}`, '├─ 证据来源：宿主 Agent 上报；未由 Arborun 独立验证外部动作', '├─ Agent 分工'];
    session.agents.forEach((agent, index) => {
      const last = index === session.agents.length - 1;
      lines.push(`│  ${last ? '└─' : '├─'} ${line(agent.name)}（${agent.id}）${agent.parentId ? `｜父 Agent：${agent.parentId}` : ''}`);
      const prefix = last ? '│     ' : '│  │  ';
      const effort = { low: '低', medium: '中', high: '高', xhigh: '很高' } as const;
      const config = [agent.model && `模型 ${agent.model}`, agent.effort && `思考力度 ${effort[agent.effort]}（${agent.effort}）`].filter(Boolean).join('｜');
      lines.push(`${prefix}├─ 分工：${agent.role.replace(/\s+/g, ' ')}`, `${prefix}├─ 范围：${agent.scope.replace(/\s+/g, ' ')}`,
        ...(config ? [`${prefix}├─ 配置：${config}${agent.reason ? `｜理由：${agent.reason.replace(/\s+/g, ' ')}` : ''}`] : []), `${prefix}└─ 预算约定：${agent.budget.replace(/\s+/g, ' ')}`);
    });
    const root = session.nodes.find(n => n.parentId === null)!;
    const visit = (node: NodeState, prefix: string, last: boolean) => {
      lines.push(`${prefix}${last ? '└─' : '├─'} ${line(node.title)}（${node.id}）｜${labels[node.status]}${node.kind === 'test' ? `｜${node.by === 'user' ? '用户设定' : 'Agent 补充'}` : ''}${!isContainer(node) ? `｜${line(session.agents.find(a => a.id === node.agentId)?.name ?? node.agentId)}` : ''}`);
      const indent = prefix + (last ? '   ' : '│  ');
      const children = session.nodes.filter(n => n.parentId === node.id);
      const details: string[] = [];
      if (node.when) details.push(`触发条件：${node.when.nodeId} = ${node.when.outcome}`);
      if (node.kind === 'result') details.push(`要达到的效果：${node.action}`);
      if (!isContainer(node)) {
        details.push(`动作：${node.action}`, `对象：${node.target}`, `输入：${node.input}`);
        if (node.output) details.push(`输出：${node.output}`);
        if (node.mapping || node.constraints?.length) details.push(`怎么做：${[node.mapping, ...(node.constraints ?? []).map(c => `注意${c}`)].filter(Boolean).join('；')}`);
        details.push(`通过条件：${node.acceptance.join('；')}`, `失败处理：${node.failure}`);
        const caseNames = { normal: '正常情况', boundary: '边界情况', extreme: '极端情况' } as const;
        (node.cases ?? []).forEach((c, i) => {
          const r = node.caseResults?.find(x => x.case === i);
          details.push(`测试样例 ${i}·${caseNames[c.kind]}：${c.input} → ${c.expected}${r ? `｜${r.passed ? '通过' : '未通过'}：${r.actual}${r.proof.length ? `（证据 ${r.proof.length} 项）` : ''}` : ''}`);
        });
        if (node.dependsOn.length) details.push(`执行依赖：${node.dependsOn.join('、')}`);
        if (node.conditionOutcome !== undefined) details.push(`条件结果：${node.conditionOutcome}`);
        if (node.attemptId) details.push(`执行记录：${node.attemptId}`);
        if (node.result) details.push(`结果：${node.result}`);
        for (const evidence of node.evidence ?? []) details.push(`证据：${evidence}`);
      }
      details.forEach((detail, index) => lines.push(`${indent}${index === details.length - 1 && !children.length ? '└─' : '├─'} ${detail.replace(/\s+/g, ' ')}`));
      children.forEach((child, index) => visit(child, indent, index === children.length - 1));
    };
    visit(root, '', true); return lines.join('\n');
  }
}
