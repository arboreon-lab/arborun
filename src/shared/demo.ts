import type { AppState, Source, Task, TreeNode } from './types';

export const DEMO_PROMPT = '根据产品需求和接口说明，补充 CSV 导出要求。若编码规则存在冲突，安排子 Agent 核验，并让我选择采用的口径。最后生成需求树与验收树。';

export const DEMO_SOURCES: Source[] = [
  { id: 'source-product', name: '产品需求.md', hash: 'demo-product-v1', content: '产品需求\n├─ 数据导出\n│  ├─ 支持 CSV 与 XLSX\n│  ├─ CSV 编码：UTF-8\n│  ├─ 字段顺序：名称、金额、日期\n│  └─ 空数据时只导出表头\n└─ 所有新增要求需要对应验收条件。' },
  { id: 'source-interface', name: '接口说明.md', hash: 'demo-interface-v1', content: '接口说明\n├─ 导出接口\n│  ├─ CSV 编码：GB18030\n│  ├─ 字段顺序：名称、金额、日期\n│  └─ 空数据时保留表头\n└─ 本文未声明替代产品需求中的编码规则。' },
];

export function createDemoNodes(prompt = DEMO_PROMPT): TreeNode[] {
  const node = (id: string, title: string, fields: Partial<TreeNode> = {}): TreeNode => ({
    id, parentId: 'root', title, kind: 'task', description: '', target: '', action: '',
    acceptance: [], dependencies: [], operation: 'generate', status: 'draft', attempts: 0,
    enabled: true, agentDepth: 0, ...fields,
  });
  return [
    node('root', '补充导出需求与验收', { parentId: null, kind: 'group', description: prompt, action: '整理资料，解决冲突，交付可追溯的需求与验收树。', acceptance: ['相关产物通过结构与来源检查'] }),
    node('read-sources', '读取资料，定位导出要求', { operation: 'read', target: '已导入资料', action: '读取授权资料，记录文件名称、内容快照与引用。', acceptance: ['至少一份可读取资料', '保留引用来源'] }),
    node('check-conflict', '检查编码规则是否冲突', { kind: 'condition', operation: 'check', target: '资料中的 CSV 编码规则', action: '比较各资料中 CSV 编码字段；不同取值视为冲突，缺少字段时标记未知。', dependencies: ['read-sources'], acceptance: ['给出成立、不成立或未知', '列出依据'] }),
    node('agent-review', '子 Agent · 核验冲突依据', { parentId: 'check-conflict', kind: 'agent', operation: 'delegate', target: '冲突资料与原文', action: '独立核对编码规则、适用范围及替代声明。只返回证据报告，不代替用户选择业务口径。', dependencies: ['check-conflict'], runIf: { nodeId: 'check-conflict', outcome: 'true' }, agentDepth: 1, acceptance: ['报告包含资料引用', '说明未确定事项'] }),
    node('choose-format', '决定采用哪种编码', { parentId: 'check-conflict', kind: 'decision', operation: 'decide', target: 'CSV 编码', action: '根据核验报告选择业务口径，随后继续执行。', choices: ['采用 UTF-8', '采用 GB18030'], dependencies: ['agent-review'], runIf: { nodeId: 'check-conflict', outcome: 'true' }, acceptance: ['记录用户明确选择'] }),
    node('write-requirements', '更新需求树', { operation: 'generate', target: '需求树.md', action: '新增 CSV 导出子树，写明字段顺序、选定编码及空数据行为，并列出来源与决策。', dependencies: ['read-sources', 'choose-format'], acceptance: ['含具体需求和来源', '遵循用户编码决策', '使用树结构'] }),
    node('write-acceptance', '生成对应验收树', { operation: 'generate', target: '验收树.md', action: '针对需求树逐项生成可检查的验收条件，关联采用的需求版本。', dependencies: ['write-requirements'], acceptance: ['每项需求有对应检查', '保留来源与上游版本', '使用树结构'] }),
    node('verify-output', '检查结构与产物完整性', { operation: 'check', target: '需求树与验收树', action: '检查全部依赖产物存在，正文采用树结构，引用源文件仍在授权快照内。', dependencies: ['write-requirements', 'write-acceptance'], acceptance: ['产物非空', '至少包含一个树分支', '产物已采用'] }),
    node('deliver', '保存交付与执行记录', { kind: 'artifact', operation: 'deliver', target: '交付清单.md', action: '生成产物清单，关联各文件版本与执行记录。用户可导出全部产物。', dependencies: ['verify-output'], acceptance: ['所有必需步骤通过', '交付清单可导出'] }),
  ];
}

export function createDemoTask(): Task {
  const now = new Date().toISOString();
  return {
    id: 'demo-task', title: 'CSV 导出需求', prompt: DEMO_PROMPT, mode: 'demo', status: 'draft', revision: 1,
    nodes: createDemoNodes(), sources: structuredClone(DEMO_SOURCES), artifacts: [], events: [{
      id: 'welcome', at: now, kind: 'info', message: '演示任务已就绪：使用本地预置逻辑，不调用远端模型。编辑节点后确认并运行。', revision: 1,
    }], attempts: [], budget: { maxCalls: 40, usedCalls: 0, maxSteps: 100, usedSteps: 0, maxOutputTokens: 4096 }, createdAt: now, updatedAt: now,
  };
}

export function createDemoState(): AppState {
  const task = createDemoTask();
  return { schemaVersion: 1, tasks: [task], activeTaskId: task.id };
}
