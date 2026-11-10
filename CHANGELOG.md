# 更新记录

## 1.0.1

- 文档：README 的两张截图改用 raw 绝对地址，npm 包页面也能正常显示（包内仍不含 `docs/`，安装体积不变）。
- 界面角标与 manifest 版本同步为 `1.0.1`。

## 1.0.0

首个公开版本。

- 会话内右侧栏检索（`Ctrl/Cmd+F`）与左栏**全局检索**整页，覆盖所有已存储会话。
- 结果按**会话 → 问题 → 段落**三层展开；文件名（附件、工具调用路径、`apply_patch` 头）可单独命中。
- 5 档范围：会话+问题+段落（默认）、会话+问题、仅会话、仅问题、仅段落。
- 筛选窗口：日期范围（默认最近 14 天）与每会话最近 N 轮（默认 30），留空即不限；
  保存在 `plugin-data/conversation-search/filters.json`。
- 跳转：打开会话、补齐缺失历史、按 seq/锚点+轮次解析，再用原生 `::highlight()` 标出命中词并保持高亮。
- 最近查询保存在 `plugin-data/conversation-search/recent.json`。
- Host 接口 `POST /conversation-search/api`，无浏览器凭据返回 401。
- 中英双语、明暗主题；两套无第三方依赖的无头测试。
