# 设计说明

## 1. 目标

在 DSH Web/RU 界面内提供两类检索：

1. **会话内检索**：右侧栏面板，检索当前会话的已加载（可自动补全）内容。
2. **全局检索**：左侧导航图标 + 主内容区页面，检索所有已存储会话。

两者的结果都能**打开会话并定位**，命中词在内容区可见地标记出来。

## 2. 架构

```
┌──────────────────────────── Client (browser) ────────────────────────────┐
│  header button (放大镜)  ──► 右栏 Tab: SearchPanel ─┐                     │
│  左栏图标 global-search  ──► main 面板: GlobalSearchPage ─┤                │
│  Ctrl/Cmd+F              ──► 右栏 Tab（并聚焦）            │                │
│                                                          ▼                │
│  会话内：直接读 useChat 的 Chat 节点（已加载窗口）                          │
│  全局：   POST /conversation-search/api  ───────────────┐                 │
│  JumpRunner / OpeningWatcher / OpeningMask：跳转与过场      │                 │
└──────────────────────────────────────────────────────────┼────────────────┘
                                                           ▼
┌──────────────────────────── Host (Node) ──────────────────────────────────┐
│  sessionQuery.listSessions / readSession                                  │
│  → 折叠为 Session → question → paragraph（含文件、标题、anchor）            │
│  → 内存索引（TTL 30s，live 变化即时失效）                                   │
│  → 匹配 + 响应；最近查询写 plugin-data/.../recent.json                      │
└───────────────────────────────────────────────────────────────────────────┘
```

### 为什么全局检索放在 Host

浏览器只有当前会话的已加载窗口；「检索所有会话」必须读完整语料。`ctx.sessionQuery` 是进程内统一的会话查询服务（实时优先、持久化兜底），且自带分页与错误码，Host 侧折叠后按需返回结构化结果。

### 为什么会话内检索留在 Client

会话内面板就在当前会话上，`useChat` 已持有节点与顺序；直接读节点可以做到零网络、随输入即时应答，并能拿到精确的节点 key 用于跳转。

## 3. 数据模型

Host 折叠后的一条语料：

```
entry = {
  id, cwd, createdAt,
  title,          // 真实标题（session/title 事件）
  displayTitle,   // 无标题时用首条提问前 40 字
  signature,      // live:事件数 / stored
  questions: [{
    seq, text, files: string[],      // files = 用户附件名
    paragraphs: [{
      seq, kind: 'text' | 'file',
      text,                          // 文本段落；file 行为 ''
      files: string[],               // 工具调用路径 / patch 路径
    }]
  }]
}
```

- **问题**由 `user/message`（`source.kind` 为 `user` / `steering`）开启；其后的 `assistant/message` 依次贡献段落。
- **文件行**：有工具调用路径、且正文未包含该文件名时，单独成行，保证可检索、可跳转、可解释。
- 文件来源：用户附件（`block.attachment`）、工具参数（`path/file_path/target/filename`）、`apply_patch` 的 `*** Update File:` 头。

## 4. 检索范围（scope）

| scope | 匹配字段 |
|---|---|
| `all` | 会话标题 + 问题（文本/附件名）+ 段落（文本/文件名） |
| `session-question` | 会话标题 + 问题 |
| `session` | 仅会话标题（文件不参与） |
| `question` | 仅问题（文本/附件名） |
| `paragraph` | 仅段落（文本/文件名） |

- 关键词按空格拆分，**全部命中**才算命中；大小写不敏感的子串匹配（中文适用）。
- 文件命中要求：所有关键词落在**同一个文件名**内。

## 5. 接口

`POST <page base>/conversation-search/api`，JSON body：

```jsonc
{ "action": "search", "query": "string", "scope": "all", "refresh": false,
  "filters": { "since": "2026-10-27", "until": "2026-11-09", "turns": 30 } }
{ "action": "recent" }
{ "action": "filters" }                       // 读取已保存的筛选窗口
{ "action": "filters", "filters": { ... } }   // 写入筛选窗口
```

响应统一信封 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。

`value`（search）：

