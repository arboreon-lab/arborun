```text
Arborun MCP（npx 分支）
├─ 本分支由 scripts/publish-mcp-branch.mjs 从 main 构建生成，请勿手改。
├─ 安装到 Agent 工具（需要 Node.js 22+）
│  ├─ npx -y github:arboreon-lab/arborun#mcp install <工具>
│  │  └─ claude-desktop、claude-code、codex、antigravity、trae、workbuddy、cursor、gemini-cli
│  ├─ npx -y github:arboreon-lab/arborun#mcp install --all
│  ├─ npx -y github:arboreon-lab/arborun#mcp install --config <mcpServers 配置文件>
│  └─ npx -y github:arboreon-lab/arborun#mcp install --print
├─ 直接作为 stdio 服务运行：npx -y github:arboreon-lab/arborun#mcp
└─ 源码与完整说明：https://github.com/arboreon-lab/arborun
```
