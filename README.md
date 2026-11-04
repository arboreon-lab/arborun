```text
Arborun
├─ 当前主线：MCP 0.2.0
│  ├─ 接入现有 Agent 工具，以可编辑的树组织计划、执行过程与结果验收。
│  ├─ 宿主负责理解上下文、调用工具、创建 Agent；Arborun 负责树与协作状态。
│  ├─ Codex 桌面端优先；标准 MCP 工具和 MCP Apps UI 保持可移植。
│  └─ 原独立桌面原型保留，说明见 docs/desktop-mvp.md；不是本轮默认入口。
├─ 使用流程
│  ├─ 用户输入 → 宿主结合上下文调用 arborun_plan。
│  ├─ 用户直接改节点、层级、依赖和条件，或让 AI 修改；更新后产生新版本。
│  ├─ 用户批准当前版本 → 宿主读取批准并逐节点领取、执行和上报。
│  ├─ 树显示 Agent 位置、问题、通过条件、证据和结果。
│  └─ 全部完成 → arborun_submit 生成验收树 → 用户验收或要求修改。
├─ 本地运行
│  ├─ 环境：Node.js 22 或更新版本、pnpm 10。
│  ├─ 安装：pnpm install --frozen-lockfile
│  ├─ 构建：pnpm build:mcp
│  ├─ MCP 启动：pnpm start:mcp
│  │  ├─ stdout 专用于 stdio MCP；诊断与预览地址写入 stderr。
│  │  └─ 将 dist-mcp/index.mjs 配置为宿主的 Node stdio 服务。
│  ├─ 可编辑示例：pnpm preview:mcp
│  │  ├─ 打开命令输出的本地链接，选择示例树。
│  │  └─ 示例不会自动执行；浏览器本身不是模型宿主。
│  └─ 预览数据与真实宿主数据分别保存。
├─ Codex 接入
│  ├─ 插件包：plugins/arborun；构建命令会复制完整运行文件。
│  ├─ 登记本地目录：codex plugin marketplace add /absolute/path/to/arborun
│  ├─ 安装：codex plugin add arborun@arborun-local
│  ├─ 按宿主要求刷新／重启后，在会话中启用 Arborun。
│  ├─ 用法：使用 Arborun，把这个任务先规划为可编辑执行树，等我批准再执行。
│  └─ 详细接入、官方依据和原生验收步骤：docs/mcp-hosts.md。
├─ 核心约束
│  ├─ 未批准或旧版本不得领取；模型工具没有 approve/accept 参数。
│  ├─ 用户动作使用 app-only 工具与 UI capability；依赖宿主正确隔离界面和模型。
│  ├─ 版本冲突拒绝保存，避免覆盖用户编辑。
│  ├─ 修改撤销批准；失效范围传播到后代与依赖；迟到结果只进历史。
│  ├─ 条件未知时阻塞；未触发分支保留原因。
│  ├─ 独立节点可被不同 Agent 同时领取，同一节点不能重复领取。
│  └─ 子 Agent 结果检查、任务提交与用户验收分别记录。
├─ 能力边界
│  ├─ 执行位置与证据来自 Agent 上报；首版未接入 Codex 全量工具 hooks。
│  ├─ 不显示模型内部思维链；展示计划、可观察动作、检查和简明决定依据。
│  ├─ MCP 无法禁止宿主绕过它操作文件，也无法撤销已发出的外部命令。
│  ├─ 角色、权限与预算是批准约定；实际权限和调用预算由宿主控制。
│  ├─ 批准后自动续跑依赖宿主消息能力；不支持时显示继续指令。
│  ├─ 首版同一数据目录仅运行一个服务进程；不同宿主使用独立数据目录。
│  └─ MCP 连接成功、浏览器测试通过，不等于原生侧栏已经验收。
├─ 数据
│  ├─ ARBORUN_MCP_DATA_DIR 指定数据目录，默认当前目录的 .arborun-mcp。
│  ├─ 插件安装使用 PLUGIN_DATA/state，不将用户任务放进插件源码。
│  ├─ 本地原子 JSON 快照，包含计划版本、执行记录、证据和验收状态。
│  ├─ 保存失败不发布新状态，重启时暂停此前活跃执行以供核对。
│  └─ 本地浏览器只监听 127.0.0.1，使用临时凭证及 Origin/Host 检查。
├─ 验证命令
│  ├─ pnpm typecheck
│  ├─ pnpm test：原有引擎及新增 MCP 核心／传输测试。
│  ├─ pnpm build:mcp && node scripts/check-mcp.mjs：打包产物真实 stdio 闭环。
│  └─ pnpm test:mcp-ui：浏览器编辑、运行位置、失败重试、验收与并发修改测试。
│     └─ 本机已有 Chrome 时可用 ARBORUN_TEST_BROWSER_CHANNEL=chrome。
├─ 代码
│  ├─ src/mcp：独立协议状态机、服务、持久化和 stdio 入口。
│  ├─ src/mcp-ui：嵌入式单树界面与 MCP Apps 桥接。
│  ├─ plugins/arborun：本地插件声明与宿主工作流 skill。
│  └─ src/harness、src/desktop、src/renderer：保留的桌面原型。
└─ 交付状态
   ├─ 本地版本，未发布远程服务或 npm 包。
   ├─ 具体测试和宿主实测状态见 docs/mcp-verification.md。
   └─ 开源方向不变；许可证仍待选定，未自动创建公开 Release。
```