```
{ query, scope, recent: string[], filters: { since, until, turns },
  sessions: [{ id, title, displayTitle, cwd, createdAt, matched,
    questionTotal, paragraphTotal,
    questions: [{ seq, number, anchor, text, matched, textMatched,
      inputFiles, matchedFiles, paragraphTotal,
      paragraphs: [{ seq, index, turn, kind, anchor, text, hits,
        matched, textMatched, outputFiles, matchedFiles }] }] }],
  stats: { sessions, questions, paragraphs, indexed, truncated, tookMs } }
```

约束：单次最多 30 会话 / 12 问题 / 8 段落；语料最多 400 会话、800 万字符；body ≤ 128 KiB。

鉴权：`ctx.connection.requestRejection`（浏览器凭据）；无凭据返回 401。

## 6. 跳转算法

`openTarget(sessionId, jump, title)`：

1. 记录 `pendingJumps[sessionId] = { seq, kind, words, anchor, turn }`；
2. `beginOpening()` 开启过场（160ms 后才显示蒙版，避免闪烁）；
3. `uiWorkspace.openSession(sessionId)`——它同时把主面板切回对话。

`JumpRunner`（会话标题栏里的无渲染组件）按 120ms 轮询解析落点：

1. 同种类节点且 `anchorSeq === seq`；
2. **同一轮**内文本包含 `anchor`；
3. 任意节点文本包含 `anchor`；
4. 仅当历史已加载完（`hasMore === false`）或重试 > 20 次，才允许「最近节点」兜底；
5. 都不中 → 不落点，`loadThrough(seq)` 补历史后继续等。

落地后 `replayLanding` 在 120/400/900/1500ms 重放「滚动 + 高亮 + 描边」，抵消平滑滚动导致的坐标漂移与 ChatView 重渲染带来的节点替换。**会话内面板与全局跳转共用同一入口**（`jumpToNode` 内部即重放），避免只画一次时标记留在旧坐标。

> 早期版本在找不到精确 seq 时直接取「最近的已加载节点」，目标未加载时会先跳到上一条消息并结束跳转——这是「落点不准」的根因，v6 已修正。

## 7. 高亮实现

**首选原生文本高亮，几何覆盖层仅作兜底。**

- `wordRanges(row, words)` 在行内遍历文本节点，生成命中 `Range`；
- 有 Custom Highlight API 时：`CSS.highlights.set('dsh-chat-search', new Highlight(...ranges))`，配合
  `::highlight(dsh-chat-search){background-color:rgba(74,144,255,.32);color:inherit}`。
  高亮锚在文本上，**滚动时天然跟随**，观感与浏览器查找一致（纯底色、无边框），也不改动 Chat DOM；
- 没有该 API 时：在 `document.body` 下画 `position: fixed` 的半透明方框（同样无边框），并监听聊天滚动容器与窗口 resize，
  用 `requestAnimationFrame` 重新定位（`transform` 平移），保证跟随滚动；
- **常驻策略**：高亮不自动消失，直到下一次检索（查询词变化）或关闭会话内检索面板；全局检索跳转后离开页面不清除；
- 落地后 120/400/900/1500ms 重放（重渲染会换掉文本节点，Range 需要重建）；
- 不再给整行加描边环：落地反馈只靠滚动 + 文字底色，避免"框住整条消息"的观感。

> 早期版本的 `::highlight` 规则里用了 `color-mix()`；在不支持的构建上该声明会被丢弃，
> 高亮因此“存在但透明”，看起来像完全没有高亮。现在颜色一律先用 `rgba()`，`color-mix()` 只作为增强。

## 8. 过场与状态

- `openingState`：模块级状态 + 订阅；`OpeningMask` 注册在 `shell.overlay`（全窗口、跨面板存活）。
- 有跳转时蒙版由「落地」结束；无跳转由 `openState === 'open'` 结束；错误态立即结束；20s 硬超时。
- 快速打开（<160ms）不显示蒙版。

## 9. 历史持久化

