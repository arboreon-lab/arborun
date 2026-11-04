import { describe, expect, it } from 'vitest';
import { ArborunService } from '../src/mcp/core';
import { nodeSchema, userActionSchema, type NodeSpec, type ProposeInput } from '../src/mcp/schema';

const main = { id: 'main', name: '主 Agent', role: '实现与汇总', scope: '当前项目', budget: '只执行已批准步骤' };
const child = { id: 'reviewer', name: '检查 Agent', role: '独立检查', scope: '只读检查', budget: '一次检查', parentId: 'main' };
const node = (id: string, overrides: Partial<NodeSpec> = {}): NodeSpec => ({
  id, parentId: 'root', kind: 'action', title: `步骤 ${id}`, action: `执行 ${id}`, target: 'src/example.ts',
  input: '当前任务与项目内容', acceptance: [`${id} 的检查通过`], failure: '记录问题并等待修正', dependsOn: [], agentId: 'main', ...overrides,
});
const root = node('root', { parentId: null, kind: 'group', title: '任务树', action: '', target: '', input: '', acceptance: [], failure: '' });
function plan(nodes: NodeSpec[] = [root, node('a'), node('b', { dependsOn: ['a'] })]): ProposeInput {
  return { title: '修正导出', goal: '完成导出并验证', context: ['用户要求保留 UTF-8'], nodes, agents: [main, child] };
}
function setup(nodes?: NodeSpec[]) { const service = new ArborunService(); const session = service.propose(plan(nodes)); return { service, id: session.id }; }
function approve(service: ArborunService, id: string) {
  return service.userAction({ type: 'approve', sessionId: id, expectedRevision: service.get(id).revision });
}
function claim(service: ArborunService, id: string, nodeId = 'a', agentId = 'main') {
  return service.claim({ sessionId: id, revision: service.get(id).revision, nodeId, agentId });
}
function pass(service: ArborunService, id: string, nodeId: string, agentId = 'main', conditionOutcome?: boolean) {
  const grant = claim(service, id, nodeId, agentId);
  const n = service.get(id).nodes.find(n => n.id === nodeId)!;
  service.report({ sessionId: id, attemptId: grant.attemptId, claimToken: grant.claimToken, eventId: `pass-${grant.attemptId}`,
    status: 'passed', summary: '宿主检查完成', evidence: ['宿主运行测试 exit 0'],
    checks: n.acceptance.map(criterion => ({ criterion, passed: true, evidence: 'test 输出 exit 0' })), conditionOutcome });
  return grant;
}
const specs = (service: ArborunService, id: string) => service.get(id).nodes.map(n => nodeSchema.parse({
  id: n.id, parentId: n.parentId, kind: n.kind, title: n.title, action: n.action, target: n.target,
  input: n.input, acceptance: n.acceptance, failure: n.failure, dependsOn: n.dependsOn, when: n.when, agentId: n.agentId,
}));

