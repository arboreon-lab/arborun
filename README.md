```text
Arborun
├─ 当前主线：MCP 0.2.3
│  ├─ 面向跨度大、约束少、几乎不可能一次做完的任务，例如训练一个模型、写一篇论文。
│  ├─ 接入现有 Agent 工具，以可编辑的树组织计划、执行过程与结果验收。
│  ├─ 宿主负责理解上下文、调用工具、创建 Agent；Arborun 负责树与协作状态。
│  ├─ Codex 桌面端优先；标准 MCP 工具和 MCP Apps UI 保持可移植。
│  └─ 原独立桌面原型保留，说明见 docs/desktop-mvp.md；不是本轮默认入口。
├─ 使用流程
│  ├─ 用户输入 → Codex 在正常对话中问清要求 → 宿主结合上下文调用 arborun_plan。
│  ├─ 用户直接改节点、层级、依赖和条件，或让 AI 修改；更新后产生新版本。
│  ├─ 用户批准当前版本 → 宿主读取批准并逐节点领取、执行和上报。
│  ├─ 树显示 Agent 实际位置、当前动作、双向消息、检查依据和结果。
│  └─ 全部完成 → arborun_submit 生成验收树 → 用户验收或要求修改。
├─ 树形画布
│  ├─ 以验收者的视角组织：主干是根的子节点，按先后连成路径，末端固定为用户验收。
│  ├─ 效果（kind=result）下并排列出测试；Agent 的实现步骤默认收起为“Agent 工作”。
│  ├─ 测试标明“你设定”或“Agent 补充”；用户设定的测试不能被 Agent 更新修改或删除。
│  ├─ 进度按测试计数；失败测试在预算内由 Agent 自动修复，界面说明无需用户处理。
│  ├─ Claude 风格：暖中性底色、陶土色强调、细线与柔和阴影；浅色／深色跟随宿主或系统；不访问外部资源。
│  ├─ 无限画布：6%–800% 缩放，远景只显示标题；单击详情，双击进入任意节点。
│  ├─ 卡片可拖动，只改布局不改关系；悬停高亮从主干起点到该节点的路径。
│  ├─ 每个节点的详情在右侧栏按四部分显示：输入、输出、描述、测试。
│  │  ├─ 测试由正常情况、边界情况、极端情况三类样例组成，规划时由 Agent 生成。
│  │  └─ 节点执行后，每个样例显示实际结果和证据：命令行输出、截图、短演示录像、文字或链接。
│  │     └─ 截图与录像由 Agent 以本地路径上报，Arborun 复制到数据目录 artifacts/ 后在面板显示。
│  ├─ 在 Codex 侧栏显示（preferredModelDisplayMode=fullscreen）；可折叠为概览。
│  │  └─ 概览：任务状态、测试进度、效果链（末端为用户验收）、Agent 当前动作；点击效果即展开定位。
│  ├─ 右上角只有两个图标：折叠为概览与 View（从上到下／从左到右）。
│  └─ 设计与验证记录：docs/result-centred-canvas.md。
├─ 本地运行
│  ├─ 环境：Node.js 22 或更新版本、pnpm 10。
│  ├─ 安装：pnpm install --frozen-lockfile
│  ├─ 构建：pnpm build:mcp
│  │  └─ 本目录登记为插件市场时，构建后自动卸载并重新安装 arborun@arborun；重启 Codex 生效。
│  │     └─ CI 或 ARBORUN_SKIP_CODEX_INSTALL=1 时跳过；没有 codex 命令或未登记本地市场时也跳过。
│  ├─ MCP 启动：pnpm start:mcp
│  │  ├─ stdout 专用于 stdio MCP；诊断与预览地址写入 stderr。
│  │  └─ 将 dist-mcp/index.mjs 配置为宿主的 Node stdio 服务。
│  ├─ 可编辑示例：pnpm preview:mcp
│  │  ├─ 打开命令输出的本地链接，选择示例树。
│  │  └─ 示例不会自动执行；浏览器本身不是模型宿主。
│  └─ 预览数据与真实宿主数据分别保存。
├─ 安装到 Agent 工具（需要 Node.js 22+；装好后重启该工具）
│  ├─ Codex：codex plugin marketplace add arboreon-lab/arborun && codex plugin add arborun@arborun
│  ├─ Claude Code：claude plugin install arborun --marketplace arboreon-lab/arborun
│  ├─ Claude Desktop：npx -y github:arboreon-lab/arborun#mcp install claude-desktop
│  ├─ Antigravity：npx -y github:arboreon-lab/arborun#mcp install antigravity
│  ├─ Trae：npx -y github:arboreon-lab/arborun#mcp install trae
│  ├─ WorkBuddy：npx -y github:arboreon-lab/arborun#mcp install workbuddy
│  ├─ Cursor／Gemini CLI：npx -y github:arboreon-lab/arborun#mcp install cursor（或 gemini-cli）
│  ├─ 其他支持 mcpServers 的工具（如 DeepSeek 系列 harness、Trae CN）：
│  │  └─ npx -y github:arboreon-lab/arborun#mcp install --config <该工具的 MCP 配置文件>
│  ├─ 本机已装的上述工具一次装好：npx -y github:arboreon-lab/arborun#mcp install --all（不含 Codex）
│  ├─ 只看配置片段：npx -y github:arboreon-lab/arborun#mcp install --print
│  ├─ 安装器把服务端复制到 ~/.arborun/server，数据在 ~/.arborun/data；写配置前备份原文件。
│  ├─ 宿主能渲染 MCP Apps（Codex、Claude 等）时，树显示在宿主内。
│  │  └─ 不能渲染时，服务端在本机浏览器自动打开面板；带用户凭证的地址不交给模型。
│  └─ 工作流说明随 MCP 初始化下发；Codex 与 Claude Code 插件另带 skill。
├─ Codex 接入
│  ├─ 一行安装（需要 Node.js 22+）：
│  │  └─ codex plugin marketplace add arboreon-lab/arborun && codex plugin add arborun@arborun
│  ├─ 插件包：plugins/arborun；构建命令会复制完整运行文件，构建产物随仓库提交。
│  ├─ Codex 清单：plugins/arborun/.codex-plugin/plugin.json（显示名、简介、图标、示例提示）。
│  │  └─ 图标：plugins/arborun/assets/logo.png，由 scripts/build-plugin-icon.mjs 生成（陶土色底、象牙色树形）。
│  ├─ 本地开发：codex plugin marketplace add /absolute/path/to/arborun，再 codex plugin add arborun@arborun
│  ├─ 按宿主要求刷新／重启后，在会话中启用 Arborun。
│  ├─ 用法：使用 Arborun，把这个任务先规划为可编辑执行树，等我批准再执行。
│  └─ 详细接入、官方依据和原生验收步骤：docs/mcp-hosts.md。
├─ 协作事件
│  ├─ arborun_activity 记录 action、message_sent、message_received。
│  ├─ 发送与接收分别认证；绑定当前批准版本、有效执行与领取凭证。
│  ├─ Codex 对话正常输出；活动通道只返回简短确认，树同步可观察过程。
│  └─ 澄清门控与真实子 Agent 验证见 docs/collaboration-verification.md。
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
│  ├─ ARBORUN_MCP_DATA_DIR 指定数据目录，默认 ~/.arborun/data。
│  ├─ 插件安装使用 PLUGIN_DATA/state，不将用户任务放进插件源码。
│  ├─ 本地原子 JSON 快照，包含计划版本、执行记录、证据和验收状态。
│  ├─ 保存失败不发布新状态，重启时暂停此前活跃执行以供核对。
│  └─ 本地浏览器只监听 127.0.0.1，使用临时凭证及 Origin/Host 检查。
├─ 验证命令
│  ├─ pnpm typecheck
│  ├─ pnpm test：原有引擎及新增 MCP 核心／传输测试。
│  ├─ pnpm build:mcp && node scripts/check-mcp.mjs：打包产物真实 stdio 闭环。
│  ├─ pnpm test:mcp-ui：浏览器编辑、运行位置、失败重试、验收与并发修改测试。
│  │  └─ 本轮已更新测试用例，界面由 CUA 实测；未运行该 Playwright 命令。
│  └─ node scripts/preview-mcp-app.mjs：官方 AppBridge 的隔离测试宿主；不是 Codex 原生面板。
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
