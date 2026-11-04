```text
Arborun MCP｜宿主接入与验证
├─ 核实范围
│  ├─ 日期：2026-11-04。
│  ├─ 本机桌面宿主：ChatGPT 26.1027.61615，build 24141；Codex CLI 0.164.0。
│  ├─ 首选：Codex 桌面会话中的侧面板；独立 MCP 与 MCP Apps 保持可移植。
│  └─ 官方支持、协议测试通过与真实宿主验收是三个不同状态，不能互相代替。
├─ 侧面板接入
│  ├─ MCP 工具声明 _meta.ui.resourceUri，指向 ui://arborun/tree.html。
│  ├─ HTML 资源 MIME：text/html;profile=mcp-app。
│  ├─ OpenAI 工具元数据："openai/ui": { "entrypoints": [{ "type": "thread" }] }。
│  │  ├─ thread：当前会话的内容面板，每个会话有独立实例。
│  │  ├─ 手动打开时工具参数为 {}，服务端必须能处理空参数。
│  │  └─ global：全局导航入口打开全屏应用，不能替代当前会话侧面板。
│  ├─ UI 资源声明支持 inline/fullscreen，宿主最终决定呈现位置。
│  └─ 使用实际能力协商；不能只按客户端名称推断支持情况。
├─ 本地开发接入：先验证服务
│  ├─ 构建后入口：dist-mcp/index.mjs。
│  ├─ 独立 SDK 客户端通过 stdio 检查 initialize、tools/list、resources/read 和 tools/call。
│  ├─ 检查 app-only 工具、UI MIME、thread 元数据、版本冲突和未批准执行拒绝。
│  ├─ 在浏览器中验证树的编辑、批准、执行状态和验收；此项不算原生侧栏验收。
│  └─ stdout 仅输出 MCP 协议；本地预览地址与诊断信息输出到 stderr。
├─ 接入方式 A：直接添加本地 MCP
│  ├─ 用途：本机快速验证工具连接；不需要公开 HTTPS、API key 或发布插件。
│  ├─ 桌面端：Settings → MCP servers → Add server → STDIO。
│  ├─ 配置
│  │  ├─ 名称：arborun。
│  │  ├─ command：本机 Node 可执行文件的绝对路径。
│  │  ├─ args：构建完成的 dist-mcp/index.mjs 绝对路径。
│  │  ├─ cwd：本地 Arborun 仓库绝对路径。
│  │  └─ ARBORUN_MCP_DATA_DIR：独立、可写的数据目录绝对路径。
│  ├─ 保存后使用该服务的 Restart，再用 /mcp 确认已连接。
│  ├─ 等价 CLI 命令模板
│  │  └─ codex mcp add arborun --env ARBORUN_MCP_DATA_DIR=/absolute/data/arborun -- /absolute/node /absolute/arborun/dist-mcp/index.mjs
│  ├─ CLI 添加会写入用户 MCP 配置；文档中的命令不是已经执行的安装。
│  ├─ 桌面端、CLI 和 IDE 共用同一 Codex host 的 MCP 配置，但 UI 能力各自验证。
│  └─ 单独确认 direct stdio 的 UI/面板元数据实际生效，不能只凭工具可调用就判通过。
├─ 接入方式 B：本地插件包
│  ├─ 用途：一起分发 MCP、树 UI 和宿主工作流指引；首版推荐的完整交付形式。
│  ├─ 推荐目录
│  │  ├─ .agents/plugins/marketplace.json：仓库级本地目录。
│  │  └─ plugins/arborun/
│  │     ├─ plugin.json：插件身份。
│  │     ├─ mcp.json：本地 stdio 启动配置。
│  │     ├─ dist-mcp/index.mjs：完整打包的服务。
│  │     ├─ dist-mcp/：服务实际引用的 HTML 等构建文件。
│  │     └─ skills/：明确先规划、等用户批准、逐节点上报和最后验收的指引。
│  ├─ plugin.json 最小模板
│  │  └─ { "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "arborun", "version": "0.1.0", "description": "编辑、批准并跟踪 Agent 的决策执行树" }
│  ├─ mcp.json 最小模板
│  │  └─ { "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": { "arborun": { "type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/dist-mcp/index.mjs"], "cwd": "${PLUGIN_ROOT}", "env": { "ARBORUN_MCP_DATA_DIR": "${PLUGIN_DATA}/state" } } } }
│  ├─ marketplace.json 最小模板
│  │  └─ { "name": "arborun-local", "interface": { "displayName": "Arborun" }, "plugins": [{ "name": "arborun", "source": { "source": "local", "path": "./plugins/arborun" }, "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "category": "Productivity" }] }
│  ├─ 路径规则
│  │  ├─ marketplace source.path 相对于仓库根目录，必须以 ./ 开头。
│  │  ├─ 插件内文件通过 PLUGIN_ROOT 定位；持久数据放在 PLUGIN_DATA。
│  │  ├─ 不让插件参数通过 ../../ 引用包外开发目录。
│  │  ├─ 打包所有运行时必需文件；完整 bundle 无需复制整个 node_modules。
│  │  └─ 避免把旧桌面 release、测试产物和整个仓库打进插件缓存。
│  ├─ 安装
│  │  ├─ 在该仓库作为项目根目录时，仓库级 marketplace 可被本地客户端发现。
│  │  ├─ 当前会话工作目录若是仓库外层，不能假定子目录中的 marketplace 自动生效。
│  │  ├─ 可选显式登记命令：codex plugin marketplace add /absolute/arborun。
│  │  ├─ 在桌面 Plugins Directory 选择 Arborun 来源，安装 arborun。
│  │  ├─ 本机 CLI 同样提供：codex plugin add arborun@arborun-local。
│  │  └─ 登记/安装会改变本地插件配置；本研究未执行这些操作。
│  └─ 兼容格式
│     ├─ .codex-plugin/plugin.json + .mcp.json 仍受支持。
│     ├─ 兼容 manifest 使用 mcpServers: "./.mcp.json"。
│     └─ 新包优先使用根目录 plugin.json/mcp.json；不要只改文件名，portable MCP 还要求 type。
├─ 刷新与重启
│  ├─ 官方本地插件流程要求重启桌面应用，并在新会话中测试安装后的插件。
│  ├─ 修改本地插件后，更新 source.path 指向的包目录，再重启应用刷新安装文件。
│  ├─ 未找到承诺本地插件 UI 自动热更新的公开接口，不将热更新列为首版能力。
│  ├─ 对直接配置的 MCP，先重启该服务器；工具目录和 UI 缓存仍需实际确认。
│  ├─ 对远程自定义 MCP，官方流程是重启/部署服务、连接页 Refresh、再开新会话。
│  └─ 不在当前工作中自动重启用户桌面应用，也不自动创建验收会话。
├─ 用户批准后的继续执行
│  ├─ UI 先请求服务端批准指定版本，持久化成功后才发送继续执行消息。
│  ├─ OpenAI message 扩展可向 active 会话发送；能力存在时使用，并显示发送失败。
│  ├─ 能力缺失时提供明确的继续指令，不把按钮成功误报为模型已开始执行。
│  ├─ 用户编辑和模型改树都产生新版本并撤销旧批准；模型不能自己批准。
│  ├─ 模型每次读取/领取节点都校验已批准版本，产物与执行 attempt 保持关联。
│  └─ 首版上报标识为 Agent 上报；真实宿主工具日志需要额外 hooks 接入。
├─ 原生宿主验收
│  ├─ 打开：树在当前会话内容面板出现，重开面板能恢复同一会话状态。
│  ├─ 编辑：用户直接修改与 AI 修改都保留版本；过期批准被拒绝。
│  ├─ 批准：普通模型工具无法自批；用户点击后准确批准当前版本。
│  ├─ 继续：宿主收到当前会话继续请求，实际开始领取并执行节点。
│  ├─ 过程：可见活跃 Agent、所在节点、失败原因、证据和完成结果。
│  ├─ 并行：不同 Agent 的事件不会互相覆盖，单节点重复领取被拒绝。
│  ├─ 验收：执行完成进入待验收，用户验收与 Agent 声称完成分开记录。
│  └─ 原生挂载、续跑和跨会话隔离必须逐项记录实测结果。
└─ 其他宿主
   ├─ VS Code：支持 MCP Apps inline；官方文档列明发送消息只填入输入框，不自动提交。
   ├─ CLI：工具与文本树可用；不能因此宣称具有图形侧栏。
   ├─ Claude Desktop：MCP Apps 官方展示宿主；本轮未实际安装验证。
   └─ 通用 MCP：按能力返回工具结果和文本树，不承诺所有宿主都有同一种侧栏。
```

来源<br>
├─ 本地接入、共享配置与服务重启：[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)<br>
├─ 本地插件、marketplace、刷新与目录规则：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)<br>
├─ 首次连接、组件与新会话测试：[OpenAI 连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)<br>
├─ 会话面板与消息扩展：[OpenAI MCP Extensions 规范](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)<br>
├─ 插件配置格式：[Agent Plugins manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)、[MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)<br>
├─ UI 的可移植边界：[MCP Apps 官方概览](https://modelcontextprotocol.io/extensions/apps/overview)<br>
└─ VS Code 呈现与消息限制：[VS Code MCP 开发指南](https://code.visualstudio.com/api/extension-guides/ai/mcp)
