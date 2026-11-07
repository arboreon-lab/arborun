import { z } from 'zod';

const id = z.string().trim().min(1).max(120).regex(/^[^\s\u0000-\u001f]+$/u, 'ID 不能包含空白或控制字符');
const text = z.string().trim().min(1).max(12000);
const short = z.string().trim().min(1).max(300);
const revision = z.number().int().positive();

/** A concrete sample for a step or test: an ordinary value, an edge of the valid range, or an extreme input. */
export const caseSchema = z.object({ kind: z.enum(['normal', 'boundary', 'extreme']), input: text, expected: text }).strict();
export const nodeSchema = z.object({
  // result: an effect the person can see; test: how that effect is proven (who set it is recorded in `by`).
  id, parentId: id.nullable(), kind: z.enum(['group', 'result', 'test', 'action', 'condition', 'agent']),
  by: z.enum(['user', 'agent']).optional(),
  title: short, action: z.string().max(12000).default(''), target: z.string().max(2000).default(''),
  input: z.string().max(12000).default(''), acceptance: z.array(text).max(30).default([]),
  failure: z.string().max(12000).default(''), dependsOn: z.array(id).max(100).default([]),
  // What the step produces, one paragraph on how input becomes output, the limits it must respect, and its test samples.
  output: z.string().trim().max(12000).optional(), mapping: z.string().trim().max(12000).optional(),
  constraints: z.array(text).max(30).optional(), cases: z.array(caseSchema).max(30).optional(),
  when: z.object({ nodeId: id, outcome: z.boolean() }).strict().optional(),
  agentId: id.default('main'),
}).strict();
export const agentSchema = z.object({
  id, name: short, role: text, scope: text, budget: text, parentId: id.optional(),
  // Chosen by how hard this agent's work is; the user may change them. Hosts apply what they support.
  model: z.string().trim().min(1).max(100).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  mode: z.enum(['readonly', 'ask', 'auto']).optional(),
  reason: z.string().trim().max(300).optional(),
}).strict();
export const clarificationSchema = z.object({ question: text, answer: z.string().trim().max(12000).optional() }).strict();
const planFields = {
  title: short, goal: text, context: z.array(text).max(50).default([]),
  nodes: z.array(nodeSchema).min(2).max(100), agents: z.array(agentSchema).min(1).max(20),
  clarifications: z.array(clarificationSchema).max(30).optional(),
};
export const proposeSchema = z.object({
  sessionId: id.optional(), expectedRevision: revision.optional(), ...planFields,
}).strict();
export const claimSchema = z.object({ sessionId: id, revision, nodeId: id, agentId: id }).strict();
/**
 * Proof a person can read without opening code: a command and what it printed, a screenshot, a short demo recording,
 * plain text or a link. Image and video files are given by local path; Arborun copies them into its own store.
 */
