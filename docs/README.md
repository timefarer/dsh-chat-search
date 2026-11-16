# dsh-chat-search · 文档索引

| 文档 | 内容 |
|---|---|
| [SHOWCASE.md](./SHOWCASE.md) | 功能演示：两个入口、结果树示例、五个真实用法、能力边界 |
| [FEATURES.md](./FEATURES.md) | 功能清单（用户可见能力 + 内部机制） |
| [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) | 已知限制与暂不支持的行为（轻量清单） |

## 一句话概述

在 DSH 里做「会话内检索」和「全局检索」：按关键词（含文件名）搜索会话、问题、段落，结果按三层树展开，点击可直接打开会话并定位、高亮到具体内容；可用日期范围与轮次窗口收窄检索范围。

## 当前状态

- 版本：`1.2.5`
- 包名：`dsh-chat-search`；宿主行 id 仍是 `conversation-search`
- 测试：`test/host.mjs`、`test/client.mjs`（`npm test`）
- 安装：应用内「插件 → 添加插件」搜 `dsh-chat-search`；或 `dsh plugin add dsh-chat-search`
- 已知限制：[KNOWN-ISSUES.md](./KNOWN-ISSUES.md)
