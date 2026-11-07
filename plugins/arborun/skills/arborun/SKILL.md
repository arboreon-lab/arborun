---
name: arborun
description: Use Arborun to clarify a task in the host conversation, create an exact editable execution tree, wait for user approval, observe real agent actions and messages, and deliver results on the same tree while keeping normal Codex conversation output.
---

```text
Arborun｜宿主工作流
├─ 适用任务
│  ├─ 跨度大、约束少、几乎不可能一次做完的任务，例如“帮我训练一个模型”“帮我写一篇 Nature 论文”。
│  ├─ 把它拆成人能逐段检查结果的阶段；人看结果与证据，不看代码。
│  └─ 拆得足够细：
│     ├─ 每个步骤是 Agent 一次能做完并拿出证据的一件具体事（几分钟到几小时），只有一个可检查的产出。
│     ├─ 一个阶段通常有多个按先后（dependsOn）排列的步骤；长任务一般有几十个步骤。
│     └─ “改到达标为止”这类循环写成明确的几轮：找出问题 → 只改一处 → 对比 → 选最好的。
├─ 对话与澄清
│  ├─ Codex 按正常方式回复、解释进展、提问与交付；树是同步的执行界面，不替代聊天输出。
│  ├─ 从请求、相关文件与已有对话确认目标、范围、约束和完成条件。
│  ├─ 对影响实现、分支或验收的未确认要求，先用宿主的提问工具或正常对话逐项问清。
│  ├─ 已明确的要求不重复询问；可独立调查的问题先调查，不把调查责任转嫁给用户。
│  ├─ 把已回答的问题与答案作为 clarifications 传给 arborun_plan。
│  ├─ 只要仍有未回答的需求问题，就不生成供批准的最终执行树，不用“待处理”节点代替提问。
│  └─ 仅传必要摘要与文件引用，不传密钥或无关私人数据。
├─ 以人的验收视角组织执行树
│  ├─ 用户验收看测试与可见效果，不看代码；树以“要达到的效果”为中心。
│  ├─ root 的子节点按先后组成主干；只有一个输出的环节就是一条路径，可并行的环节拆成分支。
│  ├─ 每项可见效果是 kind=result，action 写清用户在哪里看到什么。
│  │  ├─ 其下 kind=test：action 写“当……时，应该看到……”，acceptance 列出应看到的结果。
│  │  ├─ 用户提出或确认的测试标 by=user，是验收标准；Agent 补充的测试标 by=agent。
│  │  ├─ 用户设定的测试不能在 arborun_plan 更新中修改或删除，只能由用户在树中编辑。
│  │  └─ 实现该效果的 kind=action 步骤也放在此 result 下，界面默认收起为“Agent 工作”。
│  ├─ 需要拍板的决定在提问阶段确认，不在树里放“待决定”节点。
│  ├─ 所有节点（含 root、result）都按四部分写：输入 input、输出 output、描述 mapping＋constraints、测试。
│  ├─ 每个测试与步骤另写对象 target、通过条件 acceptance 和失败路径 failure。
│  └─ 每个测试与步骤还要写清：
│     ├─ output：产出什么；mapping：一两句话说明输入如何变成输出；constraints：要注意的限制。
│     ├─ cases：自动生成测试样例，正常情况（normal）、边界情况（boundary）、极端情况（extreme）各至少一个，写明具体输入与期望输出。
│     └─ 所有文字简短直白，让不懂技术的人也能看懂：短句、少术语；mapping 一两句话，说清怎么做和要注意什么；同一意思只写一次。
├─ 具体执行树
│  ├─ 调用 arborun_plan；root 为 group，每个执行节点说明具体动作、对象、输入、产物依据、通过条件和失败路径。
│  ├─ parentId 只表示包含；dependsOn 表示执行依赖；when 表示已定义的条件判断结果。
│  ├─ 运行时才可获得的条件，必须有明确取证动作、true/false 分支和无法取证时的停止路径。
│  ├─ 所有子 Agent 明确角色、权限范围、预算、触发条件、交接输入和结果采用检查。
│  ├─ 调用 arborun_read 展示树，等待用户批准当前版本。
│  ├─ 修改前读取最新 revision，以 expectedRevision 更新；改动撤销原批准。
│  └─ 不调用 arborun_user，不提取 UI 凭证，不用自动化代替用户批准或验收。
├─ 实际执行与同步
│  ├─ 用户在树中批准后，读取最新树，核对 approval.revision 与 revision。
│  ├─ 每次外部操作前用 arborun_claim 领取 ready 节点；拒绝时不继续外部动作。
│  ├─ 使用正常 Codex 工具执行、启动子 Agent、发送消息；登记 Agent 不代表已经启动。
│  ├─ 启动后将 sessionId、当前版本、节点与上报约定传给真实子 Agent。
│  ├─ 用 arborun_activity(kind=action) 记录实际开始／进行的可观察动作，附实际 runtimeAgentId、对象与简明摘要。
│  ├─ 行动记录不包含内部思维链；不能在未执行时编造工具结果或完成进度。
│  ├─ 宿主真实消息工具发送成功后，上报 message_sent：共享 messageId、toAgentId、可选 toNodeId 与消息摘要。
│  ├─ 发送成功只代表已发送；接收 Agent 真正收到后，用自己的 claim 上报 message_received 和同一 messageId。
│  ├─ 子 Agent 没有 Arborun 工具时，协调 Agent 可依据实际宿主事件代为上报，保留真实实例标识；不能推测接收。
│  ├─ 动作和消息事件通过活动通道返回简短确认；界面轮询更新，聊天继续正常 commentary 与 final。
│  ├─ arborun_report 记录结果；passed 要逐条匹配 acceptance 的 checks 和真实证据。
│  ├─ 每个测试样例上报 caseResults（case 为样例在 cases 中从 0 开始的序号）：是否通过、实际发生了什么（大白话）、证据。
│  │  ├─ 证据用人一眼能懂的形式：command（命令与输出）、image（截图绝对路径）、video（短演示 MP4/WebM/GIF 绝对路径）、text、link。
│  │  ├─ 截图和录像由 Arborun 复制保存后在面板中直接显示；可边做边报，同一样例后报覆盖先报。
│  │  └─ 报告通过前，每个样例都要有结果且全部通过，每项都附证据。
│  ├─ 新出现的问题在 Codex 对话说明并询问；必要时暂停或修改树，不能悄悄假定通过。
│  ├─ 需要计划外动作或分支时更新计划，等待新版本批准。
│  └─ 暂停、旧版本、无效领取和未知条件不继续；已经发出的外部命令由宿主停止或核对。
└─ 验收与能力边界
   ├─ 所有适用节点完成后调用 arborun_submit，同一节点承载产物、检查与协作历史。
   ├─ Codex 正常输出结果、文件与验证依据；按用户要求决定是否用文字树。
   ├─ 用户独立验收或要求返工；Agent 不代验收。
   ├─ MCP 不会自动得到所有 Codex 工具事件或转发 Agent 消息，活动来自真实宿主上报。
   └─ 未启用并实测官方 hooks 前，不宣称全量自动捕获、多 Agent 自动发现或原生消息回调已接通。
```