describe('Arborun MCP 的批准与版本边界', () => {
  it('阻止未批准执行，批准绑定指定版本，普通计划与报告不接受批准字段', () => {
    const { service, id } = setup();
    expect(() => claim(service, id)).toThrow('用户批准');
    expect(() => service.propose({ ...plan(), approval: true } as ProposeInput)).toThrow();
    expect(userActionSchema.safeParse({ type: 'approve', sessionId: id, expectedRevision: 1 }).success).toBe(true);
    approve(service, id);
    expect(service.get(id).approval?.revision).toBe(1);
    expect(() => service.claim({ sessionId: id, revision: 2, nodeId: 'a', agentId: 'main' })).toThrow('计划已更新');
    expect(claim(service, id).session.nodes.find(n => n.id === 'a')?.status).toBe('running');
  });

  it('用户与模型并发编辑不覆盖新版本，并保留完整历史快照', () => {
    const { service, id } = setup();
    const nodes = specs(service, id); nodes[1].action = '先修改导出编码';
    service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes });
    expect(() => service.propose({ ...plan(), sessionId: id, expectedRevision: 1 })).toThrow('计划已更新');
    expect(service.get(id).nodes[1].action).toBe('先修改导出编码');
    expect(service.get(id).history.map(h => h.revision)).toEqual([1, 2]);
    expect(service.get(id).history[0].nodes[1].action).toBe('执行 a');
  });

  it('局部编辑保留无关通过结果，修改节点与下游结果失效', () => {
    const { service, id } = setup([root, node('a'), node('b', { dependsOn: ['a'] }), node('c')]);
    approve(service, id); pass(service, id, 'a'); pass(service, id, 'b'); pass(service, id, 'c');
    const nodes = specs(service, id); nodes.find(n => n.id === 'a')!.action = '修改 a 的新要求';
    const edited = service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes });
    expect(edited.approval).toBeUndefined();
    expect(edited.nodes.find(n => n.id === 'a')?.status).toBe('stale');
    expect(edited.nodes.find(n => n.id === 'b')?.status).toBe('stale');
    expect(edited.nodes.find(n => n.id === 'c')?.status).toBe('passed');
    expect(edited.attempts).toHaveLength(3);
    expect(() => claim(service, id, 'a')).toThrow('用户批准');
    approve(service, id);
    expect(() => claim(service, id, 'b')).toThrow('前置依赖');
    pass(service, id, 'a'); pass(service, id, 'b');
    expect(service.submit({ sessionId: id, revision: 2 }).status).toBe('review');
  });

  it('用户自然语言修改先暂停，AI 新计划必须反映最新版本后才能批准', () => {
    const { service, id } = setup(); approve(service, id);
    const changed = service.userAction({ type: 'requestAi', sessionId: id, expectedRevision: 1, message: '增加 Windows 验证' });
    expect(changed.aiRequests).toEqual(['增加 Windows 验证']);
    expect(changed.revision).toBe(2); expect(changed.approval).toBeUndefined();
    expect(() => approve(service, id)).toThrow('待处理');
    service.propose({ ...plan(), sessionId: id, expectedRevision: 2, goal: '完成导出并验证 Windows' });
    expect(approve(service, id).revision).toBe(3);
    expect(service.get(id).aiRequests).toEqual([]);
  });
});

