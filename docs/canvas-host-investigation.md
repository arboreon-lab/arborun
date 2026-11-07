```text
Arborun｜Codex 原生画布接入调查
├─ 核对时间与范围
│  ├─ 2026-11-05，沿用本机现有 Arborun 插件与 MCP。
│  ├─ 本记录只读检查源码、SDK、插件清单和官方文档。
│  └─ 未修改宿主配置、未重启桌面应用、未替用户批准任务。
├─ 已验证的本地状态
│  ├─ codex plugin list --marketplace arborun-local --json
│  │  ├─ arborun@arborun-local 0.2.0：installed=true，enabled=true。
│  │  └─ source 指向本仓库 plugins/arborun。
│  ├─ 安装缓存：~/.codex/plugins/cache/arborun-local/arborun/0.2.0。
│  ├─ 调查时缓存 tree.html 与仓库现有 dist-mcp/tree.html 的 SHA-256 一致。
│  │  └─ 这是旧构建的一致性，不证明本轮新画布已加载到宿主。
│  ├─ 子 Agent 曾短暂收到 arborun 工具声明。
│  │  ├─ 实际调用 arborun_read({}) 返回：MCP tool `arborun/arborun_read` is not available to the model。
│  │  └─ 随后工具声明被撤下；不能把工具名出现认作调用或原生挂载成功。
│  └─ 当前 open_in_codex 不提供 MCP App target，仅支持 file/page/browser/terminal/review。
├─ 现有资源与加载边界
│  ├─ UI 资源：ui://arborun/tree.html，MIME 为 text/html;profile=mcp-app。
│  ├─ arborun_read 的 thread entrypoint 允许宿主以空参数打开任务选择。
│  ├─ 资源声明支持 inline/fullscreen；最终容器由宿主决定。
│  ├─ src/mcp/index.ts 在进程启动时一次性读取 tree.html。
│  │  └─ 只替换磁盘文件或重开网页，不能证明运行中 MCP 已返回新 HTML。
│  └─ 独立 localhost 预览即使位于 Codex 内置浏览器，也不是原生 MCP Apps 面板。
├─ 桥接实施建议
│  ├─ 继续使用 app.ontoolresult 和 app.callServerTool 接入同一 Session。
│  ├─ onhostcontextchanged 后读取 app.getHostContext() 获取 SDK 合并后的上下文。
│  ├─ 向 React 暴露 displayMode、availableDisplayModes 和 containerDimensions。
│  ├─ 仅在宿主声明目标模式可用时调用 requestDisplayMode。
│  │  └─ 使用返回的 result.mode；宿主可以拒绝请求并维持原模式。
│  ├─ 继续应用宿主 theme 与 styles.variables。
│  ├─ 固定画布占用宿主容器，画布内部平移，不让整张树撑高 document。
│  │  └─ 检查 autoResize 与宿主高度变化之间是否形成反馈循环。
│  └─ 收到真实状态时保留 view、focus、selected 与 camera；编辑草稿不被轮询替换。
├─ 刷新方式与限制
│  ├─ pnpm build:mcp 会同步生成 dist-mcp 与 plugins/arborun/dist-mcp。
│  ├─ 官方本地插件流程：更新 marketplace 指向的插件目录，然后重启桌面宿主以拾取新文件。
│  ├─ 直接配置的 MCP 在宿主设置中有 Restart 流程；是否覆盖当前插件实例需 UI 实测。
│  ├─ 本机 codex plugin 命令有 add/list/remove，没有单插件 restart 子命令。
│  ├─ marketplace upgrade 的本机帮助限定刷新 Git marketplace 快照，不作为本地插件热更新证据。
│  └─ 不通过另建全局 MCP 配置、强制退出用户应用或篡改宿主内部状态规避上述限制。
└─ 原生验收步骤
   ├─ 在父会话的实际插件／内容面板入口打开 Arborun，确认出现新画布三 View。
   ├─ 核对宿主初始化成功、真实工具数据抵达、主题与容器尺寸被采用。
   ├─ 在窄侧栏和宿主展开模式分别操作子树导航、编辑、版本冲突与返回视野。
   ├─ 用明确标注的隔离测试任务核对 claim/report/submit 后原位更新与 Agent 位置。
   ├─ 批准与验收仍由既有用户控制通道处理，不把模型上报等同用户验收。
   └─ 若原生工具或新资源不能加载，分别记录“实现／协议验证通过”和“原生宿主待验证”，保留具体失败证据。
```

来源<br>
├─ 本地插件更新与重启：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)<br>
├─ MCP 设置与 Restart：[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)<br>
└─ displayMode、host context、autoResize：本仓库安装的 @modelcontextprotocol/ext-apps 1.7.5 的 app.d.ts 与 app.js。
