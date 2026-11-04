---
name: arborun
description: Use Arborun to create an editable decision and execution tree, wait for user approval, track actual agent work against nodes, and deliver a result tree for user acceptance. Activate when the user requests Arborun or a tree-governed task.
---

```text
Arborun｜宿主工作流
├─ 输入与上下文
│  ├─ 从当前请求、相关文件和已有对话提炼目标与约束。
│  ├─ 仅把任务需要的摘要与文件引用传给 Arborun；不要复制密钥或无关私人数据。
│  └─ Arborun 不会自动获得聊天上下文，也不会替你调用模型或启动子 Agent。
├─ 计划
│  ├─ 调用 arborun_plan，生成一棵具体执行树。
│  ├─ root 为 group；每个执行节点填写动作、对象、输入、通过条件和失败处理。
│  ├─ parentId 表示包含；dependsOn 表示执行先后；when 指明条件分支。
│  ├─ 有子 Agent 时声明其真实角色、权限范围、预算、父 Agent 和交付检查。
│  ├─ 调用 arborun_read 展示用户可修改的树；尚未获批准时结束当前执行等待用户操作。
│  ├─ 用户要求修改时先读取最新 revision，再以 expectedRevision 更新计划。
│  └─ 不调用 arborun_user，不从资源或预览地址提取凭证，不用 UI 自动化代替用户批准。
├─ 执行
│  ├─ 用户从树中批准后，读取最新树，确认 approval.revision 与 revision 相符。
│  ├─ 每次外部操作前，先由 arborun_claim 领取对应 ready 节点。
│  ├─ 使用宿主本身的文件、命令和 Agent 工具执行实际操作。
│  ├─ 子 Agent 的登记不等于已启动；启动后告知其 sessionId、节点、版本和上报约定。
│  ├─ 按真实进度调用 arborun_report，引用 attemptId、claimToken 和唯一 eventId。
│  ├─ passed 必须逐条给出 acceptance 对应的 checks 与证据；模型叙述不等于宿主验证。
│  ├─ 条件无法判断时上报 unknown 并等待调查或修改，不假设为 false。
│  ├─ 旧版本、暂停、依赖未满足或领取被拒绝时，不继续该节点的外部动作。
│  ├─ 需要新增计划外动作或分支时更新计划，等待用户批准新版本。
│  └─ 暂停只能停止后续协作流程；已经发出的外部命令由宿主取消或核对，不能声称自动撤销。
└─ 验收
   ├─ 所有适用节点完成后调用 arborun_submit，输出原树对应的结果与检查。
   ├─ 最终回复用 tree 结构，关联产物、证据与未解决问题。
   ├─ 用户独立决定验收通过或要求修改；Agent 不代验收。
   └─ 请求变更会重新进入计划；先读新版本，再做后续工作。
```
