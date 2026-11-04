import { describe, expect, it } from 'vitest';
import { Engine, isTreeMarkdown, validateTree } from '../src/harness/engine';
import { createDemoState, DEMO_SOURCES } from '../src/shared/demo';
import type { AppState, Completion, ModelMessage, ModelProvider, StateStore, Task } from '../src/shared/types';

const copy = <T>(value: T): T => structuredClone(value);
class MemoryStore implements StateStore {
  state: AppState | null; saves = 0;
  constructor(state: AppState | null = null) { this.state = copy(state); }
  async load() { return copy(this.state); }
  async save(state: AppState) { this.saves++; this.state = copy(state); }
}
const final = (content = '已完成'): Completion => ({ content, toolCalls: [] });
const tool = (name: string, args: unknown): Completion => ({ content: '', toolCalls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const noModel: ModelProvider = { complete: async () => { throw new Error('演示任务不得调用模型'); } };
async function setup(state: AppState | null = null, provider = noModel, delayMs = 0) {
  const store = new MemoryStore(state); const engine = new Engine({ store, provider, delayMs });
  await engine.init(); return { engine, store };
}
const task = (engine: Engine): Task => engine.getState().tasks[0];
async function approveRun(engine: Engine) {
  const taskId = task(engine).id;
  await engine.command({ type: 'approve', taskId }); await engine.command({ type: 'run', taskId }); await engine.idle();
}
async function completeDemo(engine: Engine) {
  await approveRun(engine);
  await engine.command({ type: 'decide', taskId: task(engine).id, nodeId: 'choose-format', choice: '采用 UTF-8' });
  await engine.command({ type: 'run', taskId: task(engine).id }); await engine.idle();
}
function modelState(): AppState {
  const state = createDemoState(); const t = state.tasks[0]; t.mode = 'model';
  t.nodes = t.nodes.filter(n => ['root', 'read-sources', 'write-requirements', 'verify-output', 'deliver'].includes(n.id));
  t.nodes.find(n => n.id === 'write-requirements')!.dependencies = ['read-sources'];
  t.nodes.find(n => n.id === 'verify-output')!.dependencies = ['write-requirements'];
  return state;
}
function scripted(responses: Completion[]): ModelProvider & { messages: ModelMessage[][] } {
  const messages: ModelMessage[][] = [];
  return { messages, complete: async m => { messages.push(copy(m)); const response = responses.shift(); if (!response) throw new Error('超出测试响应'); return response; } };
}
const treeContent = '需求树\n├─ 要求：支持 CSV\n└─ 来源：产品需求.md';

describe('Harness 的执行与决策', () => {
  it('演示真实更新状态，受限子 Agent 返回后等待用户，再交付树形产物', async () => {
    const { engine, store } = await setup();
    await approveRun(engine);
    expect(task(engine).status).toBe('waiting');
    expect(task(engine).nodes.find(n => n.id === 'agent-review')!.status).toBe('passed');
    expect(task(engine).artifacts.some(a => a.nodeId === 'agent-review' && a.adopted)).toBe(true);
    expect(task(engine).nodes.find(n => n.id === 'write-requirements')!.status).toBe('ready');
    await expect(engine.command({ type: 'decide', taskId: 'demo-task', nodeId: 'choose-format', choice: '不存在的选项' })).rejects.toThrow('有效选项');
    await engine.command({ type: 'decide', taskId: 'demo-task', nodeId: 'choose-format', choice: '采用 UTF-8' });
    await engine.command({ type: 'run', taskId: 'demo-task' }); await engine.idle();
    expect(task(engine).status).toBe('completed');
    expect(task(engine).artifacts.every(a => isTreeMarkdown(a.content))).toBe(true);
    expect(task(engine).artifacts.find(a => a.name === '需求树.md')!.content).toContain('采用 UTF-8');
    expect(task(engine).budget.usedCalls).toBe(0);
    expect(store.saves).toBeGreaterThan(12);
    expect(task(engine).attempts.every(a => a.endedAt)).toBe(true);
  });
  it('条件不成立跳过派生与人工选择，未知条件则等待而不猜测', async () => {
    const state = createDemoState(); state.tasks[0].sources[1].content = state.tasks[0].sources[1].content.replace('GB18030', 'UTF-8');
    const { engine } = await setup(state); await approveRun(engine);
    expect(task(engine).status).toBe('completed');
    expect(task(engine).nodes.find(n => n.id === 'agent-review')!.status).toBe('skipped');
    expect(task(engine).nodes.find(n => n.id === 'choose-format')!.attempts).toBe(0);
    const unknown = createDemoState(); unknown.tasks[0].sources = unknown.tasks[0].sources.slice(0, 1);
    const second = await setup(unknown); await approveRun(second.engine);
    expect(task(second.engine).status).toBe('waiting');
    expect(task(second.engine).nodes.find(n => n.id === 'check-conflict')!.conditionResult).toBe('unknown');
    expect(task(second.engine).nodes.find(n => n.id === 'agent-review')!.attempts).toBe(0);
  });
  it('未确认计划不能执行；节点修改保留历史并只使影响范围失效', async () => {
    const { engine } = await setup();
    await expect(engine.command({ type: 'run', taskId: 'demo-task' })).rejects.toThrow('确认');
    await completeDemo(engine);
    const attemptCount = task(engine).attempts.length;
    await engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'write-requirements', patch: { action: '增加带引号字段的要求，并记录依据。' } });
    expect(task(engine).approval).toBeUndefined();
    expect(task(engine).nodes.find(n => n.id === 'read-sources')!.status).toBe('passed');
    expect(task(engine).nodes.find(n => n.id === 'write-acceptance')!.status).toBe('stale');
    expect(task(engine).attempts).toHaveLength(attemptCount);
    await approveRun(engine);
    expect(task(engine).status).toBe('completed');
    expect(task(engine).nodes.find(n => n.id === 'read-sources')!.attempts).toBe(1);
    expect(task(engine).artifacts.find(a => a.name === '需求树.md' && a.adopted)!.version).toBe(2);
    expect(task(engine).artifacts.find(a => a.name === '需求树.md' && a.adopted)!.content).toContain('带引号字段');
  });
  it('根约束修改传播到全部子孙；禁用父节点不会执行其子孙', async () => {
    const { engine } = await setup(); await completeDemo(engine);
    await engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'root', patch: { description: '新的整体目标：仅生成匿名资料说明' } });
    expect(task(engine).prompt).toContain('匿名');
    expect(task(engine).nodes.filter(n => n.kind !== 'group').every(n => n.status === 'stale')).toBe(true);
    await expect(engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'root', patch: { enabled: false } })).rejects.toThrow('根节点');
    const second = await setup();
    await second.engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'check-conflict', patch: { enabled: false } });
    await approveRun(second.engine);
    expect(task(second.engine).nodes.find(n => n.id === 'agent-review')!.attempts).toBe(0);
    expect(task(second.engine).nodes.find(n => n.id === 'choose-format')!.status).toBe('skipped');
    expect(task(second.engine).nodes.find(n => n.id === 'write-requirements')!.attempts).toBe(0);
    expect(task(second.engine).status).toBe('waiting');
  });
  it('拒绝循环依赖、不存在的引用与非安全结构', async () => {
    const { engine } = await setup();
    await expect(engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'read-sources', patch: { dependencies: ['deliver'] } })).rejects.toThrow('循环');
    await expect(engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'read-sources', patch: { dependencies: ['missing'] } })).rejects.toThrow('不存在');
    await expect(engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'root', patch: { parentId: 'deliver' } })).rejects.toThrow();
    await expect(engine.command({ type: 'remove', taskId: 'demo-task', nodeId: 'read-sources' })).rejects.toThrow('依赖');
    const bad = copy(task(engine).nodes); bad.find(n => n.id === 'agent-review')!.agentDepth = 2;
    expect(() => validateTree(bad)).toThrow('一层');
    expect(task(engine).revision).toBe(1);
  });
  it('工具步骤预算耗尽会失败，不启动子 Agent 也不交付', async () => {
    const state = createDemoState(); state.tasks[0].budget.maxSteps = 2;
    const { engine } = await setup(state); await approveRun(engine);
    expect(task(engine).status).toBe('failed');
    expect(task(engine).lastError).toContain('预算');
    expect(task(engine).artifacts).toHaveLength(0);
  });
});

