```text
Arborun
├─ 定位
│  └─ 用可编辑的树组织意图、条件、决策、执行与交付。
├─ 当前版本
│  ├─ 0.1.0 本地 MVP，Electron + React + TypeScript。
│  ├─ 独立 Harness 进程负责模型循环、工具、审批、预算和恢复。
│  └─ 计划面向 macOS、Windows、Linux；实机验收状态见 docs/verification.md。
├─ 快速运行
│  ├─ 环境：Node.js 24 或更新版本、pnpm 10。
│  ├─ 安装：pnpm install --frozen-lockfile
│  ├─ 构建：pnpm build
│  ├─ 打开桌面应用：pnpm start
│  └─ pnpm dev 仅启动界面开发服务器；实际执行需要 Electron 桥接。
├─ 第一次体验
│  ├─ 打开预置 CSV 导出任务，单击节点编辑具体动作和通过条件。
│  ├─ 确认并运行，在执行树中查看读取、条件判断与子 Agent 核验。
│  ├─ 选择冲突编码的处理口径，继续生成需求树与验收树。
│  ├─ 选中已完成节点重新执行，查看新产物与历史版本。
│  └─ 导出包含任务 JSON、树形 Markdown 和所有产物版本的目录。
├─ 模型执行
│  ├─ 在“模型连接”中填写兼容 Chat Completions 的 API 基础地址、模型名称和密钥。
│  ├─ 基础地址通常以 /v1 结尾；也可以填写完整 /chat/completions 地址。
│  ├─ 模型服务需支持 function tools、tool_calls 和 max_completion_tokens。
│  ├─ 远端要求 HTTPS，本机服务允许 localhost HTTP；不自动跟随重定向。
│  ├─ 创建模型任务，导入 UTF-8 TXT、Markdown 或 JSON 资料，再生成计划。
│  ├─ 生成计划会向已配置服务发送任务要求和选定资料摘要；执行按需发送资料内容。
│  └─ 演示模式使用预置本地逻辑，不调用模型，不作为实际模型能力证明。
├─ 已实现
│  ├─ 节点编辑、增删、父子调整、显式依赖与结构校验。
│  ├─ 条件成立／不成立／未知，人工决策与一层受限子 Agent。
│  ├─ 实时执行事件、版本确认、预算、暂停取消与局部重试。
│  ├─ 产物版本、候选与采用状态、引用检查和 SQLite 保存。
│  └─ 重启恢复、单实例保护、文件导入与任务导出。
├─ 边界
│  ├─ 同时运行一项任务；子 Agent 以独立上下文串行执行，不递归派生。
│  ├─ 内置工具仅处理已选资料快照与任务产物，不执行任意 Shell 或浏览器操作。
│  ├─ 自动验证覆盖结构、来源和执行条件；业务质量仍需用户审阅。
│  ├─ 模型响应以每次工具调用完成为边界更新，不展示逐字流或模型内部思维链。
│  ├─ 任务包已支持导出，图形界面导入任务包尚未实现。
│  └─ 无自动更新、实时云同步、多人协作或远端任务服务。
├─ 本地数据
│  ├─ 数据库在系统应用数据目录，使用 SQLite WASM 与原子快照保存。
│  ├─ 模型密钥采用可用的系统保护；无法可靠保护时只在当前会话保留。
│  ├─ 密钥不进入任务包；任务包包含导入资料快照，应由用户自行管理分享范围。
│  └─ 用户数据和公司资产留在代码仓库之外，云盘可备份导出的完整任务目录。
├─ 开发验证
│  ├─ pnpm test：Harness、文件工具、存储与模型协议测试。
│  ├─ pnpm typecheck：类型检查。
│  ├─ pnpm build && pnpm test:e2e：实际 Electron 桌面闭环测试。
│  ├─ pnpm package:mac：macOS 本地未签名应用包。
│  ├─ pnpm package:win：Windows NSIS 构建入口，需要对应环境验证。
│  └─ pnpm package:linux：Linux Debian 构建入口，需要对应环境验证。
├─ 仓库组织
│  ├─ src/shared：数据契约与演示资料。
│  ├─ src/harness：执行引擎、模型连接和 SQLite 存储。
│  ├─ src/desktop：Electron 主进程、preload 和独立运行进程。
│  ├─ src/renderer：树编辑与执行界面。
│  └─ tests、docs、examples、resources：测试、树形文档、示例与应用图标。
└─ 开源状态
   ├─ 产品方向为完全开源，单一公开 arborun 仓库承载代码与文档。
   └─ 具体开源许可证尚未选定，本次实现未代选许可证或创建公开 Release。
```
