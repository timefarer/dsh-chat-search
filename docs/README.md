# dsh-chat-search · 文档索引

本目录保存 `dsh-chat-search` 的设计与维护资料，供后续迭代和排查使用。
目录**不随 npm 包发布**（`package.json` 的 `files` 只收运行时文件），只在仓库里阅读。

| 文档 | 内容 |
|---|---|
| [SHOWCASE.md](./SHOWCASE.md) | 功能演示：两个入口、结果树示例、五个真实用法、能力边界 |
| [DESIGN.md](./DESIGN.md) | 设计说明：架构、数据流、协议、跳转算法、筛选窗口、性能取舍 |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 需求列表与完成状态 |
| [FEATURES.md](./FEATURES.md) | 功能清单（用户可见能力 + 内部机制） |
| [BUGS.md](./BUGS.md) | 缺陷记录、根因与修复状态 |

## 一句话概述

在 DSH 里做「会话内检索」和「全局检索」：按关键词（含文件名）搜索会话、问题、段落，结果按三层树展开，点击可直接打开会话并定位、高亮到具体内容；可用日期范围与轮次窗口收窄检索范围。

## 当前状态

- 版本：`1.0.2`
- 包名：`dsh-chat-search`（npm 已发布 1.0.1）；宿主行 id 仍是 `conversation-search`
- 测试：`test/host.mjs`、`test/client.mjs`（`npm test`）
- 安装：应用内「插件 → 添加插件」搜 `dsh-chat-search`；或 `dsh plugin add dsh-chat-search`
- 仓库位置：`deepseek-harness/projects/dsh-chat-search`
- 已知限制见 [DESIGN.md](./DESIGN.md#13-已知限制) 与 [BUGS.md](./BUGS.md) 中标记为「已知/待办」的条目
