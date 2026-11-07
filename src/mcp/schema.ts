import { z } from 'zod';

const id = z.string().trim().min(1).max(120).regex(/^[^\s\u0000-\u001f]+$/u, 'ID 不能包含空白或控制字符');
const text = z.string().trim().min(1).max(12000);
const short = z.string().trim().min(1).max(300);
const revision = z.number().int().positive();

export const nodeSchema = z.object({
  // result: an effect the person can see; test: how that effect is proven (who set it is recorded in `by`).
  id, parentId: id.nullable(), kind: z.enum(['group', 'result', 'test', 'action', 'condition', 'agent']),
  by: z.enum(['user', 'agent']).optional(),
  title: short, action: z.string().max(12000).default(''), target: z.string().max(2000).default(''),
  input: z.string().max(12000).default(''), acceptance: z.array(text).max(30).default([]),
  failure: z.string().max(12000).default(''), dependsOn: z.array(id).max(100).default([]),
  when: z.object({ nodeId: id, outcome: z.boolean() }).strict().optional(),
  agentId: id.default('main'),
}).strict();
export const agentSchema = z.object({
  id, name: short, role: text, scope: text, budget: text, parentId: id.optional(),
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
export const reportSchema = z.object({
  sessionId: id, attemptId: id, claimToken: id, eventId: id,
  status: z.enum(['progress', 'passed', 'failed', 'blocked']), summary: text,
  evidence: z.array(text).max(50).default([]),
  checks: z.array(z.object({ criterion: text, passed: z.boolean(), evidence: text }).strict()).max(30).default([]),
  conditionOutcome: z.union([z.boolean(), z.literal('unknown')]).optional(),
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
}
export interface Approval { id: string; revision: number; hash: string; at: string }
export interface AttemptView {
  id: string; nodeId: string; agentId: string; revision: number; approvalId: string;
  specification: NodeSpec; status: 'running' | 'passed' | 'failed' | 'blocked' | 'stale' | 'interrupted';
  startedAt: string; endedAt?: string; invalidated?: boolean;
  summary?: string; evidence: string[]; checks: { criterion: string; passed: boolean; evidence: string }[];
  conditionOutcome?: boolean | 'unknown'; lateStatus?: 'passed' | 'failed' | 'blocked';
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