describe('真实模型运行边界', () => {
  it('计划生成校验失败仅修正一次，成功计划仍需用户确认', async () => {
    const validNodes = modelState().tasks[0].nodes.map(({ status, attempts, enabled, agentDepth, ...node }) => node);
    const provider = scripted([final('{"nodes":[]}'), final(JSON.stringify({ nodes: validNodes }))]);
    const { engine } = await setup(modelState(), provider);
    await engine.command({ type: 'plan', taskId: 'demo-task' }); await engine.idle();
    expect(task(engine).status).toBe('draft'); expect(task(engine).approval).toBeUndefined();
    expect(task(engine).nodes).toHaveLength(5); expect(task(engine).budget.usedCalls).toBe(2);
    await expect(engine.command({ type: 'run', taskId: 'demo-task' })).rejects.toThrow('确认');
  });
  it('子 Agent 使用独立模型上下文，并共享父任务剩余调用预算', async () => {
    const state = createDemoState(); state.tasks[0].mode = 'model'; state.tasks[0].budget.maxCalls = 5;
    const provider = scripted([
      tool('read_source', { sourceId: 'source-product' }), final(),
      tool('read_source', { sourceId: 'source-product' }), final(JSON.stringify({ outcome: 'true', reason: '应进一步核验编码口径', evidence: [{ sourceId: 'source-product', quote: 'CSV 编码：UTF-8' }] })),
      tool('read_source', { sourceId: 'source-interface' }), final(),
    ]);
    const { engine } = await setup(state, provider); await approveRun(engine);
    expect(task(engine).status).toBe('failed'); expect(task(engine).budget.usedCalls).toBe(5);
    expect(task(engine).nodes.find(n => n.id === 'agent-review')!.status).toBe('failed');
    expect(task(engine).lastError).toContain('预算');
    expect(provider.messages[4][0].content).toContain('bounded child agent');
    expect(provider.messages[4]).toHaveLength(2);
    expect(task(engine).nodes.find(n => n.id === 'choose-format')!.attempts).toBe(0);
  });
  it('条件的伪造引用被拒绝，不能启用下游分支', async () => {
    const state = createDemoState(); state.tasks[0].mode = 'model';
    const provider = scripted([tool('read_source', { sourceId: 'source-product' }), final(), tool('read_source', { sourceId: 'source-product' }), final(JSON.stringify({ outcome: 'true', reason: '发生冲突', evidence: [{ sourceId: 'source-product', quote: '资料中不存在的引用' }] }))]);
    const { engine } = await setup(state, provider); await approveRun(engine);
    expect(task(engine).status).toBe('failed'); expect(task(engine).lastError).toContain('证据');
    expect(task(engine).nodes.find(n => n.id === 'agent-review')!.attempts).toBe(0);
  });
  it('实际读取、写入候选产物并校验，父约束进入上下文', async () => {
    const provider = scripted([
      tool('read_source', { sourceId: 'source-product' }), final('已读取需求资料'),
      tool('read_source', { sourceId: 'source-product' }), tool('write_artifact', { name: '需求.md', content: treeContent }), final('已提交产物'),
    ]);
    const { engine } = await setup(modelState(), provider); await approveRun(engine);
    expect(task(engine).status).toBe('completed');
    expect(task(engine).artifacts.find(a => a.name === '需求.md')!.adopted).toBe(true);
    expect(task(engine).budget.usedCalls).toBe(5);
    expect(provider.messages[0][1].content).toContain('ancestorRequirements');
    expect(provider.messages[0][1].content).toContain('相关产物通过结构与来源检查');
  });
  it('模型自报读取成功不算完成，也不能调用未授权工具或读取未知来源', async () => {
    for (const response of [final('我已经读完了'), tool('exec', { command: 'anything' }), tool('read_source', { sourceId: '../../secret' })]) {
      const { engine } = await setup(modelState(), scripted([response])); await approveRun(engine);
      expect(task(engine).status).toBe('failed');
      expect(task(engine).nodes.find(n => n.id === 'read-sources')!.status).toBe('failed');
      expect(task(engine).nodes.find(n => n.id === 'write-requirements')!.attempts).toBe(0);
    }
  });
  it('拒绝路径写入、非树输出；失败的候选产物不采用', async () => {
    for (const artifact of [{ name: '../escape.md', content: treeContent }, { name: 'plain.md', content: 'plain prose' }]) {
      const provider = scripted([tool('read_source', { sourceId: 'source-product' }), final(), tool('read_source', { sourceId: 'source-product' }), tool('write_artifact', artifact)]);
      const { engine } = await setup(modelState(), provider); await approveRun(engine);
      expect(task(engine).status).toBe('failed'); expect(task(engine).artifacts).toHaveLength(0);
    }
    const provider = scripted([tool('read_source', { sourceId: 'source-product' }), final(), tool('read_source', { sourceId: 'source-product' }), tool('write_artifact', { name: '候选.md', content: treeContent }), tool('exec', {})]);
    const { engine } = await setup(modelState(), provider); await approveRun(engine);
    expect(task(engine).status).toBe('failed');
    expect(task(engine).artifacts[0].adopted).toBe(false);
  });
  it('同一次尝试的同名产物仅采用最新版本', async () => {
    const provider = scripted([tool('read_source', { sourceId: 'source-product' }), final(), tool('read_source', { sourceId: 'source-product' }), tool('write_artifact', { name: '需求.md', content: treeContent }), tool('write_artifact', { name: '需求.md', content: treeContent.replace('支持 CSV', '支持 CSV 和 XLSX') }), final()]);
    const { engine } = await setup(modelState(), provider); await approveRun(engine);
    const artifacts = task(engine).artifacts.filter(a => a.name === '需求.md');
    expect(artifacts).toHaveLength(2); expect(artifacts.filter(a => a.adopted)).toHaveLength(1);
    expect(artifacts.find(a => a.adopted)!.version).toBe(2);
  });
  it('调用预算在请求前检查，子 Agent 共享预算', async () => {
    const state = modelState(); state.tasks[0].budget.maxCalls = 1;
    const provider = scripted([tool('read_source', { sourceId: 'source-product' }), final()]);
    const { engine } = await setup(state, provider); await approveRun(engine);
    expect(provider.messages).toHaveLength(1); expect(task(engine).status).toBe('failed');
    expect(task(engine).lastError).toContain('预算');
  });
  it('取消或运行中修改后忽略迟到的模型回复', async () => {
    for (const edit of [false, true]) {
      let resolve!: (response: Completion) => void;
      let started!: () => void;
      const start = new Promise<void>(done => started = done);
      const provider: ModelProvider = { complete: () => { started(); return new Promise<Completion>(done => resolve = done); } };
      const { engine } = await setup(modelState(), provider);
      await engine.command({ type: 'approve', taskId: 'demo-task' }); await engine.command({ type: 'run', taskId: 'demo-task' }); await start;
      if (edit) await engine.command({ type: 'edit', taskId: 'demo-task', nodeId: 'read-sources', patch: { action: '新的读取要求' } });
      else await engine.command({ type: 'cancel', taskId: 'demo-task' });
      resolve(tool('read_source', { sourceId: 'source-product' })); await engine.idle();
      expect(task(engine).status).toBe(edit ? 'draft' : 'cancelled');
      expect(task(engine).events.some(e => e.message === '执行工具：read_source')).toBe(false);
      expect(task(engine).attempts[0].status).toBe('cancelled');
      if (edit) expect(task(engine).approval).toBeUndefined();
    }
  });
  it('长资料返回可继续读取的偏移，不静默把截断内容视为全文', async () => {
    const state = modelState(); state.tasks[0].sources[0].content = 'A'.repeat(100050);
    const provider = scripted([tool('read_source', { sourceId: 'source-product' }), tool('read_source', { sourceId: 'source-product', offset: 100000 }), final()]);
    const { engine } = await setup(state, provider); await approveRun(engine);
    const firstRead = JSON.parse(provider.messages[1].at(-1)!.content!);
    expect(firstRead.truncated).toBe(true); expect(firstRead.nextOffset).toBe(100000); expect(firstRead.totalChars).toBe(100050);
    const nextRead = JSON.parse(provider.messages[2].at(-1)!.content!);
    expect(nextRead.content).toHaveLength(50); expect(nextRead.truncated).toBe(false);
  });
  it('模型设置变更使真实任务确认失效，不影响演示任务', async () => {
    const { engine } = await setup(modelState()); await engine.command({ type: 'approve', taskId: 'demo-task' });
    await engine.invalidateModelApprovals(); expect(task(engine).approval).toBeUndefined(); expect(task(engine).revision).toBe(2);
    const demo = await setup(); await demo.engine.command({ type: 'approve', taskId: 'demo-task' }); await demo.engine.invalidateModelApprovals();
    expect(task(demo.engine).approval?.revision).toBe(1);
  });
});