export const ARTIFACT_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp|mp4|webm)$/;
export const proofSchema = z.object({
  kind: z.enum(['command', 'image', 'video', 'text', 'link']),
  caption: z.string().trim().max(300).optional(),
  command: z.string().trim().max(2000).optional(),
  output: z.string().max(100000).optional(),
  path: z.string().trim().max(2000).optional(),
  url: z.string().trim().max(2000).regex(/^https?:\/\//, '链接需以 http(s):// 开头').optional(),
  artifact: z.string().regex(ARTIFACT_ID).optional(),
}).strict().superRefine((p, ctx) => {
  const need = (ok: boolean, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', message }); };
  if (p.kind === 'command') need(Boolean(p.command), '命令行证据需要 command（以及它的输出 output）');
  if (p.kind === 'text') need(Boolean(p.output?.trim()), '文字证据需要 output');
  if (p.kind === 'link') need(Boolean(p.url), '链接证据需要 url');
  if (p.kind === 'image' || p.kind === 'video') need(Boolean(p.path || p.url || p.artifact), '截图或录像需要本地文件 path 或 url');
});
/** The outcome of one test sample, by its position in the node's cases. */
export const caseResultSchema = z.object({
  case: z.number().int().nonnegative(), passed: z.boolean(), actual: text,
  proof: z.array(proofSchema).max(8).default([]),
}).strict();
export const reportSchema = z.object({
  sessionId: id, attemptId: id, claimToken: id, eventId: id,
  status: z.enum(['progress', 'passed', 'failed', 'blocked']), summary: text,
  evidence: z.array(text).max(50).default([]),
  checks: z.array(z.object({ criterion: text, passed: z.boolean(), evidence: text }).strict()).max(30).default([]),
  conditionOutcome: z.union([z.boolean(), z.literal('unknown')]).optional(),
  caseResults: z.array(caseResultSchema).max(30).default([]),
}).strict();
const activityBase = { sessionId: id, attemptId: id, claimToken: id, eventId: id, summary: text, runtimeAgentId: id.optional() };
export const activitySchema = z.discriminatedUnion('kind', [
  z.object({ ...activityBase, kind: z.literal('action'), target: z.string().trim().max(2000).optional() }).strict(),
  z.object({ ...activityBase, kind: z.literal('message_sent'), messageId: id, toAgentId: id, toNodeId: id.optional() }).strict(),
  z.object({ ...activityBase, kind: z.literal('message_received'), messageId: id }).strict(),
]);
export const submitSchema = z.object({ sessionId: id, revision }).strict();
const userBase = { sessionId: id, expectedRevision: revision };
export const userActionSchema = z.discriminatedUnion('type', [
  z.object({ ...userBase, type: z.literal('approve') }).strict(),
  z.object({ ...userBase, type: z.literal('pause') }).strict(),
  z.object({ ...userBase, type: z.literal('accept') }).strict(),
  z.object({ ...userBase, type: z.literal('requestChanges'), message: text }).strict(),
  z.object({ ...userBase, type: z.literal('requestAi'), message: text }).strict(),
  z.object({ ...userBase, type: z.literal('edit'), nodes: planFields.nodes,
    title: short.optional(), goal: text.optional(), context: z.array(text).max(50).optional(), agents: planFields.agents.optional(),
  }).strict(),
]);

export type NodeSpec = z.infer<typeof nodeSchema>;
export type TestCase = z.infer<typeof caseSchema>;
export type Proof = z.infer<typeof proofSchema>;
export type CaseResult = z.infer<typeof caseResultSchema>;
export type AgentSpec = z.infer<typeof agentSchema>;
export type ProposeInput = z.input<typeof proposeSchema>;
export type ClaimInput = z.input<typeof claimSchema>;
export type ReportInput = z.input<typeof reportSchema>;
export type ActivityInput = z.input<typeof activitySchema>;
export interface PlanClarification { question: string; answer: string }
export type SubmitInput = z.input<typeof submitSchema>;
export type UserActionInput = z.input<typeof userActionSchema>;
export type NodeStatus = 'draft' | 'ready' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'stale';
export interface NodeState extends NodeSpec {
  status: NodeStatus; result?: string; evidence?: string[]; conditionOutcome?: boolean | 'unknown'; attemptId?: string;
  caseResults?: CaseResult[];
}
export interface Approval { id: string; revision: number; hash: string; at: string }
export interface AttemptView {
  id: string; nodeId: string; agentId: string; revision: number; approvalId: string;
  specification: NodeSpec; status: 'running' | 'passed' | 'failed' | 'blocked' | 'stale' | 'interrupted';
  startedAt: string; endedAt?: string; invalidated?: boolean;
  summary?: string; evidence: string[]; checks: { criterion: string; passed: boolean; evidence: string }[];
  conditionOutcome?: boolean | 'unknown'; lateStatus?: 'passed' | 'failed' | 'blocked';
  caseResults?: CaseResult[];
  provenance: 'agent_reported';
}
export interface ArborunEvent {
  sequence: number; id: string; at: string; revision: number; type: string; message: string;
  nodeId?: string; agentId?: string; attemptId?: string; requestHash?: string;
  provenance: 'agent_reported' | 'user_confirmed' | 'arborun';
}
export interface AgentActivity {
  id: string; sequence: number; at: string; revision: number;
  kind: 'action' | 'message_sent' | 'message_received'; summary: string;
  nodeId: string; agentId: string; attemptId: string; runtimeAgentId?: string;
  target?: string; messageId?: string; toAgentId?: string; toNodeId?: string;
  fromAgentId?: string; fromNodeId?: string; sentActivityId?: string;
  provenance: 'agent_reported';
}
export interface Session {
  id: string; title: string; goal: string; context: string[]; revision: number;
  status: 'draft' | 'approved' | 'running' | 'paused' | 'review' | 'accepted';
  nodes: NodeState[]; agents: AgentSpec[]; approval?: Approval;
  attempts: AttemptView[]; events: ArborunEvent[];
  activities?: AgentActivity[]; clarifications?: PlanClarification[];
  review?: { revision: number; tree: string; submittedAt: string; acceptedAt?: string };
  aiRequests: string[]; createdAt: string; updatedAt: string;
  history: { revision: number; title: string; goal: string; context: string[]; nodes: NodeSpec[]; agents: AgentSpec[]; clarifications?: PlanClarification[]; at: string }[];
}
export interface ArborunSnapshot {
  version: 1; sessions: Session[];
  grants: { attemptId: string; token: string }[];
}
