```text
Arborun MVP 架构
├─ 界面进程
│  ├─ React 渲染任务树、决策、版本与产物。
│  └─ 无 Node 集成；通过限定 preload API 向主进程发送命令。
├─ 桌面主进程
│  ├─ 校验 IPC 来源，处理用户选取的文件与导出目录。
│  ├─ 管理系统密钥、单实例与窗口生命周期。
│  └─ 用 utilityProcess 启动独立 Harness，状态消息推送给界面。
├─ Harness 进程
│  ├─ 命令校验 → 计划版本 → 审批 → 条件／依赖调度。
│  ├─ 有界模型循环 → 授权工具 → 候选产物 → 检查与采用。
│  ├─ 一个主任务，子 Agent 使用独立上下文并共享总预算。
│  └─ 状态先保存再广播；停止、变更后拒绝采用旧模型响应。
├─ 数据
│  ├─ TaskTree：节点层级与显式依赖。
│  ├─ Approval：计划版本、资料校验值、允许节点与预算。
│  ├─ Attempt：保留执行时规格与结果，不用新要求覆盖旧尝试。
│  ├─ Artifact：候选、采用、版本和来源节点。
│  └─ SQLite：SQL.js 单写入队列，数据库导出到临时文件并原子替换。
├─ 当前限制
│  ├─ SQLite 采用完整状态快照，适合首版规模，暂设 80 MB 保存上限。
│  ├─ 自动检查并非对任意自然语言验收条件的正确性证明。
│  └─ 外部命令沙箱和递归多 Agent 不属于本次实现。
└─ 协议参考
   ├─ Electron utilityProcess：https://www.electronjs.org/docs/latest/api/utility-process
   ├─ Electron 安全：https://www.electronjs.org/docs/latest/tutorial/security
   └─ Chat Completions 工具协议：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
```