describe('持久化与恢复', () => {
  it('暂停停在动作边界，恢复不会重跑已完成节点', async () => {
    const { engine } = await setup(null, noModel, 20);
    await engine.command({ type: 'approve', taskId: 'demo-task' }); await engine.command({ type: 'run', taskId: 'demo-task' });
    await engine.command({ type: 'pause', taskId: 'demo-task' }); await engine.idle();
    expect(task(engine).status).toBe('paused');
    expect(task(engine).nodes.find(n => n.id === 'agent-review')!.attempts).toBe(0);
    await engine.command({ type: 'run', taskId: 'demo-task' }); await engine.idle();
    expect(task(engine).status).toBe('waiting');
    expect(task(engine).nodes.find(n => n.id === 'read-sources')!.status).toBe('passed');
  });
  it('重启把未结束执行转为中断，保留已完成节点和历史', async () => {
    const state = createDemoState(); const t = state.tasks[0]; t.status = 'running';
    t.nodes[1].status = 'passed'; t.nodes[2].status = 'running';
    t.attempts.push({ id: 'attempt', nodeId: t.nodes[2].id, revision: 1, startedAt: new Date().toISOString(), status: 'running', specification: copy(t.nodes[2]) });
    const { engine } = await setup(state);
    expect(task(engine).status).toBe('interrupted'); expect(task(engine).nodes[1].status).toBe('passed'); expect(task(engine).nodes[2].status).toBe('ready');
    expect(task(engine).attempts[0].endedAt).toBeTruthy();
  });
  it('保存失败关闭执行，后续命令明确报错', async () => {
    const store = new MemoryStore(); const engine = new Engine({ store, provider: noModel, delayMs: 0 }); await engine.init();
    store.save = async () => { throw new Error('磁盘不可写'); };
    await expect(engine.command({ type: 'approve', taskId: 'demo-task' })).rejects.toThrow('数据保存失败');
    await expect(engine.command({ type: 'run', taskId: 'demo-task' })).rejects.toThrow('数据保存失败');
    expect(task(engine).attempts).toHaveLength(0);
  });
});