describe('Arborun MCP 的执行状态与分支', () => {
  it('校验树、Agent、依赖与继承条件的循环，失败操作不修改现有任务', () => {
    const { service, id } = setup();
    const bad = [root, node('a', { dependsOn: ['b'] }), node('b', { dependsOn: ['a'] })];
    expect(() => service.propose({ ...plan(bad), sessionId: id, expectedRevision: 1 })).toThrow('循环');
    expect(() => service.propose(plan([root, node('a', { parentId: 'missing' })]))).toThrow('父节点');
    expect(() => service.propose(plan([root, node('a', { agentId: 'missing' })]))).toThrow('Agent 未声明');
    const inheritedCycle = [root, node('group', { kind: 'group', when: { nodeId: 'condition', outcome: true } }), node('condition', { kind: 'condition', parentId: 'group' })];
    expect(() => service.propose(plan(inheritedCycle))).toThrow('循环');
    expect(() => service.propose(plan([root, node('a', { when: { nodeId: 'a', outcome: true } })]))).toThrow('条件节点');
    expect(service.get(id).revision).toBe(1);
  });

  it('并行 Agent 可以领取独立步骤，同一节点和未分配 Agent 被阻止', () => {
    const { service, id } = setup([root, node('a'), node('b', { agentId: 'reviewer' })]); approve(service, id);
    claim(service, id, 'a');
    expect(() => claim(service, id, 'a')).toThrow('已领取');
    expect(() => claim(service, id, 'b', 'main')).toThrow('未分配');
    claim(service, id, 'b', 'reviewer');
    expect(service.get(id).attempts.filter(a => a.status === 'running').map(a => a.agentId)).toEqual(['main', 'reviewer']);
    expect(service.get(id).nodes[0].status).toBe('running');
  });

  it('子 Agent 产物完成后才可由父节点检查采用，子分支变化使采用结果失效', () => {
    const nodes = [root, node('delegation', { kind: 'agent' }), node('review', { parentId: 'delegation', agentId: 'reviewer' })];
    const { service, id } = setup(nodes); approve(service, id);
    const g = claim(service, id, 'delegation');
    const adoption = { sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'adopt', status: 'passed' as const,
      summary: '检查并采用子 Agent 结果', evidence: ['检查记录'], checks: [{ criterion: 'delegation 的检查通过', passed: true, evidence: '输出符合要求' }] };
    expect(() => service.report(adoption)).toThrow('子 Agent 分支尚未完成');
    pass(service, id, 'review', 'reviewer'); service.report(adoption);
    expect(service.get(id).nodes.find(n => n.id === 'delegation')?.status).toBe('passed');
    const changed = specs(service, id); changed.find(n => n.id === 'review')!.action = '补充新的检查';
    service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes: changed });
    expect(service.get(id).nodes.find(n => n.id === 'delegation')?.status).toBe('stale');
    expect(() => new ArborunService().propose(plan([root, nodes[1], { ...nodes[2], dependsOn: ['delegation'] }]))).toThrow('循环');
  });

  it('条件 unknown 阻塞、false 激活对应分支，跳过带有条件依据', () => {
    const { service, id } = setup([root, node('check', { kind: 'condition' }),
      node('yes', { when: { nodeId: 'check', outcome: true } }), node('no', { when: { nodeId: 'check', outcome: false } })]);
    approve(service, id);
    expect(() => claim(service, id, 'yes')).toThrow('条件分支');
    const g = claim(service, id, 'check');
    service.report({ sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'unknown', status: 'blocked', summary: '缺少输入', conditionOutcome: 'unknown' });
    expect(() => claim(service, id, 'no')).toThrow('条件分支');
    pass(service, id, 'check', 'main', false);
    expect(service.get(id).nodes.find(n => n.id === 'yes')?.status).toBe('skipped');
    expect(service.get(id).nodes.find(n => n.id === 'no')?.status).toBe('ready');
    pass(service, id, 'no');
    expect(service.submit({ sessionId: id, revision: 1 }).status).toBe('review');
  });

  it('每个通过条件都需要证据，不能将未知条件或缺失检查报告为通过', () => {
    const { service, id } = setup([root, node('a', { kind: 'condition', acceptance: ['存在依据', '结果明确'] })]); approve(service, id);
    const g = claim(service, id);
    const report = { sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'bad', status: 'passed' as const, summary: '完成', evidence: ['测试输出'], checks: [{ criterion: '存在依据', passed: true, evidence: '明确输出' }] };
    expect(() => service.report(report)).toThrow('每项通过条件');
    const checks = [...report.checks, { criterion: '结果明确', passed: true, evidence: '明确输出' }];
    expect(() => service.report({ ...report, checks, conditionOutcome: 'unknown' })).toThrow('unknown');
    expect(service.get(id).nodes.find(n => n.id === 'a')?.status).toBe('running');
    expect(service.report({ ...report, checks, conditionOutcome: true }).nodes.find(n => n.id === 'a')?.status).toBe('passed');
  });

  it('执行令牌绑定 attempt，重复上报幂等，相同 eventId 不允许改写内容', () => {
    const { service, id } = setup(); approve(service, id); const g = claim(service, id);
    const report = { sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'progress-a', status: 'progress' as const, summary: '读取当前文件' };
    expect(() => service.report({ ...report, claimToken: 'bad-token' })).toThrow('凭证');
    service.report(report); const count = service.get(id).events.length;
    service.report(report); expect(service.get(id).events).toHaveLength(count);
    expect(() => service.report({ ...report, summary: '替换内容' })).toThrow('eventId');
    expect(service.get(id).attempts[0].summary).toBe('读取当前文件');
    expect(JSON.stringify(service.get(id))).not.toContain(g.claimToken);
  });

  it('运行中编辑后迟到结果只进入旧 attempt，不会更新新版节点', () => {
    const { service, id } = setup(); approve(service, id); const g = claim(service, id);
    const nodes = specs(service, id); nodes[1].action = '重新实现新的导出逻辑';
    service.userAction({ type: 'edit', sessionId: id, expectedRevision: 1, nodes });
    service.report({ sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'late-a', status: 'passed', summary: '旧逻辑已写入', evidence: ['旧输出'] });
    const session = service.get(id);
    expect(session.nodes[1].status).toBe('stale');
    expect(session.nodes[1].result).toBeUndefined();
    expect(session.attempts[0].lateStatus).toBe('passed');
    expect(session.attempts[0].specification.action).toBe('执行 a');
    expect(session.events.at(-1)?.type).toBe('late_report');
  });

  it('暂停撤销当前执行，新批准后允许新 attempt，旧结果不能覆盖新结果', () => {
    const { service, id } = setup(); approve(service, id); const g = claim(service, id);
    service.userAction({ type: 'pause', sessionId: id, expectedRevision: 1 });
    expect(() => claim(service, id)).toThrow('用户批准');
    approve(service, id); pass(service, id, 'a');
    service.report({ sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'paused-late', status: 'failed', summary: '旧执行失败' });
    expect(service.get(id).nodes.find(n => n.id === 'a')?.status).toBe('passed');
    expect(service.get(id).nodes.find(n => n.id === 'a')?.result).toBe('宿主检查完成');
  });
});

