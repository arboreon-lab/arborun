```text
Arborun MCP｜验收视角的执行树
├─ 用户要求（2026-11-05）
│  ├─ 人验收时看测试与前端效果，不看代码；中间过程按人的关注程度分层。
│  ├─ 拍板的决定在提问阶段确认，不进入树。
│  ├─ 采用树：只有一个输出的环节退化为路径，最终验收在主干末端。
│  ├─ 黑底、米白手绘形状与手写字体；右上角只保留一键折叠与 View 两个图标。
│  └─ 无限画布、双击进入任意节点、悬停反馈、可拖动卡片。
├─ 数据与引擎
│  ├─ 新节点类型：result（要达到的效果）与 test（当……时，应该看到……）。
│  ├─ test.by 记录设定者：user 为验收标准，agent 为补充检查。
│  ├─ result 与 group 同为容器：不可领取，状态由内部测试与步骤汇总。
│  ├─ 每个 result 至少需要一个 test；只有 test 可以标注 by。
│  ├─ arborun_plan 更新时，用户设定的测试不得修改或删除；用户可在树中编辑。
│  └─ 验收树文字输出标注“用户设定／Agent 补充”与“要达到的效果”。
├─ 界面
│  ├─ 主干：根的子节点依次排列，末端为虚拟的“用户验收”节点。
│  ├─ 子节点依赖前一个时连成路径，否则为分支；效果内的测试并排、无顺序。
│  ├─ 效果下的实现步骤收进虚拟“Agent 工作”节点，线条最淡。
│  ├─ 进度按测试计数；修复中的 Agent 工作不显示为用户问题。
│  ├─ 默认全部折叠：只显示主干；展开或进入节点后才显示其内容。
│  ├─ 节点为圆形，分三段：上为名称，中为具体内容（运行中改为 Agent 正在做的事），下为状态图标。
│  │  └─ 状态图标：完成为勾、等待为钟面、运行中为该 Agent 颜色的播放符号；未通过为叉、需处理为叹号。文字仅作读屏与悬停提示。
│  ├─ Agent 进度：圆外一圈粗描边，每个 Agent 一种颜色，按其负责的步骤与测试占比分段，通过一项描一段。
│  │  ├─ 未完成部分为同色虚点；正在工作的 Agent 在其描边末端显示闪烁圆点，不使用旋转弧。
│  │  └─ 颜色按 Agent 出现顺序取 --agent-0…5，同一 Agent 在树、概览、详情中颜色一致；用户验收节点不画。
│  ├─ 详情按类型展示：根任务（已确认要求、批准）、效果、测试（证据与自动修复）、验收。
│  ├─ 步骤与测试的详情在右侧栏打开，依次为：
│  │  ├─ 输入（含“在哪”）、输出（含“做到这些才算完成”）。
│  │  ├─ 怎么做／怎么测：一两句话说明输入怎么变成输出，下面列出注意事项、先等谁、何时才做、没做到怎么办。
│  │  └─ 测试样例：正常情况、边界情况、极端情况分组，每条“输入 → 应该得到”。
│  ├─ 所有文字简短直白，非专业人士也能看懂；同一意思只写一次（服务说明与 skill 同样要求 Agent）。
│  ├─ 测试样例由 Agent 规划时自动生成（服务说明与 skill 要求三类各至少一个）；缺少时详情中可一键请 Agent 生成，改动形成新版本、需重新批准。
│  ├─ 手绘：rough.js 固定种子绘制卡片、连线、框与状态图标；运行中节点轮廓轻微重绘。
│  ├─ 字体：霞鹜文楷 Lite 子集（GB2312 一级字 + ASCII，约 0.9 MB），罕见字回退系统楷体。
│  │  └─ 生成脚本 scripts/subset-font.py；许可证 src/mcp-ui/assets/LXGW-WenKai-OFL.txt。
│  └─ 双击按浏览器点击计数判定，避免首次点击重绘卡片后误进入相邻节点。
├─ 已验证
│  ├─ pnpm typecheck、git diff --check 通过。
│  ├─ pnpm test：11 个文件、100 项通过，含新增 tests/mcp-results.test.ts 与重写的 mcp-canvas.test.ts。
│  ├─ node scripts/check-mcp.mjs：stdio 生命周期与重启持久化通过。
│  ├─ Playwright（ARBORUN_TEST_BROWSER_CHANNEL=chrome）：tests/mcp-ui.e2e.ts 3 项，连续 3 次通过。
│  └─ 本地面板实测：examples/mcp-results-plan.json 经真实 MCP 工具批准、领取、上报后渲染正确。
├─ 视觉检查（本地面板，1240 × 780）
│  ├─ 主干、效果框、测试并排、Agent 工作收起与消息弧线均可辨认。
│  └─ 失败测试详情显示预期与实际证据，以及“Agent 正在自动修复，不需要你处理”。
├─ 2026-11-07｜放在对话框上方，折叠概览、展开详情
│  ├─ Codex 只读取工具 _meta["openai/ui"].preferredModelDisplayMode（inline／fullscreen），不支持 pip。
│  │  └─ 依据：openai/codex 的 codex-rs/core/src/mcp_tool_call.rs 与 app-server README。
│  ├─ arborun_read、arborun_plan、arborun_submit、arborun_user 声明 inline；资源首选模式同为 inline。
│  ├─ 内嵌时默认显示概览，并通过 ui/notifications/size-changed 报告高度；展开后报告 640px。
│  ├─ 概览：任务状态与测试进度、效果链、Agent 当前动作、未通过测试；需要批准或验收时直接给出按钮。
│  ├─ 右上角的折叠图标改为“折叠为概览”；概览右上角只有“展开详情”图标。
│  ├─ 位置由宿主决定：内嵌视图位于调用工具的消息处，后续消息出现后会随对话上移。
│  └─ 验证：100 项单元测试、stdio 闭环、Playwright 3 项（含概览折叠／展开）通过；Codex 原生内嵌未实测。
├─ 2026-11-07｜改回侧栏，并自动安装到 Codex
│  ├─ 各工具 preferredModelDisplayMode 与资源 preferredDisplayMode 改回 fullscreen（侧栏）。
│  ├─ 折叠为概览、展开为详情保留；侧栏中默认展开。
│  ├─ scripts/install-codex-plugin.mjs：build:mcp 结束后执行 codex plugin remove／add。
│  │  └─ 原因：版本号不变时 Codex 继续使用旧缓存；重新安装后缓存与构建一致（已用 cmp 核对）。
│  └─ 仍需重启 Codex 桌面端才会加载新文件。
└─ 未验证与边界
   ├─ Codex 原生 MCP Apps 面板未实测；宿主若不允许 data: 字体，将回退系统楷体。
   ├─ 本地插件安装（plugins/arborun）已随构建更新，未重新安装到 Codex。
   └─ 截图类证据需 Agent 以图片 data URL 上报；外部图片地址受 CSP 限制不显示。
```
