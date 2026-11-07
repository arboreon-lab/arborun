import { describe, expect, it } from 'vitest';
import { ArborunService, coarseStages, modelGaps, planGaps } from '../src/mcp/core';
import type { NodeSpec, ProposeInput } from '../src/mcp/schema';

const agents = [
  { id: 'main', name: '主 Agent', role: '拆分效果与汇总证据', scope: '计划与验收记录', budget: '不直接改代码' },
  { id: 'export', name: '实现 Agent', role: '修改导出逻辑', scope: 'src/exportCsv.ts', budget: '每个失败测试最多自动修复 3 次' },
];
const step = (id: string, parentId: string, overrides: Partial<NodeSpec> = {}): NodeSpec => ({
  id, parentId, kind: 'action', title: `步骤 ${id}`, action: `执行 ${id}`, target: 'src/exportCsv.ts',
  input: '边界样本', acceptance: [`${id} 完成`], failure: '记录问题后自动修复', dependsOn: [], agentId: 'export', ...overrides,
});
const root: NodeSpec = { id: 'root', parentId: null, kind: 'group', title: 'CSV 导出修复', action: '', target: '', input: '', acceptance: [], failure: '', dependsOn: [], agentId: 'main' };
const result: NodeSpec = { ...root, id: 'r-zh', parentId: 'root', kind: 'result', title: '中文直接打开不乱码', action: '用 Excel 2016 双击打开时中文正常显示' };
const userTest = step('t-open', 'r-zh', { kind: 'test', by: 'user', title: '双击打开中文正常', action: '当双击打开 chinese.csv 时，应看到中文正常', dependsOn: ['a-bom'] });
const agentTest = step('t-wizard', 'r-zh', { kind: 'test', by: 'agent', title: '导入向导读取正常', action: '当用导入向导读取时，应看到相同内容', dependsOn: ['a-bom'] });
const work = step('a-bom', 'r-zh', { title: '默认下载加 BOM' });
const plan = (nodes: NodeSpec[] = [root, result, userTest, agentTest, work]): ProposeInput =>
  ({ title: 'CSV 导出修复', goal: '中文在 Excel 2016 中正常显示', context: [], nodes, agents, clarifications: [{ question: '目标 Excel 版本？', answer: 'Excel 2016，双击打开' }] });