describe('Arborun MCP 的交付、持久化与验收', () => {
  it('执行未完成不能提交；完成后生成同源验收树，只有用户可验收', () => {
    const { service, id } = setup(); approve(service, id);
    expect(() => service.submit({ sessionId: id, revision: 1 })).toThrow('未完成');
    pass(service, id, 'a'); pass(service, id, 'b');
    const submitted = service.submit({ sessionId: id, revision: 1 });
    expect(submitted.status).toBe('review');
    expect(submitted.review?.tree).toContain('步骤 a（a）｜检查通过');
    expect(submitted.review?.tree).toContain('未由 Arborun 独立验证');
    expect(submitted.review?.acceptedAt).toBeUndefined();
    expect(() => claim(service, id, 'a')).toThrow('用户批准');
    const accepted = service.userAction({ type: 'accept', sessionId: id, expectedRevision: 1 });
    expect(accepted.status).toBe('accepted'); expect(accepted.review?.acceptedAt).toBeTruthy();
    const edited = service.userAction({ type: 'requestChanges', sessionId: id, expectedRevision: 1, message: '补充边界测试' });
    expect(edited.status).toBe('draft'); expect(edited.review).toBeUndefined();
  });

  it('无活跃动作时事务快照不暂停；真正重启将活跃执行标记中断', () => {
    const { service, id } = setup(); approve(service, id); const g = claim(service, id);
    const transactionCopy = new ArborunService(service.snapshot());
    expect(transactionCopy.get(id).status).toBe('running');
    const recovered = new ArborunService(service.snapshot(), { recover: true });
    expect(recovered.get(id).status).toBe('paused');
    expect(recovered.get(id).attempts[0].status).toBe('interrupted');
    expect(recovered.get(id).approval).toBeUndefined();
    expect(() => claim(recovered, id)).toThrow('用户批准');
    recovered.report({ sessionId: id, attemptId: g.attemptId, claimToken: g.claimToken, eventId: 'after-restart', status: 'passed', summary: '宿主重连补报旧动作' });
    expect(recovered.get(id).nodes[1].status).toBe('stale');
  });

  it('快照和读取都是副本，批准哈希被篡改时拒绝恢复', () => {
    const { service, id } = setup(); approve(service, id);
    const publicState = service.get(id); publicState.nodes[1].action = '外部修改';
    expect(service.get(id).nodes[1].action).toBe('执行 a');
    const snapshot = service.snapshot(); snapshot.sessions[0].nodes[1].action = '篡改批准后的计划';
    expect(() => new ArborunService(snapshot)).toThrow('批准版本与计划不匹配');
  });
});
