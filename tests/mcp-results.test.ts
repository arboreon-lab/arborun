import { describe, expect, it } from 'vitest';
import { ArborunService } from '../src/mcp/core';
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
});