describe('以效果为中心的计划', () => {
  it('效果是容器：不能领取，状态由其中的测试与步骤汇总', () => {
    const service = new ArborunService(), id = service.propose(plan()).id;
    service.userAction({ type: 'approve', sessionId: id, expectedRevision: 1 });
    expect(() => service.claim({ sessionId: id, revision: 1, nodeId: 'r-zh', agentId: 'main' })).toThrow('只能领取具体执行节点');
    const grant = service.claim({ sessionId: id, revision: 1, nodeId: 'a-bom', agentId: 'export' });
    expect(service.get(id).nodes.find(n => n.id === 'r-zh')?.status).toBe('running');
    service.report({ sessionId: id, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: 'e1', status: 'passed',
      summary: '已加 BOM', evidence: ['download.test.ts 通过'], checks: [{ criterion: 'a-bom 完成', passed: true, evidence: 'exit 0' }] });
    expect(service.get(id).nodes.find(n => n.id === 't-open')?.status).toBe('ready');
  });

  it('每个效果至少需要一个测试，测试以外的节点不能标注设定者', () => {
    const service = new ArborunService();
    expect(() => service.propose(plan([root, result, work]))).toThrow('效果至少需要一个测试');
    expect(() => service.propose(plan([root, result, userTest, { ...work, by: 'user' }]))).toThrow('只有测试节点可以标注设定者');
    expect(() => service.propose(plan([root, { ...result, action: '' }, userTest, work]))).toThrow('要达到的效果');
  });

  it('Agent 更新计划时不能修改或删除用户设定的测试，可以补充测试', () => {
    const service = new ArborunService(), id = service.propose(plan()).id;
    const extra = step('t-extra', 'r-zh', { kind: 'test', by: 'agent', title: '空值保留', dependsOn: ['a-bom'] });
    expect(() => service.propose({ ...plan([root, result, { ...userTest, action: '改成更宽松的标准' }, agentTest, work]), sessionId: id, expectedRevision: 1 })).toThrow('用户设定的测试不能由 Agent 修改或删除');
    expect(() => service.propose({ ...plan([root, result, agentTest, work]), sessionId: id, expectedRevision: 1 })).toThrow('双击打开中文正常');
    expect(() => service.propose({ ...plan([root, result, { ...userTest, by: 'agent' }, agentTest, work]), sessionId: id, expectedRevision: 1 })).toThrow('不能由 Agent 修改');
    const next = service.propose({ ...plan([root, result, userTest, agentTest, extra, work]), sessionId: id, expectedRevision: 1 });
    expect(next.revision).toBe(2);
    expect(next.nodes.find(n => n.id === 't-open')?.by).toBe('user');
  });

  it('用户可以在树中直接修改自己设定的测试', () => {
    const service = new ArborunService(), id = service.propose(plan()).id;
    const nodes = plan().nodes.map(n => n.id === 't-open' ? { ...n, action: '当双击打开 chinese.csv 和 mixed.csv 时，应看到中文正常' } : n);
    const next = service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes });
    expect(next.nodes.find(n => n.id === 't-open')?.action).toContain('mixed.csv');
  });

  it('验收树标出测试由谁设定', () => {
    const service = new ArborunService(), id = service.propose(plan()).id;
    const tree = service.renderTree(id);
    expect(tree).toContain('要达到的效果：用 Excel 2016 双击打开时中文正常显示');
    expect(tree).toContain('双击打开中文正常（t-open）｜待执行｜用户设定');
    expect(tree).toContain('导入向导读取正常（t-wizard）｜待执行｜Agent 补充');
  });

  it('步骤带输入、输出、映射说明、约束与三类测试样例；改样例生成新版本并撤销批准', () => {
    const cases = [
      { kind: 'normal' as const, input: '张三', expected: '张三' },
      { kind: 'boundary' as const, input: '空字符串', expected: '空字符串' },
      { kind: 'extreme' as const, input: '10 万字符的备注', expected: '整体加引号且不截断' },
    ];
    const detailed = { ...work, output: '下载文件以 EF BB BF 开头', mapping: '序列化后在开头加 BOM 再下载', constraints: ['只加一次 BOM'], cases };
    const service = new ArborunService(), id = service.propose(plan([root, result, userTest, agentTest, detailed])).id;
    const saved = service.get(id).nodes.find(n => n.id === 'a-bom')!;
    expect([saved.output, saved.mapping, saved.constraints, saved.cases]).toEqual([detailed.output, detailed.mapping, detailed.constraints, cases]);
    const tree = service.renderTree(id);
    expect(tree).toContain('输出：下载文件以 EF BB BF 开头');
    expect(tree).toContain('怎么做：序列化后在开头加 BOM 再下载；注意只加一次 BOM');
    expect(tree).toContain('测试样例 1·边界情况：空字符串 → 空字符串');
    expect(() => service.propose(plan([root, result, userTest, agentTest, { ...work, cases: [{ kind: 'huge' as never, input: 'x', expected: 'y' }] }]))).toThrow();
    service.userAction({ type: 'approve', sessionId: id, expectedRevision: 1 });
    const edited = service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes: [root, result, userTest, agentTest, { ...detailed, cases: cases.slice(0, 2) }] });
    expect(edited.revision).toBe(2);
    expect(edited.status).toBe('draft');
    expect(edited.nodes.find(n => n.id === 'a-bom')!.cases).toHaveLength(2);
  });

  it('每个测试样例上报实际结果与证据；有样例未通过或缺证据时不能报告通过', () => {
    const cases = [{ kind: 'normal' as const, input: '3 行订单', expected: '中文正常' }, { kind: 'extreme' as const, input: '5 万行', expected: '不卡住' }];
    const service = new ArborunService(), id = service.propose(plan([root, result, userTest, agentTest, { ...work, cases }])).id;
    service.userAction({ type: 'approve', sessionId: id, expectedRevision: 1 });
    const grant = service.claim({ sessionId: id, revision: 1, nodeId: 'a-bom', agentId: 'export' });
    const base = { sessionId: id, attemptId: grant.attemptId, claimToken: grant.claimToken, summary: '已加 BOM', evidence: [], checks: [{ criterion: 'a-bom 完成', passed: true, evidence: 'exit 0' }] };
    const ok = (i: number) => ({ case: i, passed: true, actual: '符合预期', proof: [{ kind: 'command' as const, command: 'node export.js', output: 'OK' }] });
    expect(() => service.report({ ...base, eventId: 'x0', status: 'progress', caseResults: [ok(0), ok(0)] })).toThrow('只能上报一个结果');
    expect(() => service.report({ ...base, eventId: 'x1', status: 'progress', caseResults: [ok(5)] })).toThrow('超出范围');
    expect(() => service.report({ ...base, eventId: 'x2', status: 'passed', caseResults: [ok(0), { ...ok(1), passed: false }] })).toThrow('未通过');
    expect(() => service.report({ ...base, eventId: 'x3', status: 'passed', caseResults: [ok(0), { ...ok(1), proof: [] }] })).toThrow('看得懂的证据');
    expect(() => service.report({ ...base, eventId: 'x4', status: 'passed', caseResults: [ok(0), { ...ok(1), proof: [{ kind: 'image' as const }] }] })).toThrow();
    const long = 'x'.repeat(9000) + '最后一行：完成';
    const s = service.report({ ...base, eventId: 'x5', status: 'passed', caseResults: [ok(0), { ...ok(1), proof: [{ kind: 'command' as const, command: 'python train.py', output: long }] }] });
    const node = s.nodes.find(n => n.id === 'a-bom')!;
    expect(node.status).toBe('passed');
    const kept = node.caseResults![1].proof[0].output!;
    expect(kept.endsWith('最后一行：完成')).toBe(true);
    expect(kept.length).toBeLessThan(8100);
    expect(service.renderTree(id)).toContain('测试样例 1·极端情况：5 万行 → 不卡住｜通过：符合预期（证据 1 项）');
  });

  it('提交计划时列出还没写全的四部分，示例长任务计划是完整的', async () => {
    expect(planGaps(plan().nodes as NodeSpec[])).toContain('「默认下载加 BOM」（a-bom）：缺输出、描述、正常情况样例、边界情况样例、极端情况样例');
    const { readFile } = await import('node:fs/promises');
    const model = JSON.parse(await readFile('examples/mcp-model-plan.json', 'utf8'));
    expect(planGaps(model.nodes)).toEqual([]);
    expect(modelGaps(model.agents)).toEqual([]);
    // A long task is broken into many small steps; a stage done in one step is flagged as possibly too coarse.
    expect(model.nodes.filter((n: NodeSpec) => n.kind === 'action').length).toBeGreaterThanOrEqual(15);
    expect(coarseStages(model.nodes)).toEqual([]);
    expect(coarseStages(plan().nodes as NodeSpec[])).toEqual(['「中文直接打开不乱码」（r-zh）只有 1 个步骤']);
  });

  it('每个 Agent 按难度配模型、思考力度和方式，写进文字树；用户修改后生成新版本', () => {
    const tuned = [{ ...agents[0], effort: 'high' as const, mode: 'readonly' as const }, { ...agents[1], model: 'claude-opus-5-5', effort: 'xhigh' as const, mode: 'ask' as const, reason: '排错最难' }];
    const service = new ArborunService(), id = service.propose({ ...plan(), agents: tuned }).id;
    expect(service.renderTree(id)).toContain('配置：模型 claude-opus-5-5｜思考力度 很高（xhigh）｜理由：排错最难');
    expect(modelGaps(tuned)).toEqual(['「主 Agent」（main）的模型应为 claude-sonnet-5-5（简单）或 claude-opus-5-5（难）']);
    // The main, coordinating agent is held to the higher tier of model and a high effort.
    expect(modelGaps([{ ...agents[0], model: 'claude-sonnet-5-5', effort: 'medium' }])).toEqual(['「主 Agent」（main）负责规划统筹，应用较高档位的模型（claude-opus-5-5）和较高的思考强度（high 或 xhigh）']);
    expect(modelGaps([{ ...agents[0], model: 'claude-opus-5-5', effort: 'high' }])).toEqual([]);
    expect(() => service.propose({ ...plan(), agents: [{ ...agents[0], effort: 'max' as never }, agents[1]] })).toThrow();
    service.userAction({ type: 'approve', sessionId: id, expectedRevision: 1 });
    const edited = service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes: plan().nodes as NodeSpec[], agents: [tuned[0], { ...tuned[1], effort: 'medium' }] });
    expect(edited.revision).toBe(2);
    expect(edited.status).toBe('draft');
    expect(edited.agents[1].effort).toBe('medium');
  });

  it('用户对已完成的节点不满意：中止执行，回退到该节点，它和依赖它的节点待重做', () => {
    const service = new ArborunService(), id = service.propose(plan()).id;
    service.userAction({ type: 'approve', sessionId: id, expectedRevision: 1 });
    expect(() => service.userAction({ type: 'rollback', sessionId: id, expectedRevision: 1, nodeId: 'a-bom' })).toThrow('还没有执行');
    const grant = service.claim({ sessionId: id, revision: 1, nodeId: 'a-bom', agentId: 'export' });
    service.report({ sessionId: id, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: 'r1', status: 'passed', summary: '已加 BOM', evidence: ['ok'], checks: [{ criterion: 'a-bom 完成', passed: true, evidence: 'exit 0' }] });
    const running = service.claim({ sessionId: id, revision: 1, nodeId: 't-open', agentId: 'export' });
    const s = service.userAction({ type: 'rollback', sessionId: id, expectedRevision: 1, nodeId: 'a-bom', message: '还要支持 GBK' });
    expect(s.status).toBe('paused');
    expect(s.approval).toBeUndefined();
    expect(s.nodes.find(n => n.id === 'a-bom')!.status).toBe('stale');
    // Tests that depend on it go back too, and the running one is stopped.
    expect(s.nodes.find(n => n.id === 't-open')!.status).toBe('stale');
    expect(s.attempts.find(a => a.id === running.attemptId)!.invalidated).toBe(true);
    expect(s.nodes.find(n => n.id === 't-wizard')!.status).toBe('draft');
    expect(s.aiRequests[0]).toContain('还要支持 GBK');
    expect(s.events.at(-1)!.type).toBe('rolled_back');
    // The old claim can no longer report.
    expect(() => service.report({ sessionId: id, attemptId: running.attemptId, claimToken: running.claimToken, eventId: 'r2', status: 'passed', summary: 'x', evidence: ['x'], checks: [] })).not.toThrow();
    expect(service.get(id).nodes.find(n => n.id === 't-open')!.status).toBe('stale');
  });
});