- Host 侧 `recent.json`：`<DSH_PROFILE_DIR>/plugin-data/conversation-search/recent.json`，缺失 profile 时退回 `~/.dsh/conversation-search/recent.json`。
- 最多 8 条、去重前置、临时文件 + rename 原子写；读写失败只记日志，不影响检索。
- search 成功后写入并随响应返回 `recent`；`action:'recent'` 供页面初次加载。

## 10. 快捷键

- 原生注册 `conversation-search.find`（`KeyF` + `primary`，桌面三平台 + Web macOS/Windows），参与冲突检查、可改键。
- 注册被拒时退回 `document` 捕获监听（排除 `.cm-editor` / `.xterm`）。
- 触发 `openSearchTab(ctx, null)`：打开当前会话的检索 Tab，并以「任意可见面板」信号聚焦输入框（隐藏面板自动跳过）。

## 11. 筛选窗口

两个维度，作用于「一轮对话」（以该轮用户消息的时间为准）：

| 维度 | 字段 | 语义 | 默认 |
|---|---|---|---|
| 日期范围 | `since` / `until`（`YYYY-MM-DD`，本地日历日） | 轮次时间落在 `[since 00:00, until 23:59:59]` | 最近 14 天（含今天） |
| 对话轮次 | `turns`（正整数） | 每个会话只取最后 N 轮；先取最后 N 轮，再用日期过滤 | 30 |
| 不限 | `since`/`until` 为空串、`turns` 为 0 | 该维度不设限 | — |

- **全局检索**：Host 在 `searchCorpus` 内按会话逐个裁剪，再匹配、再限定返回条数；`questionTotal` 仍是该会话的真实轮数，`number` 仍是会话内的真实轮次序号（跳转用它定位）。
- **会话内检索**：Client 在 `searchConversation` 内先算已加载窗口的最大轮次，取 `maxTurn - turns + 1` 之后的行，再按 `location.turn.start.time` 过滤日期。
- **轮次未知时**：日期过滤视为通过（宁可多返回，也不隐藏无法判断的内容）。
- **持久化**：`<profile>/plugin-data/conversation-search/filters.json`，原子写；页面与面板共用同一份配置，输入停顿 400ms 后写回。
- **生效**：修改任一筛选后立即重跑当前检索（全局走 Host，会话内走本地），不需要重新输入关键词。
- **展示**：全局页统计行与会话内面板的筛选按钮都显示当前窗口摘要（如 `10-27 ~ 11-09 · 最近 30 轮`），全部不限时显示 `全部范围`。

> 说明：筛选减少的是「匹配与返回」的工作量，索引仍需要读一遍会话日志——宿主没有暴露"某会话最后一次写入时间"，无法在读取前裁剪。

## 12. 性能取舍

- 全局页结果树按 `(result, expanded, resultWords)` 记忆化，输入与状态脉冲不重建 DOM。
- 结果行/会话块启用 `content-visibility: auto`，离屏内容跳过布局与绘制。
- 过场蒙版不使用 `backdrop-filter`（避免整屏重新合成）。
- Host 索引 30s TTL + live 事件数变化即时失效 + 2.5s 最小重建间隔；`refresh: true` 可强制重建。
- 会话内面板在输入非空时自动分页补全历史（同一面板只自动触发一次）。

## 13. 已知限制

1. **侧栏开合导致的列宽动画仍是宿主行为**：本插件只移除了自身在动画期间的开销（模糊、离屏布局），无法改变右栏展开/收起时中央列重排的固有成本。
2. 文件检索覆盖「会话自带附件 + 工具调用路径」，不索引工作区里未被会话触及的文件，也不做文件内容检索。
3. 全局结果有数量上限（30/12/8），超出会标记 `truncated` 但不提供翻页。
4. 历史只保存查询词，最多 8 条，不存结果。
5. 跳转依赖 Chat 节点文本；若目标消息已被折叠分组隐藏，会退化为「滚到消息 + 描边」。
6. 筛选只减少匹配与序列化的工作量，不减少会话日志的读取；日期按本机时区的日历日计算。
7. 日期范围为「轮次时间」，不是「会话创建时间」：创建于很久以前、今天仍在继续的会话，其近期轮次依然可被检索。
