export type Mode = 'demo' | 'model';
export type NodeKind = 'group' | 'task' | 'condition' | 'decision' | 'agent' | 'artifact';
export type NodeStatus = 'draft' | 'ready' | 'running' | 'waiting' | 'passed' | 'failed' | 'skipped' | 'stale' | 'cancelled';
export type TaskStatus = 'draft' | 'planning' | 'approved' | 'running' | 'paused' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type Operation = 'read' | 'generate' | 'check' | 'decide' | 'delegate' | 'deliver';
export interface TreeNode {
  id: string; parentId: string | null; title: string; kind: NodeKind;
  description: string; target: string; action: string; acceptance: string[];
  dependencies: string[]; operation: Operation; status: NodeStatus;
  result?: string; decision?: string; choices?: string[];
  attempts: number; enabled: boolean; agentDepth: number;
  conditionResult?: 'true' | 'false' | 'unknown';
  runIf?: { nodeId: string; outcome: 'true' | 'false' };
}
export interface Source { id: string; name: string; content: string; hash: string }
export interface Artifact { id: string; nodeId: string; name: string; content: string; version: number; createdAt: string; adopted: boolean }
export interface RunEvent { id: string; at: string; nodeId?: string; kind: 'info' | 'tool' | 'decision' | 'error' | 'change'; message: string; detail?: string; revision: number }
export interface NodeAttempt { id: string; nodeId: string; revision: number; startedAt: string; endedAt?: string; status: NodeStatus; specification: TreeNode; result?: string }
export interface Budget { maxCalls: number; usedCalls: number; maxSteps: number; usedSteps: number; maxOutputTokens: number }
export interface Approval { revision: number; at: string; nodeIds: string[]; sourceHashes: string[]; maxCalls: number; maxSteps: number; allowDelegate: boolean }
export interface Task {
  id: string; title: string; prompt: string; mode: Mode; status: TaskStatus; revision: number;
  approval?: Approval; nodes: TreeNode[]; sources: Source[]; artifacts: Artifact[];
  events: RunEvent[]; attempts: NodeAttempt[]; budget: Budget; createdAt: string; updatedAt: string;
  lastError?: string;
}
export interface AppState { schemaVersion: 1; tasks: Task[]; activeTaskId: string | null }
export interface ModelConfig { baseUrl: string; model: string; apiKey: string }
export interface PublicModelConfig { baseUrl: string; model: string; hasKey: boolean; storage: 'encrypted' | 'session' | 'none' }
export type NodePatch = Partial<Pick<TreeNode, 'title' | 'description' | 'target' | 'action' | 'acceptance' | 'dependencies' | 'choices' | 'enabled' | 'parentId'>>;
export type Command =
  | { type: 'create'; prompt: string; mode: Mode; title?: string }
  | { type: 'sources'; taskId: string; sources: Source[] }
  | { type: 'plan' | 'approve' | 'run' | 'pause' | 'cancel' | 'select'; taskId: string }
  | { type: 'edit'; taskId: string; nodeId: string; patch: NodePatch }
  | { type: 'add'; taskId: string; parentId: string | null }
  | { type: 'remove' | 'retry'; taskId: string; nodeId: string }
  | { type: 'decide'; taskId: string; nodeId: string; choice: string };
export interface ArborunBridge {
  getState(): Promise<AppState>;
  command(command: Command): Promise<AppState>;
  importSources(taskId: string): Promise<AppState>;
  exportTask(taskId: string): Promise<string | null>;
  modelConfig(): Promise<PublicModelConfig>;
  saveModelConfig(config: ModelConfig): Promise<PublicModelConfig>;
  onState(listener: (state: AppState) => void): () => void;
}
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface Completion { content: string; toolCalls: ToolCall[]; tokens?: number }
export interface ModelProvider { complete(messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal, maxTokens: number): Promise<Completion> }
export interface StateStore { load(): Promise<AppState | null>; save(state: AppState): Promise<void> }
declare global { interface Window { arborun: ArborunBridge } }
