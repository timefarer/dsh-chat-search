window.__ModuleLoader__.load({
  id: 'dsh-chat-search',
  factory(require) {
    'use strict'

    const ReactNS = require('react')
    const React = ReactNS && ReactNS.createElement !== undefined ? ReactNS : ReactNS.default
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'conversationSearch'
    /** The tab type's implementation id: also the key its body and chip register under. */
    const TAB_ID = 'dsh-chat-search/tab'
    /** The tab kind the header button opens through the right-sidebar controller. */
    const TAB_KIND = 'conversation-search'
    /** Custom Highlight name for the arrival marker. */
    const HIGHLIGHT = 'dsh-chat-search'
    /** Custom Highlight name for the paragraph the jump landed on (a different colour from HIGHLIGHT). */
    const SELECTED = 'dsh-chat-search-selected'
    /** How much of a paragraph's text identifies it, matching the Host's ANCHOR_CHARS. */
    const PARAGRAPH_ANCHOR_CHARS = 80
    /** Shown in the UI so a stale client module is visible at a glance; test/build asserts it. */
    const BUILD = 'v1.2.4'

    /** Diagnostics are off unless the reader opts in from DevTools. */
    function debugEnabled() {
      return globalThis.__dshChatSearchDebug === true
    }

    function debugLog(message, detail) {
      if (!debugEnabled()) return
      if (typeof console === 'undefined' || typeof console.debug !== 'function') return
      console.debug(`[dsh-chat-search] ${message}`, detail)
    }

    /**
     * Dev-only probe, so a report can say what the browser actually sees instead of guessing:
     * `__dshChatSearchProbe()` in DevTools returns the build, whether this build's CSS is loaded,
     * and what (if anything) carries the paragraph marker right now.
     */
    function installProbe() {
      if (typeof window === 'undefined') return
      window.__dshChatSearchProbe = () => {
        let pickedRuleLoaded = false
        try {
          const sheets = document.styleSheets || []
          for (let index = 0; index < sheets.length; index += 1) {
            const rules = sheets[index].cssRules || []
            for (let rule = 0; rule < rules.length; rule += 1) {
              if (String(rules[rule].selectorText || '').indexOf('--picked') >= 0) pickedRuleLoaded = true
            }
          }
        } catch (error) {
          /* A cross-origin sheet cannot be read; the flag stays false and says so. */
        }
        return {
          build: BUILD,
          pickedRuleLoaded,
          /* Which marker path is live right now, so a lag report can be answered without guessing. */
          nativeHighlight: typeof CSS !== 'undefined' && CSS !== null && Boolean(CSS.highlights),
          overlayBoxes: highlightBoxes.length,
          jumpMs: jumpTiming.lastMs,
          rail: railElement === null ? null : {
            display: getComputedStyle(railElement).display,
            top: getComputedStyle(railElement).top,
            height: getComputedStyle(railElement).height,
            visibility: getComputedStyle(railElement).visibility,
          },
        }
      }
    }
    /** Any deliberate scroll after a jump cancels the landing replays. */
    function registerUserScrollWatch() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
      const mark = () => {
        userScrolledSinceJump = true
      }
      const events = ['wheel', 'touchmove', 'keydown']
      for (const name of events) window.addEventListener(name, mark, { capture: true, passive: true })
      return () => {
        for (const name of events) window.removeEventListener(name, mark, true)
      }
    }

    /** Result and highlight budgets keep one search bounded on a very long log. */
    const MAX_RESULTS = 200
    const MAX_WORD_HITS = 60
    /** Tool-argument keys that name a file; `name` stays out because tools use it for labels. */
    const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'target', 'filename']
    const NAME_KEYS = ['title', 'name', 'filename', 'file_name', 'path']
    const MAX_FILES = 6
    const SEARCH_DEBOUNCE_MS = 140
    const LOAD_PAGE_DELAY_MS = 120
    const MAX_PAGE_REQUESTS = 400
    /** The left rail's global-search panel id: also the `main` key it renders under. */
    const PANEL_ID = 'global-search'
    /** The Host route the global page posts to. */
    const GLOBAL_ROUTE = 'conversation-search/api'
    /** How long typing waits before a global request goes out. */
    const GLOBAL_DEBOUNCE_MS = 320
    /** The jump indicator never outlives a stalled jump. */
    const OPENING_TIMEOUT_MS = 20_000
    /** The five search depths, outermost first. */
    const SCOPES = [
      { id: 'all', label: 'global.scope.all' },
      { id: 'session-question', label: 'global.scope.sessionQuestion' },
      { id: 'session', label: 'global.scope.session' },
      { id: 'question', label: 'global.scope.question' },
      { id: 'paragraph', label: 'global.scope.paragraph' },
    ]

    const zh = {
      'meta.title': '对话检索',
      'tab.title': '对话检索',
      'action.open': '检索当前对话',
      'placeholder': '输入关键词，检索本对话全部消息',
      'hint.title': '检索当前对话',
      'hint.body': '输入关键词后，结果会按「提问 → 段落」归类；点击任意结果即可跳到对话中的对应位置。多个关键词用空格分隔，需同时出现。',
      'empty.title': '没有匹配的内容',
      'empty.body': '换个关键词，或加载更早的历史后再试一次。',
      'group.turn': '第 {turn} 轮',
      'group.noQuestion': '（无提问文本）',
      'role.user': '提问',
      'role.assistant': '回复',
      'para.index': '第 {index} 段',
      'summary': '{turns} 组 · {matches} 条结果',
      'truncated': '结果较多，仅显示前 {count} 条',
      'history.missing': '更早的历史尚未加载，检索可能不完整',
      'history.load': '加载全部',
      'history.loading': '加载中…',
      'history.failed': '无法自动加载更早的历史',
      'jump.missing': '该内容尚未加载，请先加载全部历史',
      'clear': '清空',
      'panel.scope.label': '检索范围',
      'panel.scope.all': '全部',
      'panel.scope.question': '仅问题',
      'panel.scope.paragraph': '仅段落',
      'global.title': '全局搜索',
      'global.placeholder': '搜索所有会话，多个关键词用空格分隔',
      'global.subtitle': '在所有会话的标题、问题与段落中检索。结果按 会话 → 问题 → 段落 展开，点击即可打开会话并定位到对应位置。',
      'global.scope.label': '检索范围',
      'global.scope.all': '会话 + 问题 + 段落',
      'global.scope.sessionQuestion': '会话 + 问题',
      'global.scope.session': '仅会话',
      'global.scope.question': '仅问题',
      'global.scope.paragraph': '仅段落',
      'global.scopeHint.all': '会话标题、问题、段落任一命中',
      'global.scopeHint.sessionQuestion': '只匹配会话标题与问题文本',
      'global.scopeHint.session': '只匹配会话标题',
      'global.scopeHint.question': '只匹配提问文本',
      'global.scopeHint.paragraph': '只匹配回复段落',
      'global.search': '搜索',
      'global.idle': '输入关键词开始全局检索',
      'global.loading': '检索中…',
      'global.empty': '没有匹配的内容',
      'global.emptyBody': '换个关键词，或放宽日期/轮次筛选。',
      'global.error': '检索失败',
      'global.retry': '重试',
      'global.stats': '{sessions} 个会话 · {questions} 个问题 · {paragraphs} 个段落 · {ms}ms',
      'global.indexed': '已索引 {count} 个会话',
      'global.truncated': '结果较多，仅显示前 {count} 个会话',
      'global.untitled': '（无标题会话）',
      'global.session.matched': '标题命中',
      'global.session.counts': '{questions} 问 · {paragraphs} 段',
      'global.session.open': '打开会话',
      'global.question.label': '第 {number} 轮',
      'global.question.matched': '问题命中',
      'global.question.empty': '（无提问文本）',
      'global.paragraph.label': '第 {index} 段',
      'global.paragraph.hits': '{count} 处',
      'global.paragraph.more': '还有 {count} 段未显示',
      'global.file.input': '输入',
      'global.file.output': '输出',
      'global.jumpFailed': '该段落暂未加载，请打开会话后再定位',
      'global.resultCount': '{count} 处命中',
      'global.question.jump': '跳到该问题',
      'open': '打开',
      'expandAll': '全部展开',
      'collapseAll': '全部收起',
      'expand': '展开',
      'collapse': '收起',
      'panel.enter': '回车跳到第一条',
      'opening.title': '正在打开会话…',
      'opening.tip': '历史较长时需要一点时间',
      'jump.title': '正在跳到第 {turn} 轮…',
      'jump.hint': '正在定位并高亮命中内容',
      'global.legend': '▾ 展开 / 收起 　 ↗ 点击跳到该段落并高亮',
      'global.refreshing': '正在重建索引…',
      'jump.label': '跳转',
      'jump.paraHint': '跳到这一段并高亮命中内容',
      'file.only': '文件',
      'global.refresh': '刷新索引',
      'global.widen': '在全部范围中搜索',
      'global.recent': '最近搜索',
      'global.firstIndex': '首次检索需要建立索引，可能稍慢',
      'command.find': '在对话中查找',
      'command.global': '全局搜索（所有会话）',
      'filters.label': '筛选',
      'filters.since': '开始',
      'filters.until': '结束',
      'filters.turns': '最近轮次',
      'filters.unlimited': '不限',
      'filters.reset': '重置',
      'filters.summary.range': '{since} ~ {until}',
      'filters.summary.turns': '最近 {count} 轮',
      'filters.summary.all': '全部范围',
    }

    const en = {
      'meta.title': 'Conversation search',
      'tab.title': 'Search',
      'action.open': 'Search this conversation',
      'placeholder': 'Type keywords to search every message',
      'hint.title': 'Search this conversation',
      'hint.body': 'Results are grouped by question and paragraph. Click a result to jump to that spot. Separate several keywords with spaces; all of them must appear.',
      'empty.title': 'No matches',
      'empty.body': 'Try another keyword, or load older history first.',
      'group.turn': 'Turn {turn}',
      'group.noQuestion': '(no question text)',
      'role.user': 'You',
      'role.assistant': 'Reply',
      'para.index': 'Paragraph {index}',
      'summary': '{turns} groups · {matches} matches',
      'truncated': 'Showing the first {count} matches',
      'history.missing': 'Older history is not loaded, so results may be incomplete',
      'history.load': 'Load all',
      'history.loading': 'Loading…',
      'history.failed': 'Could not load older history',
      'jump.missing': 'That message is not loaded yet; load all history first',
      'clear': 'Clear',
      'panel.scope.label': 'Search in',
      'panel.scope.all': 'All',
      'panel.scope.question': 'Questions',
      'panel.scope.paragraph': 'Replies',
      'global.title': 'Global search',
      'global.placeholder': 'Search every session; separate keywords with spaces',
      'global.subtitle': 'Search session titles, questions, and reply paragraphs across every Session. Results expand as session → question → paragraph; a click opens the Session at that spot.',
      'global.scope.label': 'Scope',
      'global.scope.all': 'Session + question + paragraph',
      'global.scope.sessionQuestion': 'Session + question',
      'global.scope.session': 'Session only',
      'global.scope.question': 'Question only',
      'global.scope.paragraph': 'Paragraph only',
      'global.scopeHint.all': 'any of the session title, question, or paragraph matches',
      'global.scopeHint.sessionQuestion': 'only session titles and question text are matched',
      'global.scopeHint.session': 'only session titles are matched',
      'global.scopeHint.question': 'only question text is matched',
      'global.scopeHint.paragraph': 'only reply paragraphs are matched',
      'global.search': 'Search',
      'global.idle': 'Type keywords to search every session',
      'global.loading': 'Searching…',
      'global.empty': 'No matches',
      'global.emptyBody': 'Try another keyword, or widen the date/turn filter.',
      'global.error': 'Search failed',
      'global.retry': 'Retry',
      'global.stats': '{sessions} sessions · {questions} questions · {paragraphs} paragraphs · {ms}ms',
      'global.indexed': '{count} sessions indexed',
      'global.truncated': 'Showing the first {count} sessions',
      'global.untitled': '(untitled session)',
      'global.session.matched': 'title match',
      'global.session.counts': '{questions} q · {paragraphs} p',
      'global.session.open': 'Open',
      'global.question.label': 'Turn {number}',
      'global.question.matched': 'question match',
      'global.question.empty': '(no question text)',
      'global.paragraph.label': 'Paragraph {index}',
      'global.paragraph.hits': '{count} hits',
      'global.paragraph.more': '{count} more paragraphs not shown',
      'global.file.input': 'in',
      'global.file.output': 'out',
      'global.jumpFailed': 'That paragraph is not loaded yet; open the session and try again',
      'global.resultCount': '{count} hits',
      'global.question.jump': 'Jump to this question',
      'open': 'Open',
      'expandAll': 'Expand all',
      'collapseAll': 'Collapse all',
      'expand': 'Expand',
      'collapse': 'Collapse',
      'panel.enter': 'Enter jumps to the first result',
      'opening.title': 'Opening session…',
      'opening.tip': 'Longer histories take a moment',
      'jump.title': 'Jumping to turn {turn}…',
      'jump.hint': 'Locating and highlighting the match',
      'global.legend': '▾ Expand / collapse 　 ↗ Click a paragraph to jump and highlight',
      'global.refreshing': 'Rebuilding the index…',
      'jump.label': 'Jump',
      'jump.paraHint': 'Jump to this paragraph and highlight the match',
      'file.only': 'File',
      'global.refresh': 'Refresh index',
      'global.widen': 'Search all scopes',
      'global.recent': 'Recent',
      'global.firstIndex': 'The first search builds the index, so it may take a moment',
      'command.find': 'Find in conversation',
      'command.global': 'Global search (all sessions)',
      'filters.label': 'Filter',
      'filters.since': 'From',
      'filters.until': 'To',
      'filters.turns': 'Last turns',
      'filters.unlimited': 'Unlimited',
      'filters.reset': 'Reset',
      'filters.summary.range': '{since} ~ {until}',
      'filters.summary.turns': 'last {count} turns',
      'filters.summary.all': 'All',
    }

    const CSS = [
      '.dsh-csearch-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.dsh-csearch-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-csearch-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-csearch-btn svg{width:16px;height:16px}',
      '.dsh-csearch-title{display:inline-flex;align-items:center;gap:5px;min-width:0}',
      '.dsh-csearch-title svg{width:13px;height:13px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsh-csearch-root{display:flex;flex-direction:column;min-height:0;height:100%;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}',
      '.dsh-csearch-head{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px 12px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-csearch-field{display:flex;align-items:center;gap:6px;height:32px;padding:0 6px 0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-csearch-field:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-csearch-field>svg{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsh-csearch-input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size,14px)}',
      '.dsh-csearch-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-csearch-clear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.dsh-csearch-clear:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsh-csearch-clear svg{width:11px;height:11px}',
      '.dsh-csearch-banner{display:flex;align-items:center;gap:8px;padding:6px 8px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);line-height:1.45}',
      '.dsh-csearch-banner button{margin-left:auto;flex:none;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-csearch-banner button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-csearch-banner button:disabled{opacity:.55;cursor:default}',
      '.dsh-csearch-error{color:var(--dsw-alias-state-error-primary);line-height:1.45}',
      '.dsh-csearch-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 8px 16px;scrollbar-gutter:stable}',
      '.dsh-csearch-hint{display:flex;flex-direction:column;gap:6px;padding:20px 10px;line-height:1.65;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dsh-csearch-hint strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-csearch-empty{padding:22px 10px;line-height:1.65;text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.dsh-csearch-empty strong{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-csearch-group{margin:2px 0 8px}',
      '.dsh-csearch-group-head{display:flex;align-items:baseline;gap:6px;padding:6px 8px;position:sticky;top:0;z-index:1;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}',
      '.dsh-csearch-turn{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;letter-spacing:.02em}',
      '.dsh-csearch-question{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-csearch-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-csearch-meta span+span::before{content:"·";margin-right:6px;opacity:.7}',
      '.dsh-csearch-snippet{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.55}',
      '.dsh-csearch-snippet mark{padding:0 1px;border-radius:2px;background:rgba(255,199,0,.45);color:inherit}',
      '.dsh-csearch-summary{padding:2px 8px 6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-cg-page{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.dsh-cg-head{flex:none;width:100%;max-width:1080px;margin:0 auto;padding:28px 32px 0;box-sizing:border-box}',
      '.dsh-cg-title{margin:0;font-size:calc(var(--dsh-content-font-size,14px) + 7px);font-weight:600;line-height:1.3}',
      '.dsh-cg-sub{margin:8px 0 0;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dsh-cg-bar{flex:none;display:flex;flex-direction:column;gap:10px;width:100%;max-width:1080px;margin:0 auto;padding:16px 32px 12px;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cg-row{display:flex;align-items:center;gap:8px}',
      '.dsh-cg-field{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:38px;padding:0 10px 0 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cg-field:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-field>svg{width:16px;height:16px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cg-clear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.dsh-cg-clear:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsh-cg-clear svg{width:11px;height:11px}',
      '.dsh-cg-input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px)}',
      '.dsh-cg-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-cg-submit{flex:none;height:38px;padding:0 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.dsh-cg-submit:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-submit:disabled{opacity:.5;cursor:default}',
      '.dsh-cg-scopes{display:flex;align-items:center;flex-wrap:wrap;gap:6px}',
      '.dsh-cg-scope-label{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;margin-right:2px}',
      '.dsh-cg-scope{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer}',
      '.dsh-cg-scope:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dsh-cg-scope[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:rgba(74,144,255,.12);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.dsh-cg-body{flex:1;min-height:0;overflow-y:auto;width:100%;max-width:1080px;margin:0 auto;padding:6px 32px 48px;box-sizing:border-box}',
      '.dsh-cg-stats{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 2px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-cg-go{margin-left:auto;opacity:0;font-size:12px;color:var(--dsw-alias-brand-primary);transition:opacity .12s}',
      '.dsh-cg-para:hover .dsh-cg-go,.dsh-cg-para:focus-visible .dsh-cg-go{opacity:1}',
      '.dsh-cg-jump-btn{flex:none;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}',
      '.dsh-cg-jump-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-legend{padding:0 2px 8px;color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.85}',
      '.dsh-cg-spinner-sm{width:11px;height:11px;border-width:1.5px;margin-right:5px;vertical-align:-1px}',
      '.dsh-spin{flex:none;color:var(--dsw-alias-brand-primary);animation:dsh-cg-spin .9s linear infinite}',
      '.dsh-cg-pulse{display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-pill{position:fixed;top:42%;left:50%;transform:translate(-50%,-50%);z-index:2000;display:flex;align-items:center;gap:12px;max-width:min(560px,90vw);padding:12px 18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.2);cursor:progress;pointer-events:none;animation:dsh-cg-mask-in .14s ease-out}',
      '.dsh-cg-tree{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cg-session{border:.5px solid rgba(127,127,127,.28);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}',
      '.dsh-cg-session-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 8px}',
      '.dsh-cg-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-cg-toggle:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cg-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-caret{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-secondary);transition:transform .12s ease}',
      '.dsh-cg-caret-space{flex:none;width:14px;height:14px}',
      '.dsh-cg-caret[data-open="true"]{transform:rotate(90deg)}',
      '.dsh-cg-session-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size,14px);font-weight:600}',
      '.dsh-cg-path{flex:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-cg-badge{flex:none;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;white-space:nowrap}',
      '.dsh-cg-count{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dsh-cg-open{flex:none;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-cg-open:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-questions{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cg-question{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cg-question:first-child{border-top:0}',
      '.dsh-cg-question-head{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 16px}',
      '.dsh-cg-question-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-cg-question-toggle:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cg-question-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-q-label{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;white-space:nowrap}',
      '.dsh-cg-q-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cg-paras{display:flex;flex-direction:column;gap:2px;padding:0 8px 8px 30px}',
      '.dsh-cg-para{display:flex;flex-direction:column;gap:4px;width:100%;padding:8px 10px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-cg-para:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cg-para:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-para-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-cg-snippet{line-height:1.6;overflow-wrap:anywhere}',
      '.dsh-cg-snippet mark{padding:0 1px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);color:inherit}',
      '.dsh-cg-files{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh-cg-file{max-width:220px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-cg-file[data-kind="in"]{border-style:dashed}',
      '.dsh-cg-state{padding:48px 12px;text-align:center;color:var(--dsw-alias-label-secondary);line-height:1.7}',
      /* The loading row keeps the spinner and its label on one optical line. */
      '.dsh-cg-state--row{display:flex;align-items:center;justify-content:center;gap:8px;line-height:1}',
      '.dsh-cg-state strong{display:block;margin-bottom:6px;color:var(--dsw-alias-label-primary);font-weight:600;font-size:var(--dsh-content-font-size,14px)}',
      '.dsh-cg-error-text{display:block;margin:4px 0 12px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
    ].join('\n')

    /** Result-tree rules, loaded after the base sheet so they refine the older boxes. */
    const CSS_RESULTS = [
      '.dsh-cg-stats{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 2px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-cg-stats-text{white-space:nowrap}',
      '.dsh-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-filter-title{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-filter-body{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-filter-field{display:flex;align-items:center;gap:4px}',
      '.dsh-filter-label{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-filter-input{height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dsh-filter-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.dsh-filter-number{width:64px}',
      '.dsh-filter-dash{color:var(--dsw-alias-label-secondary)}',
      '.dsh-filter-reset{height:26px;padding:0 8px;border:.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-filter-reset:hover{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.dsh-filters-compact{flex-direction:column;align-items:stretch;gap:6px}',
      '.dsh-filter-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.dsh-filter-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-filter-toggle svg{flex:none;width:12px;height:12px}',
      '.dsh-filter-toggle-label{flex:none}',
      '.dsh-filter-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
      '.dsh-csearch-scopes{display:flex;align-items:center;gap:4px;padding:0 2px}',
      '.dsh-csearch-scope{height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}',
      '.dsh-csearch-scope[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:rgba(74,144,255,.12)}',
      '.dsh-cg-stats-actions{display:flex;gap:4px;margin-left:auto}',
      '.dsh-cg-link{padding:3px 8px;border:.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-cg-link:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-cg-tree{display:flex;flex-direction:column;gap:10px}',
      '.dsh-cg-tree[data-loading="true"]{opacity:.55}',
      '.dsh-cg-session{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dsh-cg-session[data-open="true"]{border-color:var(--dsw-alias-border-l2)}',
      '.dsh-cg-session-top{display:flex;align-items:center;gap:8px;padding:9px 10px 0}',
      '.dsh-cg-toggle{display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:3px 4px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-cg-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-session-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;line-height:1.45}',
      '.dsh-cg-session-sub{display:flex;align-items:center;gap:7px;padding:3px 12px 9px 35px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4}',
      '.dsh-cg-dot{flex:none;width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.6}',
      '.dsh-cg-path{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-cg-hits{flex:none;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dsh-cg-open{flex:none;height:26px;padding:0 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-cg-open:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-questions{margin:0 8px 6px 20px;padding-left:12px;border-left:1.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cg-question{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cg-question:first-child{border-top:0}',
      '.dsh-cg-question-row{display:flex;align-items:center;gap:8px;margin:3px 0;padding:3px 5px;border-radius:9px;background:rgba(127,127,127,.12)}',
      '.dsh-cg-question-toggle{display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-cg-question-toggle:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cg-question-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-q-tag{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;white-space:nowrap}',
      '.dsh-cg-q-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.5}',
      '.dsh-cg-paras{display:flex;flex-direction:column;gap:4px;padding:0 6px 8px}',
      '.dsh-cg-para{display:flex;flex-direction:column;gap:5px;width:100%;padding:8px 10px;border:.5px solid rgba(127,127,127,.28);border-radius:10px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dsh-cg-para:hover{border-color:var(--dsw-alias-brand-primary);background:rgba(74,144,255,.10);box-shadow:0 1px 6px rgba(0,0,0,.06)}',
      '.dsh-cg-para--picked{border-color:var(--dsw-alias-brand-primary);background:rgba(74,144,255,.14);box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary)}',
      '.dsh-cg-para--picked:hover{background:rgba(74,144,255,.2)}',
      '.dsh-cg-para:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cg-para-meta{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-cg-para-hits{padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dsh-cg-snippet{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.65;overflow-wrap:anywhere}',
      '.dsh-cg-files{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh-cg-page mark{padding:0 1px;border-radius:2px;background:rgba(255,199,0,.45);color:inherit}',
      '.dsh-cg-build{margin-left:8px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;vertical-align:middle}',
      '.dsh-csearch-build{margin-top:6px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;align-self:center}',
      '.dsh-cg-recent{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;margin-top:12px}',
      '.dsh-cg-recent-label{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-cg-recent-item{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-cg-recent-item:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-csearch-files{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh-csearch-file{max-width:100%;padding:1px 7px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '::highlight(dsh-chat-search){background-color:rgba(255,199,0,.5);color:inherit}',
      '.dsh-csearch-rail{position:fixed;width:3px;border-radius:2px;background:rgba(74,144,255,.7);box-shadow:0 0 6px rgba(74,144,255,.45);pointer-events:none;z-index:60}',
      '.dsh-csearch-highlight-layer{position:fixed;inset:0;z-index:900;pointer-events:none;overflow:hidden}',
      '.dsh-csearch-highlight{position:absolute;border-radius:2px;background:rgba(255,199,0,.5)}',
      '.dsh-csearch-results{display:flex;flex-direction:column;gap:2px}',
      '.dsh-csearch-results[data-loading="true"]{opacity:.6}',
      '.dsh-csearch-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px 8px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-csearch-enter{opacity:.75}',
      '.dsh-csearch-group{margin:0 0 8px;padding-left:9px;border-left:1.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-csearch-group-head{display:flex;align-items:baseline;gap:6px;padding:5px 4px;position:sticky;top:0;z-index:1;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}',
      '.dsh-csearch-turn{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;letter-spacing:.02em}',
      '.dsh-csearch-question{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-csearch-item{display:flex;flex-direction:column;gap:4px;width:100%;margin:0 0 2px;padding:7px 8px;border:.5px solid transparent;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dsh-csearch-item:hover{background:rgba(74,144,255,.08);border-color:var(--dsw-alias-brand-primary)}',
      /* Both lists use the same blue for "this is the row you opened last". */
      '.dsh-csearch-item--picked{background:rgba(74,144,255,.14);border-color:var(--dsw-alias-brand-primary);box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary)}',
      /* Hovering the picked row must not wipe its marker: it is the same row, slightly stronger. */
      '.dsh-csearch-item--picked:hover{background:rgba(74,144,255,.2);border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-csearch-go{margin-left:auto;opacity:0;color:var(--dsw-alias-brand-primary);font-size:11px;transition:opacity .12s}',
      '.dsh-csearch-item:hover .dsh-csearch-go,.dsh-csearch-item:focus-visible .dsh-csearch-go{opacity:1}',
      '.dsh-csearch-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-csearch-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-csearch-hits{padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dsh-csearch-snippet{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.6;font-size:13px}',
      '.dsh-csearch-group mark,.dsh-csearch-snippet mark{padding:0 1px;border-radius:2px;background:rgba(255,199,0,.45);color:inherit}',
      /* The jump indicator: centred and non-blocking, so a click is always acknowledged. */
      '.dsh-cg-jump{position:fixed;top:42%;left:50%;transform:translate(-50%,-50%);z-index:2000;display:flex;align-items:center;gap:12px;max-width:min(560px,90vw);padding:12px 18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.2);cursor:progress;pointer-events:none;animation:dsh-cg-mask-in .14s ease-out}',
      '.dsh-cg-mask-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-cg-mask-text strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-cg-mask-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '@keyframes dsh-cg-spin{to{transform:rotate(360deg)}}',
      '@keyframes dsh-cg-mask-in{from{opacity:0}to{opacity:1}}',
    ].join('\n')

    const EMPTY_RESULTS = { groups: [], matches: 0, truncated: false }

    // #region Module state: per-session query and the "focus the box" handshake

    /** Last query per Session, so closing and reopening the panel keeps the search. */
    const queries = new Map()
    /** Sessions whose panel should focus its input as soon as it is on screen. */
    const focusPending = new Set()
    const focusListeners = new Set()

    function storedQuery(sessionId) {
      return queries.get(sessionId) || ''
    }

    function storeQuery(sessionId, query) {
      if (query === '') queries.delete(sessionId)
      else queries.set(sessionId, query)
    }

    function takePendingFocus(sessionId) {
      return focusPending.delete(sessionId)
    }

    function requestFocus(sessionId) {
      focusPending.add(sessionId)
      for (const listener of focusListeners) {
        try {
          listener(sessionId)
        } catch (error) {
          console.error('[conversation-search] focus listener failed', error)
        }
      }
    }

    function onFocusRequest(listener) {
      focusListeners.add(listener)
      return () => focusListeners.delete(listener)
    }

    /** Mirrored searches: a global jump asks the in-conversation panel to run the same query. */
    const panelSearches = new Map()
    const panelSearchListeners = new Set()

    function requestPanelSearch(sessionId, query, scope, filters, anchor) {
      if (typeof query !== 'string' || query.trim() === '') return
      panelSearches.set(sessionId, {
        query,
        scope: typeof scope === 'string' ? scope : 'all',
        filters: filters === undefined || filters === null ? null : normalizeFilters(filters),
        /* The paragraph the jump landed on: the panel marks that row, so both lists agree. */
        anchor: typeof anchor === 'string' ? anchor : '',
      })
      for (const listener of panelSearchListeners) {
        try {
          listener(sessionId)
        } catch (error) {
          console.error('[conversation-search] panel search listener failed', error)
        }
      }
    }

    function takePanelSearch(sessionId) {
      const request = panelSearches.get(sessionId)
      panelSearches.delete(sessionId)
      return request
    }

    function onPanelSearchRequest(listener) {
      panelSearchListeners.add(listener)
      return () => panelSearchListeners.delete(listener)
    }

    /** Map the page's five scopes onto the panel's three; session titles stay page-only. */
    function panelScopeOf(scope) {
      if (scope === 'question') return 'question'
      if (scope === 'paragraph') return 'paragraph'
      return 'all'
    }

    /** What the global page shows when the reader comes back to it. */
    const globalMemory = { query: '', scope: 'all', result: null, status: 'idle', error: '', picked: '' }

    /** Recent global queries, newest first; page memory only, never persisted. */
    const recentQueries = []
    /** The Host index is warmed once per page load, not on every visit to the page. */
    let warmStarted = false

    function recordRecent(query) {
      const index = recentQueries.indexOf(query)
      if (index >= 0) recentQueries.splice(index, 1)
      recentQueries.unshift(query)
      if (recentQueries.length > 6) recentQueries.length = 6
    }

    /** Jumps waiting for their Session to finish loading, keyed by Session id. */
    const pendingJumps = new Map()
    /** Click-to-landing clock: `requestedAt` when a jump starts, `lastMs` once it lands. */
    const jumpTiming = { requestedAt: 0, lastMs: 0 }
    /** Readers currently showing a Session that may be asked to jump next. */
    const jumpListeners = new Set()

    /** The frame-wide "opening a Session" transition, shared by the page and the jump pill. */
    const openingState = { active: false, sessionId: '', title: '', kind: '', turn: null, token: 0, timer: null }
    const openingListeners = new Set()

    function openingSnapshot() {
      return {
        active: openingState.active,
        token: openingState.token,
        title: openingState.title,
        kind: openingState.kind,
        turn: openingState.turn,
      }
    }

    function publishOpening() {
      const snapshot = openingSnapshot()
      for (const listener of openingListeners) {
        try {
          listener(snapshot)
        } catch (error) {
          console.error('[conversation-search] opening listener failed', error)
        }
      }
    }

    function onOpeningChange(listener) {
      openingListeners.add(listener)
      return () => openingListeners.delete(listener)
    }

    /** Announce one Session open (or one jump inside it) to the frame-wide indicator. */
    function beginOpening(sessionId, title, target) {
      if (openingState.timer !== null) clearTimeout(openingState.timer)
      /* A new jump replaces whatever marker the last one left on screen. */
      clearHighlight()
      openingState.active = true
      openingState.sessionId = sessionId
      openingState.title = typeof title === 'string' ? title : ''
      openingState.kind = target !== null && target !== undefined && typeof target.kind === 'string' ? target.kind : ''
      openingState.turn = target !== null && target !== undefined && typeof target.turn === 'number' ? target.turn : null
      openingState.token += 1
      openingState.timer = setTimeout(() => {
        openingState.timer = null
        endOpening()
      }, OPENING_TIMEOUT_MS)
      publishOpening()
    }

    function endOpening() {
      if (openingState.timer !== null) {
        clearTimeout(openingState.timer)
        openingState.timer = null
      }
      if (!openingState.active) return
      openingState.active = false
      openingState.sessionId = ''
      openingState.kind = ''
      openingState.turn = null
      publishOpening()
    }

    function isOpening(sessionId) {
      return openingState.active && openingState.sessionId === sessionId
    }

    // #endregion

    // #region Conversation text: reading messages, splitting paragraphs, matching

    /** Segmented paragraph cache: a Chat node object is immutable, so its split is reused. */
    const paragraphCache = new WeakMap()

    /** The turn number a Chat node belongs to, or null for nodes outside a Turn. */
    function turnOf(node) {
      const location = node && node.location
      if (!location || typeof location !== 'object') return null
      if (location.kind !== 'turn' && location.kind !== 'step') return null
      const turn = location.turn && location.turn.turn
      return typeof turn === 'number' ? turn : null
    }

    /** Whether a Chat node is a message this panel searches, and as which side of the exchange. */
    function roleOf(node) {
      if (!node || typeof node !== 'object') return null
      if (node.kind === 'user') return 'user'
      if (node.kind === 'assistant-step') return 'assistant'
      return null
    }

    /** The start time of the Turn a Chat node belongs to, or null when the node has none. */
    function nodeTimeOf(node) {
      const location = node && node.location
      if (!location || typeof location !== 'object') return null
      if (location.kind !== 'turn' && location.kind !== 'step') return null
      const turn = location.turn
      if (!turn || typeof turn !== 'object') return null
      const start = turn.start && turn.start.time
      if (typeof start === 'number') return start
      const end = turn.end && turn.end.time
      return typeof end === 'number' ? end : null
    }

    // #region Filters

    function localDateValue(date) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }

    /** The default window: the last two weeks, the last thirty turns, and it follows today. */
    function defaultFilters() {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13)
      return { since: localDateValue(start), until: localDateValue(now), turns: 30, rolling: true, savedOn: localDateValue(now) }
    }

    function filterDay(value) {
      const parts = String(value).split('-').map(Number)
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
      const date = new Date(parts[0], parts[1] - 1, parts[2])
      return Number.isNaN(date.getTime()) ? null : date
    }

    function filterShift(value, days) {
      const date = filterDay(value)
      if (date === null) return value
      return localDateValue(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))
    }

    /** Move a window that is still the untouched default up to today; custom ranges never move. */
    function rollFilters(filters) {
      if (filters.rolling !== true) return filters
      const today = localDateValue(new Date())
      const savedOn = filters.savedOn === '' ? today : filters.savedOn
      if (savedOn >= today) return { ...filters, savedOn: today }
      const from = filterDay(savedOn)
      const to = filterDay(today)
      const delta = from === null || to === null ? 0 : Math.round((to.getTime() - from.getTime()) / 86_400_000)
      if (delta <= 0) return { ...filters, savedOn: today }
      return {
        since: filters.since === '' ? '' : filterShift(filters.since, delta),
        until: filters.until === '' ? '' : filterShift(filters.until, delta),
        turns: filters.turns,
        rolling: true,
        savedOn: today,
      }
    }

    /** Clamp one filter value; missing means "defaults", an explicit object means exactly itself. */
    function normalizeFilters(input) {
      if (input === null || input === undefined || typeof input !== 'object') return defaultFilters()
      let since = typeof input.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.since) ? input.since : ''
      let until = typeof input.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.until) ? input.until : ''
      if (since !== '' && until !== '' && since > until) {
        const swap = since
        since = until
        until = swap
      }
      const raw = typeof input.turns === 'number' ? input.turns : Number(input.turns)
      const turns = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5000) : 0
      let rolling = input.rolling === true
      let savedOn = typeof input.savedOn === 'string' ? input.savedOn : ''
      /* Legacy host record: a default-shaped window ending in the past was the rolling default. */
      if (typeof input.rolling !== 'boolean' && savedOn === '') {
        const from = since === '' ? null : filterDay(since)
        const to = until === '' ? null : filterDay(until)
        const span = from === null || to === null ? 0 : Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
        if (until !== '' && span === 14 && until < localDateValue(new Date())) {
          rolling = true
          savedOn = until
        }
      }
      return rollFilters({ since, until, turns, rolling, savedOn })
    }

    function dayStart(value) {
      if (value === '') return null
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day, 0, 0, 0, 0)
      return Number.isNaN(date.getTime()) ? null : date.getTime()
    }

    function dayEnd(value) {
      if (value === '') return null
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day, 23, 59, 59, 999)
      return Number.isNaN(date.getTime()) ? null : date.getTime()
    }

    /** Whether one Turn's time falls inside the filter's date window. */
    function inWindow(time, since, until) {
      if (since === null && until === null) return true
      if (typeof time !== 'number' || time <= 0) return false
      if (since !== null && time < since) return false
      if (until !== null && time > until) return false
      return true
    }

    function shortDate(value) {
      return value.length === 10 ? value.slice(5) : value
    }

    /** Whether two windows are the same, so an unchanged load never re-runs a search. */
    function sameFilters(a, b) {
      return a.since === b.since && a.until === b.until && a.turns === b.turns
    }

    /** One-line description of the active window, shown next to both filter panels. */
    function filtersSummary(t, filters) {
      const parts = []
      if (filters.since !== '' || filters.until !== '') {
        parts.push(
          t('filters.summary.range', {
            since: filters.since === '' ? t('filters.unlimited') : shortDate(filters.since),
            until: filters.until === '' ? t('filters.unlimited') : shortDate(filters.until),
          }),
        )
      }
      if (filters.turns > 0) parts.push(t('filters.summary.turns', { count: filters.turns }))
      return parts.length === 0 ? t('filters.summary.all') : parts.join(' · ')
    }

    // #endregion

    /**
     * The searchable parts of one message.
     *
     * A user message carries `data.content` blocks typed `text`; an assistant step carries
     * `data.blocks` block kinds `text`. Text blocks are joined by a blank line so each block is a
     * paragraph of its own; reasoning blocks are skipped, and file names come from user
     * attachments and from Tool-call path arguments.
     */
    function textOfNode(node, role) {
      const data = node && node.data
      if (!data || typeof data !== 'object') return { text: '', files: [] }
      const blocks = role === 'user' ? data.content : data.blocks
      if (!Array.isArray(blocks)) return { text: '', files: [] }
      let out = ''
      const files = []
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        const isText = role === 'user' ? block.type === 'text' : block.kind === 'text'
        if (isText && typeof block.text === 'string') {
          const text = block.text.trim()
          if (text !== '') out = out === '' ? text : out + '\n\n' + text
          continue
        }
        if (role === 'assistant' && block.kind === 'tool-call') {
          const args = parseArguments(block.argsRaw)
          if (args !== undefined) {
            for (const name of pathsInArgs(args)) pushUnique(files, name, MAX_FILES)
            for (const name of patchPaths(args)) pushUnique(files, name, MAX_FILES)
          }
          continue
        }
        if (role === 'user') {
          const name = attachmentName(block)
          if (name !== undefined) pushUnique(files, name, 4)
        }
      }
      return { text: out, files }
    }

    /** The display name one user content block or its attachment carries. */
    function attachmentName(block) {
      for (const key of NAME_KEYS) {
        const value = block[key]
        if (typeof value === 'string' && value.trim() !== '') return basename(value) || value.trim()
      }
      const attachment = block.attachment
      if (attachment !== null && typeof attachment === 'object') {
        for (const key of NAME_KEYS) {
          const value = attachment[key]
          if (typeof value === 'string' && value.trim() !== '') return basename(value) || value.trim()
        }
      }
      return undefined
    }

    /** Parse one Tool call's raw arguments. */
    function parseArguments(raw) {
      if (raw !== null && typeof raw === 'object') return raw
      if (typeof raw !== 'string' || raw.trim() === '') return undefined
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch (error) {
        return undefined
      }
    }

    function looksLikePath(value) {
      const text = String(value).trim()
      if (text === '' || text.length > 160) return false
      if (/[\r\n]/.test(text)) return false
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
      if (/\s/.test(text)) return false
      return text.includes('/') || text.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(text)
    }

    function basename(value) {
      const text = String(value).replace(/\\/g, '/')
      const name = text.slice(text.lastIndexOf('/') + 1).trim()
      if (name === '' || name.length > 120 || /[\r\n]/.test(name)) return ''
      return name
    }

    function pathsInArgs(args) {
      const out = []
      for (const key of PATH_KEYS) {
        const value = args[key]
        if (typeof value === 'string' && value !== '') out.push(value)
      }
      for (const key of ['files', 'paths']) {
        const value = args[key]
        if (!Array.isArray(value)) continue
        for (const item of value) {
          if (typeof item === 'string') out.push(item)
          else if (item !== null && typeof item === 'object') {
            for (const pathKey of PATH_KEYS) {
              if (typeof item[pathKey] === 'string' && item[pathKey] !== '') out.push(item[pathKey])
            }
          }
        }
      }
      return out.filter(looksLikePath).map(basename).filter((name) => name !== '')
    }

    function patchPaths(args) {
      const out = []
      for (const key of ['patch', 'input', 'diff', 'text']) {
        const value = args[key]
        if (typeof value !== 'string') continue
        for (const line of value.split('\n')) {
          const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())
          if (match !== null) out.push(match[1].trim())
        }
      }
      return out.filter(looksLikePath).map(basename).filter((name) => name !== '')
    }

    function pushUnique(list, value, cap) {
      if (list.length >= cap || list.includes(value)) return
      list.push(value)
    }

    /** A message split into display paragraphs: blank lines separate, runs of whitespace collapse. */
    function splitParagraphs(text) {
      const parts = text.split(/\n\s*\n/)
      const out = []
      for (const part of parts) {
        const normalized = part.replace(/\s+/g, ' ').trim()
        if (normalized !== '') out.push(normalized)
      }
      return out
    }

    function paragraphsOf(node, text) {
      const cached = paragraphCache.get(node)
      if (cached !== undefined && cached.text === text) return cached.paragraphs
      const paragraphs = splitParagraphs(text)
      paragraphCache.set(node, { text, paragraphs })
      return paragraphs
    }

    /** Keywords: whitespace separated, lowercased, capped. */
    function normalizeWords(query) {
      return String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== '')
        .slice(0, 6)
    }

    function containsAll(text, words) {
      const lower = text.toLowerCase()
      for (const word of words) {
        if (lower.indexOf(word) < 0) return false
      }
      return true
    }

    function countHits(text, words) {
      const lower = text.toLowerCase()
      let total = 0
      for (const word of words) {
        let from = 0
        while (total < MAX_WORD_HITS) {
          const at = lower.indexOf(word, from)
          if (at < 0) break
          total += 1
          from = at + word.length
        }
      }
      return total
    }

    /** A window of the paragraph around its earliest keyword, with ellipses where it was cut. */
    function snippetOf(text, words) {
      const lower = text.toLowerCase()
      let anchor = -1
      for (const word of words) {
        const at = lower.indexOf(word)
        if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at
      }
      if (anchor < 0) anchor = 0
      const start = Math.max(0, anchor - 30)
      const end = Math.min(text.length, anchor + 130)
      let body = text.slice(start, end)
      if (start > 0) body = '…' + body
      if (end < text.length) body = body + '…'
      return body
    }

    /** Split a snippet into plain runs and highlighted runs, merging overlapping keywords. */
    function segmentsOf(text, words) {
      const lower = text.toLowerCase()
      const ranges = []
      for (const word of words) {
        let from = 0
        while (ranges.length < 200) {
          const at = lower.indexOf(word, from)
          if (at < 0) break
          ranges.push([at, at + word.length])
          from = at + word.length
        }
      }
      if (ranges.length === 0) return [{ text, hit: false }]
      ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1])
      const merged = []
      for (const range of ranges) {
        const last = merged[merged.length - 1]
        if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
        else merged.push([range[0], range[1]])
      }
      const out = []
      let cursor = 0
      for (const [start, end] of merged) {
        if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false })
        out.push({ text: text.slice(start, end), hit: true })
        cursor = end
      }
      if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
      return out
    }

    /** A one-line question preview for a group header. */
    function previewLine(text) {
      const normalized = text.replace(/\s+/g, ' ').trim()
      if (normalized.length <= 90) return normalized
      return normalized.slice(0, 89).trimEnd() + '…'
    }

    /**
     * Search the loaded conversation and group the hits by Turn.
     *
     * Every message of a Turn is split into paragraphs; a paragraph that contains all
     * keywords is one result. The Turn's own question is the group header, so a reader
     * sees "which question does this answer belong to" before the paragraph itself.
     * `filters` narrows the window to the last N Turns and/or a calendar date range; `scope`
     * keeps only questions, only replies, or both (the panel never indexes Session titles).
     */
    function searchConversation(order, nodes, query, filters, scope) {
      const words = normalizeWords(query)
      if (words.length === 0) return EMPTY_RESULTS
      const only = scope === 'question' ? 'user' : scope === 'paragraph' ? 'assistant' : null
      const scopeFilters = filters === undefined ? defaultFilters() : filters
      const sinceMs = dayStart(scopeFilters.since)
      const untilMs = dayEnd(scopeFilters.until)
      const turnLimit = scopeFilters.turns > 0 ? scopeFilters.turns : 0
      let maxTurn = -1
      if (turnLimit > 0) {
        for (const key of order) {
          const node = nodes.get(key)
          const located = node === undefined ? null : turnOf(node)
          if (located !== null && located > maxTurn) maxTurn = located
        }
      }
      const minTurn = turnLimit > 0 && maxTurn >= 0 ? maxTurn - turnLimit + 1 : Number.NEGATIVE_INFINITY
      const groups = []
      /* One header per Turn: the first question asked in it, exactly like the Host shows it. */
      const turnQuestions = new Map()
      for (const key of order) {
        const node = nodes.get(key)
        const located = node === undefined ? null : turnOf(node)
        if (located === null || turnQuestions.has(located)) continue
        if (roleOf(node) !== 'user') continue
        const content = textOfNode(node, 'user')
        if (content.text === '' && content.files.length === 0) continue
        turnQuestions.set(located, previewLine(content.text === '' ? content.files.join(' ') : content.text))
      }
      /* Paragraph numbers continue across every reply message of a Turn, like the Host corpus. */
      const turnOffsets = new Map()
      let group = null
      let matches = 0
      let truncated = false
      let turn = 0

      for (let index = 0; index < order.length; index += 1) {
        const node = nodes.get(order[index])
        if (!node) continue
        const located = turnOf(node)
        if (located !== null) turn = located
        if (turn < minTurn) continue
        if (!inWindow(nodeTimeOf(node), sinceMs, untilMs)) continue
        const role = roleOf(node)
        if (role === null) continue
        if (only !== null && role !== only) continue
        const content = textOfNode(node, role)
        if (content.text === '' && content.files.length === 0) continue
        const units = messageUnits(node, content.text, content.files)
        const numbered = textUnitCount(units)
        const base = role === 'assistant' ? turnOffsets.get(turn) || 0 : 0
        if (role === 'assistant') turnOffsets.set(turn, base + numbered)
        for (const unit of units) {
          const textMatched = unit.text !== '' && containsAll(unit.text, words)
          const fileHits = matchesFiles(unit.files, words)
          if (!textMatched && fileHits.length === 0) continue
          if (matches >= MAX_RESULTS) {
            truncated = true
            break
          }
          if (group === null || group.turn !== turn) {
            group = { turn, question: turnQuestions.get(turn) || '', items: [] }
            groups.push(group)
          }
          group.items.push({
            key: node.key,
            role,
            index: role === 'assistant' ? base + unit.index : unit.index,
            kind: unit.kind,
            total: numbered,
            anchor: unit.kind === 'file' ? unit.files[0] || '' : unit.text.slice(0, PARAGRAPH_ANCHOR_CHARS),
            hits: (textMatched ? countHits(unit.text, words) : 0) + fileHits.length,
            textMatched,
            files: unit.files,
            matchedFiles: fileHits,
            segments: unit.kind === 'file' ? [] : segmentsOf(snippetOf(unit.text, words), words),
          })
          matches += 1
        }
        if (truncated) break
      }

      return { groups, matches, truncated }
    }

    /** The searchable units of one message: its text paragraphs, plus one file row when needed. */
    function messageUnits(node, text, files) {
      const paragraphs = paragraphsOf(node, text)
      const units = paragraphs.map((paragraph, index) => ({ kind: 'text', text: paragraph, index: index + 1, files: [] }))
      /* A file row names files, it is not a paragraph: it must not take a number, otherwise the
         panel and the Host drift apart by one for every tool-only step in the Turn. */
      if (files.length > 0 && !files.every((name) => text.includes(name))) {
        units.push({ kind: 'file', text: '', index: 0, files })
      }
      return units
    }

    /** How many numbered paragraphs these units carry (file rows excluded). */
    function textUnitCount(units) {
      return units.reduce((count, unit) => (unit.kind === 'text' ? count + 1 : count), 0)
    }

    /** The file names that satisfy every keyword on their own. */
    function matchesFiles(files, words) {
      const out = []
      for (const name of files || []) {
        if (containsAll(name, words)) out.push(name)
      }
      return out
    }

    // #endregion

    // #region Jumping: find the rendered row, scroll it into view, mark the words

    function escapeAttribute(value) {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
      return String(value).replace(/["\\]/g, '\\$&')
    }

    function isVisible(element) {
      if (!element) return false
      if (element.getClientRects().length === 0) return false
      return element.getBoundingClientRect().height > 0
    }

    /** Rendered rows of one Chat node, preferring the main conversation over a sidebar copy. */
    function rowsOf(nodeKey) {
      const selector = '[data-chat-node-key="' + escapeAttribute(nodeKey) + '"]'
      let rows = []
      try {
        rows = Array.prototype.slice.call(document.querySelectorAll(selector))
      } catch (error) {
        return []
      }
      const visible = rows.filter(isVisible)
      const main = visible.find((row) => row.closest('[data-sidebar-right-tab]') === null)
      if (main !== undefined) return [main]
      return visible
    }

    /** The nearest ancestor that actually scrolls, so the page itself never moves. */
    function scrollerOf(element) {
      let node = element.parentElement
      while (node !== null && node !== document.body && node !== document.documentElement) {
        const overflow = getComputedStyle(node).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 2) return node
        node = node.parentElement
      }
      return null
    }

    /** The scrollport to clip markers to: a scrolling ancestor, else the host's known chat scroller. */
    function conversationScrollerOf(row) {
      const found = scrollerOf(row)
      if (found !== null) return found
      try {
        if (row !== null && row !== undefined && typeof row.closest === 'function') {
          return row.closest('[data-conversation-scroll]')
        }
      } catch (error) {
        /* A detached row has no host ancestor. */
      }
      return null
    }

    function prefersReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch (error) {
        return false
      }
    }

    function centerInScroller(scroller, top, height) {
      const box = scroller.getBoundingClientRect()
      const target = scroller.scrollTop + (top - box.top) - Math.max(0, (scroller.clientHeight - height) / 2)
      scroller.scrollTo({
        top: Math.max(0, target),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
    }

    /** The matched-word ranges inside one rendered row. */
    function wordRanges(row, words) {
      const ranges = []
      if (words.length === 0) return ranges
      if (typeof document.createTreeWalker !== 'function') return ranges
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null)
      let text = walker.nextNode()
      while (text !== null && ranges.length < MAX_WORD_HITS) {
        const value = text.nodeValue || ''
        const lower = value.toLowerCase()
        for (const word of words) {
          let from = 0
          while (ranges.length < MAX_WORD_HITS) {
            const at = lower.indexOf(word, from)
            if (at < 0) break
            const range = document.createRange()
            range.setStart(text, at)
            range.setEnd(text, at + word.length)
            ranges.push(range)
            from = at + word.length
          }
        }
        text = walker.nextNode()
      }
      return ranges
    }

    let highlightLayer = null
    let highlightBoxes = []
    let highlightRanges = []
    let highlightFrame = 0
    /** The scrollport the fallback boxes are clipped to (the conversation, never the window). */
    let highlightScroller = null
    /** Watches the scrollport and the composer seat so a resize repaints instead of drifting. */
    let highlightObserver = null
    /** Where the last jump landed: the message row plus the paragraph range inside it. */
    let selectedRange = null
    let selectedAnchor = ''
    let selectedRow = null
    /** Left-edge rail that shows where the landed paragraph sits in the conversation. */
    let railElement = null
    /** Set as soon as the reader scrolls after a jump: the replays must stop moving the view. */
    let userScrolledSinceJump = false

    /** Draw (or move) the left rail next to the landed paragraph. */
    function paintRail(row, range) {
      if (typeof document === 'undefined' || !document.body) return
      selectedRow = row
      selectedRange = range
      if (railElement === null) {
        try {
          railElement = document.createElement('div')
          railElement.className = 'dsh-csearch-rail'
          railElement.setAttribute('aria-hidden', 'true')
          /* Positioned before it is shown, so it never appears in the wrong place first. */
          railElement.style.visibility = 'hidden'
          document.body.appendChild(railElement)
          document.addEventListener('scroll', onRailScroll, { capture: true, passive: true })
          window.addEventListener('resize', onRailScroll)
        } catch (error) {
          railElement = null
          return
        }
      }
      onRailScroll()
    }

    /** The rectangle the rail should follow: the paragraph when known, its message otherwise. */
    function railRect() {
      if (selectedRange !== null) {
        try {
          const rect = selectedRange.getBoundingClientRect()
          if (rect !== null && rect.height >= 1) return rect
        } catch (error) {
          /* A re-render replaced the text nodes; fall back to the message row. */
        }
      }
      if (selectedRow === null) return null
      try {
        const rect = selectedRow.getBoundingClientRect()
        if (rect !== null && rect.height >= 1) return rect
      } catch (error) {
        return null
      }
      return null
    }

    function onRailScroll() {
      if (railElement === null) return
      const rect = railRect()
      if (rect === null) {
        railElement.style.display = 'none'
        return
      }
      const scroller = selectedRow === null ? null : conversationScrollerOf(selectedRow)
      let left = 2
      let top = rect.top
      let height = rect.height
      if (scroller !== null) {
        const box = scroller.getBoundingClientRect()
        left = Math.max(0, box.left + 2)
        top = Math.max(box.top, rect.top)
        height = Math.min(rect.bottom, box.bottom) - top
      }
      if (height < 8) {
        railElement.style.display = 'none'
        return
      }
      railElement.style.display = 'block'
      railElement.style.left = left + 'px'
      railElement.style.top = Math.max(0, top) + 'px'
      railElement.style.height = Math.min(height, window.innerHeight - Math.max(0, top)) + 'px'
      railElement.style.visibility = 'visible'
    }

    function clearRail() {
      selectedRange = null
      if (railElement !== null) {
        try {
          railElement.remove()
        } catch (error) {
          /* The layer may already be gone with its document. */
        }
        railElement = null
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('scroll', onRailScroll, true)
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onRailScroll)
      }
    }

    /** Native text highlight: the browser-find look, anchored to the text so it scrolls with it. */
    function applyNativeHighlight(ranges) {
      if (ranges.length === 0) return false
      if (typeof Highlight === 'undefined') return false
      if (typeof CSS === 'undefined' || !CSS || !CSS.highlights || typeof CSS.highlights.set !== 'function') return false
      try {
        CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges))
        return true
      } catch (error) {
        return false
      }
    }

    function clearNativeHighlight() {
      try {
        if (typeof CSS !== 'undefined' && CSS && CSS.highlights && typeof CSS.highlights.delete === 'function') {
          CSS.highlights.delete(HIGHLIGHT)
        }
      } catch (error) {
        /* Nothing to clear without the API. */
      }
    }

    /**
     * The viewport rectangle the fallback marker may paint in.
     *
     * A `position: fixed` box does not follow the scrollport's clipping: once the text it marks
     * scrolls under the composer or out of the conversation, the box would still hang there.
     * Clamp to the conversation scrollport and stop at the composer seat.
     */
    function overlayClip() {
      const view = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      const scroller = highlightScroller
      if (scroller === null) return view
      let rect
      try {
        rect = scroller.getBoundingClientRect()
      } catch (error) {
        return view
      }
      let bottom = rect.bottom
      try {
        const seat = typeof scroller.querySelector === 'function' ? scroller.querySelector('[data-composer-seat]') : null
        if (seat !== null) {
          const seatRect = seat.getBoundingClientRect()
          if (seatRect.height > 0 || seatRect.top > rect.top) bottom = Math.min(bottom, seatRect.top)
        }
      } catch (error) {
        /* The composer seat is optional; the scrollport alone still clips the marker. */
      }
      return {
        left: Math.max(view.left, rect.left),
        top: Math.max(view.top, rect.top),
        right: Math.min(view.right, rect.right),
        bottom: Math.min(view.bottom, bottom),
      }
    }

    /** Move the fallback boxes onto their ranges' current position, clipped to the scrollport. */
    function positionOverlay() {
      highlightFrame = 0
      const clip = overlayClip()
      for (let index = 0; index < highlightBoxes.length; index += 1) {
        const box = highlightBoxes[index]
        const range = highlightRanges[index]
        let rect
        try {
          rect = range.getBoundingClientRect()
        } catch (error) {
          box.style.display = 'none'
          continue
        }
        if (rect === null || rect === undefined || rect.width < 1 || rect.height < 1) {
          box.style.display = 'none'
          continue
        }
        const left = Math.max(rect.left, clip.left)
        const top = Math.max(rect.top, clip.top)
        const right = Math.min(rect.right, clip.right)
        const bottom = Math.min(rect.bottom, clip.bottom)
        if (right - left < 1 || bottom - top < 1) {
          box.style.display = 'none'
          continue
        }
        box.style.display = ''
        box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
        box.style.width = `${Math.ceil(right - left)}px`
        box.style.height = `${Math.ceil(bottom - top)}px`
      }
    }

    function scheduleOverlay() {
      if (highlightFrame !== 0) return
      if (typeof requestAnimationFrame !== 'function') {
        positionOverlay()
        return
      }
      highlightFrame = requestAnimationFrame(positionOverlay)
    }

    function detachOverlay() {
      if (highlightFrame !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(highlightFrame)
        highlightFrame = 0
      }
      /* A capture listener on the document sees every scroller, including one replaced mid-jump. */
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('scroll', scheduleOverlay, true)
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', scheduleOverlay)
      }
      if (highlightObserver !== null) {
        const observer = highlightObserver
        highlightObserver = null
        try {
          observer.disconnect()
        } catch (error) {
          /* An observer on a removed element is harmless. */
        }
      }
      highlightScroller = null
      highlightBoxes = []
      highlightRanges = []
      if (highlightLayer !== null) {
        const layer = highlightLayer
        highlightLayer = null
        try {
          layer.remove()
        } catch (error) {
          /* The layer may already be gone with its document. */
        }
      }
    }

    /** Fallback marker for a build without the Custom Highlight API: boxes that follow scrolling. */
    function paintOverlay(ranges, scroller) {
      detachOverlay()
      if (ranges.length === 0) return
      if (typeof document === 'undefined' || !document.body) return
      let layer
      try {
        layer = document.createElement('div')
        layer.className = 'dsh-csearch-highlight-layer'
        document.body.appendChild(layer)
      } catch (error) {
        return
      }
      for (const range of ranges.slice(0, 40)) {
        const box = document.createElement('span')
        box.className = 'dsh-csearch-highlight'
        layer.appendChild(box)
        highlightBoxes.push(box)
        highlightRanges.push(range)
      }
      highlightLayer = layer
      highlightScroller = scroller === undefined ? null : scroller
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('scroll', scheduleOverlay, { capture: true, passive: true })
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', scheduleOverlay)
      }
      if (highlightScroller !== null && typeof ResizeObserver === 'function') {
        try {
          highlightObserver = new ResizeObserver(() => scheduleOverlay())
          highlightObserver.observe(highlightScroller)
          const seat = typeof highlightScroller.querySelector === 'function'
            ? highlightScroller.querySelector('[data-composer-seat]')
            : null
          if (seat !== null) highlightObserver.observe(seat)
        } catch (error) {
          highlightObserver = null
        }
      }
      positionOverlay()
    }

    function clearNativeSelection() {
      try {
        if (typeof CSS !== 'undefined' && CSS && CSS.highlights && typeof CSS.highlights.delete === 'function') {
          CSS.highlights.delete(SELECTED)
        }
      } catch (error) {
        /* Nothing to clear without the API. */
      }
    }

    /** Collapse one rendered row's text, keeping a map back to its text nodes. */
    function normalizedTextMap(root) {
      if (typeof document.createTreeWalker !== 'function' || typeof NodeFilter === 'undefined') return null
      let walker
      try {
        walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      } catch (error) {
        return null
      }
      const map = []
      let text = ''
      let pendingSpace = false
      let node = walker.nextNode()
      while (node !== null) {
        const value = node.nodeValue || ''
        for (let offset = 0; offset < value.length; offset += 1) {
          const char = value[offset]
          if (/\s/.test(char)) {
            if (text !== '') pendingSpace = true
            continue
          }
          if (pendingSpace) {
            text += ' '
            map.push({ node, offset })
            pendingSpace = false
          }
          text += char
          map.push({ node, offset })
        }
        node = walker.nextNode()
      }
      return { text, map }
    }

    /** A range covering the paragraph that starts with `anchor` inside one rendered message row. */
    function paragraphRange(row, anchor) {
      const needle = normalizeAnchor(anchor)
      if (needle === '') return null
      const built = normalizedTextMap(row)
      if (built === null || built.map.length === 0) return null
      const lowered = built.text.toLowerCase()
      /* A long anchor can still miss when the renderer drops more than inline markers (a link
         target, an emoji shortcode): fall back to a shorter prefix of the same paragraph. */
      let at = lowered.indexOf(needle)
      let length = needle.length
      for (const cut of [120, 80, 50, 30]) {
        if (at >= 0) break
        if (needle.length <= cut) continue
        at = lowered.indexOf(needle.slice(0, cut))
        length = cut
      }
      if (at < 0) return null
      const start = built.map[at]
      const end = built.map[Math.min(built.map.length - 1, at + length - 1)]
      if (start === undefined || end === undefined) return null
      try {
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset + 1)
        return range
      } catch (error) {
        return null
      }
    }

    /** Debug dump of one message's element tree, so a failed anchor match can be diagnosed. */
    /** Drop the arrival marker and the rail; the next jump paints both again. */
    function clearSelection() {
      clearNativeSelection()
      clearRail()
      selectedAnchor = ''
      selectedRow = null
    }

    /**
     * Mark where the jump landed.
     *
     * The rail is the only visual: a tinted block was tried for a while, but it only worked when the
     * raw anchor could be found in the rendered DOM (emoji, tables and code blocks broke it), so the
     * rail — drawn from the paragraph's own range — is what readers actually get, every time.
     */
    function paintSelection(row, anchor) {
      const wanted = typeof anchor === 'string' ? anchor : ''
      if (wanted === '') {
        clearSelection()
        return false
      }
      selectedAnchor = wanted
      selectedRow = row
      const range = paragraphRange(row, wanted)
      paintRail(row, range)
      return range !== null
    }

    /** Remove every arrival marker (keywords + paragraph selection). It stays until the search changes. */
    function clearHighlight() {
      clearNativeHighlight()
      clearSelection()
      detachOverlay()
    }

    /** The ranges painted last, so a replay can tell "still valid" from "a re-render killed them". */
    let lastPaint = { key: '', ranges: [], anchor: '' }

    function rangesAlive(ranges) {
      if (ranges.length === 0) return false
      for (const range of ranges) {
        const node = range.startContainer
        if (node === null || node === undefined) return false
        if (typeof node.isConnected === 'boolean' && !node.isConnected) return false
      }
      return true
    }

    /**
     * Mark one row: the landed paragraph first (blue), then the matched words (amber).
     *
     * Registration order is the paint order of Custom Highlights, so the amber words stay
     * readable on top of the blue paragraph wash instead of being tinted by it.
     */
    function paintHighlight(row, words, scroller, anchor) {
      paintSelection(row, anchor)
      const ranges = wordRanges(row, words)
      /* An empty word list must retire the previous keyword marker instead of leaving it behind. */
      if (ranges.length === 0) clearNativeHighlight()
      const native = applyNativeHighlight(ranges)
      if (native) detachOverlay()
      else paintOverlay(ranges, scroller)
      debugLog('highlight', { ranges: ranges.length, native, selected: selectedRange !== null })
      return ranges
    }

    /** Scroll and mark one row at its CURRENT position. */
    function scrollAndPaint(row, words, anchor) {
      const scroller = conversationScrollerOf(row)
      const ranges = paintHighlight(row, words, scroller, anchor)
      /* Centre on the paragraph itself, not on the first keyword: a target that is already on
         screen must still move to the middle, which is what "jump" means to a reader. */
      const paragraph = typeof anchor === 'string' ? paragraphRange(row, anchor) : null
      const focus = paragraph !== null ? paragraph.getBoundingClientRect() : null
      if (scroller !== null) {
        const rect = focus !== null && focus.height > 0
          ? focus
          : ranges.length > 0
            ? ranges[0].getBoundingClientRect()
            : row.getBoundingClientRect()
        centerInScroller(scroller, rect.top, rect.height)
      } else if (focus !== null && focus.height > 0 && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      } else if (typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }
      return ranges
    }

    /** Scroll the conversation to one message, mark the paragraph and the matched words. */
    function jumpToNode(nodeKey, words, anchor) {
      const rows = rowsOf(nodeKey)
      const row = rows[0]
      if (row === undefined) {
        debugLog('jump: row not rendered', nodeKey)
        return false
      }
      lastPaint = { key: nodeKey, ranges: scrollAndPaint(row, words, anchor), anchor }
      /* Click (or panel pick) to a visible landing marker: the number performance work must move. */
      jumpTiming.lastMs = Date.now() - (jumpTiming.requestedAt === 0 ? Date.now() : jumpTiming.requestedAt)
      jumpTiming.requestedAt = 0
      debugLog('jump: landed', { jumpMs: jumpTiming.lastMs })
      userScrolledSinceJump = false
      replayLanding(nodeKey, words, anchor)
      return true
    }

    /**
     * Put the paragraph back under the middle of the scrollport after a reflow.
     *
     * The smooth scroll targets the layout at the time of the click; opening the panel (or a
     * re-render) changes that layout, which is why a "centred" jump sometimes ends up low. This
     * correction is instant and only fires when the offset is visible.
     */
    function correctCenter(row, anchor) {
      const scroller = conversationScrollerOf(row)
      if (scroller === null) return
      const range = typeof anchor === 'string' && anchor !== '' ? paragraphRange(row, anchor) : null
      const rect = range !== null ? range.getBoundingClientRect() : row.getBoundingClientRect()
      if (rect === null || rect.height < 1) return
      const box = scroller.getBoundingClientRect()
      const delta = (rect.top - box.top) - (scroller.clientHeight - rect.height) / 2
      if (Math.abs(delta) < 4) return
      try {
        scroller.scrollTop = scroller.scrollTop + delta
      } catch (error) {
        /* A scroller that no longer accepts writes is left as it is. */
      }
    }

    /** Keep the arrival visible while the Chat view settles.
     *
     * A re-render replaces the text nodes the ranges point at, so the marker is rebuilt a few
     * times. A pass that finds the previous ranges still attached does nothing at all: repainting
     * a healthy highlight is what made it look like it was flashing, and re-scrolling on every
     * pass made the page bounce.
     */
    function replayLanding(nodeKey, words, anchor) {
      for (const delay of [120, 400, 900, 1500]) {
        setTimeout(() => {
          /* Once the reader scrolls, the jump is theirs: no more repaints and no re-centring. */
          if (userScrolledSinceJump) return
          const rows = rowsOf(nodeKey)
          const row = rows[0]
          if (row === undefined) return
          if (lastPaint.key !== nodeKey || !rangesAlive(lastPaint.ranges)) {
            /* Only the first pass scrolls; later passes exist for the marker alone. */
            const ranges = paintHighlight(row, words, conversationScrollerOf(row), anchor)
            lastPaint = { key: nodeKey, ranges, anchor }
            return
          }
          /* The rail can be swept by the query effect that a mirrored search triggers right after
             the jump; re-assert it on every pass so it cannot stay missing. */
          paintSelection(row, anchor)
          /* Opening the panel reflows the middle column, so the target drifts after the smooth
             scroll ends. Correct the residual offset without animating it. */
          correctCenter(row, anchor)
        }, delay)
      }
    }

    // #endregion

    // #region Right sidebar entry points

    /** How long one jump-requested panel open keeps retrying across a Session switch. */
    const PANEL_OPEN_TIMEOUT_MS = 10_000
    /** Pending retry timers for a tab that is asked for before the sidebar is ready. */
    const tabRetries = new Map()
    /** Jump-requested panel opens, alive until the panel confirms it mounted (or the deadline). */
    const panelOpens = new Map()

    function requestPanelOpen(sessionId) {
      panelOpens.set(sessionId, Date.now() + PANEL_OPEN_TIMEOUT_MS)
    }

    /** The deadline of a pending open, or 0 when there is none (and cleaning up an expired one). */
    function panelOpenWanted(sessionId) {
      const until = panelOpens.get(sessionId)
      if (until === undefined) return 0
      if (Date.now() > until) {
        panelOpens.delete(sessionId)
        return 0
      }
      return until
    }

    function panelOpenDeadline(sessionId) {
      return panelOpens.get(sessionId) || 0
    }

    /** The panel itself is the only proof that the request succeeded. */
    function markPanelOpen(sessionId) {
      panelOpens.delete(sessionId)
    }

    /**
     * Open the search tab for one Session and ask its panel for focus.
     *
     * Right after a session switch the sidebar registries can still be mid-mount, so a failed
     * attempt is retried until `until` instead of being dropped after a fixed number of tries.
     */
    function openSearchTab(ctx, sessionId, options) {
      const focus = options === undefined || options === null || options.focus !== false
      const until = options !== undefined && options !== null && typeof options.until === 'number'
        ? options.until
        : Date.now() + 1_100
      const pending = tabRetries.get(sessionId)
      if (pending !== undefined) clearTimeout(pending)

      const attempt = () => {
        const tabs = ctx.get('sidebarRightTabs')
        const sidebar = ctx.get('sidebarRight')
        const ready = Boolean(tabs) && typeof tabs.get === 'function' && tabs.get(TAB_KIND) !== undefined && Boolean(sidebar)
        if (ready) {
          try {
            /* The on-screen Session's own path, the one a chat file link takes: it also expands the column. */
            sidebar.openTab(TAB_KIND, { revealIfOpened: true })
            tabRetries.delete(sessionId)
            if (focus) requestFocus(sessionId)
            return
          } catch (error) {
            try {
              if (typeof sidebar.openTabIn !== 'function') throw error
              sidebar.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true })
              tabRetries.delete(sessionId)
              if (focus) requestFocus(sessionId)
              return
            } catch (fallbackError) {
              /* Fall through to a short retry: the column may still be mounting. */
            }
          }
        }
        if (Date.now() >= until) {
          tabRetries.delete(sessionId)
          console.warn('[conversation-search] the right-sidebar tab is still unavailable')
          return
        }
        tabRetries.set(
          sessionId,
          setTimeout(attempt, 180),
        )
      }
      attempt()
    }

    /** Bind Ctrl/Cmd+F to the in-conversation search, preferring the app's shortcut registry. */
    /** Switch the main area to the global page; the left rail entry stays the visible affordance. */
    function openGlobalPanel(ctx) {
      const layout = ctx.get('layout')
      if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(PANEL_ID)
          return true
        } catch (error) {
          debugLog('global panel selection failed', { message: String(error && error.message) })
        }
      }
      return false
    }

    /**
     * Bind the two search entries.
     *
     * The registry validates a command's defaults for every runtime before it stores anything, and
     * the Web runtime only admits a short allow-list — `primary+KeyF` is not on it, so a web default
     * refused the whole command (desktop included). Both commands therefore declare desktop keys
     * only, and the page keeps its own listener for the Web.
     *
     *   Ctrl/Cmd+F        in-conversation panel
     *   Ctrl/Cmd+Shift+F  global search page
     */
    function registerFindShortcut(ctx, t, open) {
      const shortcuts = ctx.get('shortcuts')
      const disposeList = []
      if (shortcuts !== undefined && shortcuts !== null && typeof shortcuts.register === 'function') {
        const commands = [
          {
            id: 'conversation-search.find',
            label: () => t('command.find'),
            aliases: ['search conversation', 'find in conversation'],
            run: open,
          },
          {
            id: 'conversation-search.global',
            label: () => t('command.global'),
            aliases: ['search all sessions', 'global search'],
            run: () => openGlobalPanel(ctx),
          },
        ]
        for (const command of commands) {
          try {
            const dispose = shortcuts.register({
              id: command.id,
              label: command.label,
              aliases: command.aliases,
              defaults: {
                'desktop:macos': { code: 'KeyF', modifiers: command.id.endsWith('.global') ? ['primary', 'shift'] : ['primary'] },
                'desktop:windows': { code: 'KeyF', modifiers: command.id.endsWith('.global') ? ['primary', 'shift'] : ['primary'] },
                'desktop:linux': { code: 'KeyF', modifiers: command.id.endsWith('.global') ? ['primary', 'shift'] : ['primary'] },
              },
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({ status: 'handled', run: command.run }),
            })
            if (typeof dispose === 'function') disposeList.push(dispose)
          } catch (error) {
            debugLog('shortcut registry refused the binding', { id: command.id, message: String(error && error.message) })
          }
        }
      }
      /* The page listener is the only binding the Web runtime gets, and on desktop it stays quiet
         because the registry handles the key first (it marks the event prevented). */
      disposeList.push(registerDomFindShortcut(open, () => openGlobalPanel(ctx)))
      return () => {
        for (const dispose of disposeList) {
          try {
            dispose()
          } catch (error) {
            debugLog('releasing a shortcut binding failed', { message: String(error && error.message) })
          }
        }
      }
    }

    /** Page-level bindings for Ctrl/Cmd+F and Ctrl/Cmd+Shift+F; skipped when already handled. */
    function registerDomFindShortcut(open, openGlobal) {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
      const handler = (event) => {
        if (event.defaultPrevented) return
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return
        if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'f') return
        const target = event.target
        const inEditor =
          target !== null &&
          target !== undefined &&
          typeof target.closest === 'function' &&
          target.closest('.cm-editor, .xterm, .xterm-helper-textarea') !== null
        if (inEditor) return
        event.preventDefault()
        if (event.shiftKey) openGlobal()
        else open()
      }
      /* Bubble phase on purpose: a registry binding on document/window runs first and marks the
         event handled, so the two never both act on one press. */
      document.addEventListener('keydown', handler, false)
      return () => document.removeEventListener('keydown', handler, false)
    }

    /** Ask the Session to page in one more slice of older history. */
    function loadOlderPage(ctx, sessionId) {      const sessions = ctx.get('sessions')
      if (!sessions || typeof sessions.binding !== 'function') return false
      const binding = sessions.binding(sessionId)
      const session = binding && binding.session
      if (!session || typeof session.loadOlder !== 'function') return false
      try {
        session.loadOlder()
        return true
      } catch (error) {
        console.error('[conversation-search] loading older history failed', error)
        return false
      }
    }

    // #endregion

    // #region Global search: Host route, result tree, cross-Session jumps

    /** The page's own base, so a reverse-proxy prefix or the desktop shell's scheme still reaches the Host. */
    function apiBase() {
      const fallback = 'http://dsh.internal/'
      let base = fallback
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') base = document.baseURI
      } catch (error) {
        base = fallback
      }
      let url
      try {
        url = new URL(base)
      } catch (error) {
        return fallback
      }
      const slash = url.pathname.lastIndexOf('/')
      url.pathname = slash < 0 ? '/' : url.pathname.slice(0, slash + 1)
      url.search = ''
      url.hash = ''
      return url.href
    }

    function apiUrl(path) {
      return apiBase() + String(path).replace(/^\/+/, '')
    }

    /** One POST to the plugin route, unwrapping its `{ ok, value }` envelope. */
    async function postGlobal(body, signal) {
      const response = await fetch(apiUrl(GLOBAL_ROUTE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        const message =
          payload !== null && payload.error !== null && typeof payload.error === 'object' && typeof payload.error.message === 'string'
            ? payload.error.message
            : 'HTTP ' + response.status
        throw new Error(message)
      }
      return payload.value
    }

    /** Ask the Host for one page of global results; `refresh` forces a corpus rebuild. */
    function fetchGlobalSearch(query, scope, signal, refresh, filters) {
      const body = { action: 'search', query, scope }
      if (refresh === true) body.refresh = true
      if (filters !== undefined) body.filters = filters
      return postGlobal(body, signal)
    }

    /** Ask the Host for the persisted query history. */
    async function fetchRecent(signal) {
      const value = await postGlobal({ action: 'recent' }, signal)
      return Array.isArray(value.recent) ? value.recent.filter((entry) => typeof entry === 'string') : []
    }

    /** Ask the Host for the saved filter window. */
    async function fetchFilters(signal) {
      const value = await postGlobal({ action: 'filters' }, signal)
      return normalizeFilters(value.filters)
    }

    /** Persist the filter window; a failure keeps the in-page value. */
    function saveFilters(filters) {
      return postGlobal({ action: 'filters', filters }).catch((error) => {
        console.error('[conversation-search] saving filters failed', error)
      })
    }

    /** The tail of a working directory: enough to identify a project without the drive noise. */
    function displayPath(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return ''
      const parts = cwd.replace(/\\/g, '/').split('/').filter((part) => part !== '')
      if (parts.length === 0) return ''
      return parts.slice(-2).join('/')
    }

    /** Session and question keys a fresh result starts expanded. */
    function defaultOpen(result) {
      const open = new Set()
      if (result === null || !Array.isArray(result.sessions)) return open
      /* Only the first couple of Sessions start expanded: enough to read, cheap to paint. */
      const limit = result.sessions.length <= 2 ? result.sessions.length : 2
      for (const session of result.sessions.slice(0, limit)) {
        open.add('s:' + session.id)
        for (const question of session.questions || []) open.add('q:' + session.id + ':' + question.seq)
      }
      return open
    }

    /** Cached lowercase text per Chat node, so anchor matching stays cheap. */
    const nodeTextCache = new WeakMap()

    function nodeTextOf(node) {
      const cached = nodeTextCache.get(node)
      if (cached !== undefined) return cached
      const role = roleOf(node)
      /* Collapse whitespace exactly like the Host does when it builds the anchor, otherwise a
         multi-line paragraph never matches its own copied text. */
      const text = role === null ? '' : textOfNode(node, role).text.toLowerCase().replace(/\s+/g, ' ').trim()
      nodeTextCache.set(node, text)
      return text
    }

    function normalizeAnchor(value) {
      if (value === undefined || value === null) return ''
      return stripInlineMarkdown(String(value)).toLowerCase().replace(/\s+/g, ' ').trim()
    }

    /**
     * Do two paragraph anchors name the same paragraph? The page and the panel cut anchors at
     * slightly different lengths, so compare the shared prefix instead of the whole string.
     */
    function anchorMatches(left, right) {
      const a = normalizeAnchor(left)
      const b = normalizeAnchor(right)
      if (a === '' || b === '') return false
      const size = Math.min(32, a.length, b.length)
      return size >= 8 && a.slice(0, size) === b.slice(0, size)
    }

    /**
     * Inline markdown the rendered text never shows: anchors are cut from the raw message, the DOM
     * holds the rendered form, so `**筛选窗口**` must compare equal to `筛选窗口`.
     */
    function stripInlineMarkdown(value) {
      return String(value)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
    }

    /**
     * Resolve one pending jump against the loaded window.
     *
     * The text anchor wins over the event sequence: a Chat node's `anchorSeq` is the event that
     * opened its step, which drifts from the paragraph's own seq. A Session that has not loaded
     * the target must NOT fall back to the nearest node — that lands on the wrong message and
     * ends the jump, so `allowNearest` is only set once the whole history is known to be in.
     */
    function resolveJump(order, nodes, pending, allowNearest) {
      const anchor = normalizeAnchor(pending.anchor)
      const wanted = pending.kind === 'question' ? 'user' : 'assistant-step'
      let exact = null
      let anchorInTurn = null
      let anchorAnywhere = null
      let below = null
      let above = null
      for (const key of order) {
        const node = nodes.get(key)
        if (!node || typeof node.anchorSeq !== 'number') continue
        const roleOk = node.kind === wanted
        if (roleOk && node.anchorSeq === pending.seq && exact === null) exact = key
        if (roleOk && anchor !== '') {
          const text = nodeTextOf(node)
          if (text.includes(anchor)) {
            if (anchorInTurn === null && pending.turn !== undefined && turnOf(node) === pending.turn) anchorInTurn = key
            else if (anchorAnywhere === null) anchorAnywhere = key
          }
        }
        if (!roleOk) continue
        const distance = node.anchorSeq - pending.seq
        if (distance < 0 && (below === null || distance > below.distance)) below = { key, distance }
        if (distance > 0 && (above === null || distance < above.distance)) above = { key, distance }
      }
      if (exact !== null) return { key: exact, precise: true }
      if (anchorInTurn !== null) return { key: anchorInTurn, precise: true }
      if (anchorAnywhere !== null) return { key: anchorAnywhere, precise: true }
      if (!allowNearest) return null
      if (below !== null) return { key: below.key, precise: false }
      if (above !== null) return { key: above.key, precise: false }
      return null
    }

    /** Remember a jump for a Session that is about to open, and wake a reader already showing it. */
    function requestJump(sessionId, jump) {
      pendingJumps.set(sessionId, {
        seq: jump.seq,
        kind: jump.kind,
        words: jump.words,
        anchor: typeof jump.anchor === 'string' ? jump.anchor : '',
        paragraph: typeof jump.paragraph === 'string' ? jump.paragraph : '',
        turn: typeof jump.turn === 'number' ? jump.turn : undefined,
        tries: 0,
        at: Date.now(),
      })
      for (const listener of jumpListeners) {
        try {
          listener(sessionId)
        } catch (error) {
          console.error('[conversation-search] jump listener failed', error)
        }
      }
    }

    /** Start one pending jump as soon as it is requested, not only when the Session mounts. */
    function onJumpRequest(listener) {
      jumpListeners.add(listener)
      return () => jumpListeners.delete(listener)
    }

    /** Page in history through one sequence so an unloaded paragraph becomes reachable. */
    function requestThrough(ctx, sessionId, seq) {
      const sessions = ctx.get('sessions')
      if (!sessions || typeof sessions.binding !== 'function') return
      const binding = sessions.binding(sessionId)
      const session = binding && binding.session
      if (!session || typeof session.loadThrough !== 'function') return
      try {
        const pending = session.loadThrough(seq)
        if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(() => {})
      } catch (error) {
        /* A Session with nothing older to load simply has nothing to do. */
      }
    }

    /** Open one Session in the conversation panel, with an optional pending jump. */
    function openSearchTarget(ctx, sessionId, jump, title) {
      /* `ctx.get` rather than `ctx.uiWorkspace`: the plugin context only injects the slots and
         locale services, so an un-injected service property can read as undefined. */
      const workspace = ctx.get('uiWorkspace')
      const openSession = workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function'
        ? workspace.openSession.bind(workspace)
        : null
      if (openSession === null) {
        console.error('[conversation-search] uiWorkspace.openSession is unavailable')
        return
      }
      /* Feedback first: the indicator appears at once, so the click is always acknowledged. */
      beginOpening(sessionId, title, jump === null || jump === undefined ? null : { kind: jump.kind, turn: jump.turn })
      /* Click-to-landing clock starts here, before the Session switch, so it includes everything. */
      jumpTiming.requestedAt = Date.now()
      if (jump !== null && jump !== undefined) requestJump(sessionId, jump)
      try {
        /* Opening a Session also reveals the conversation panel (it selects the null panel id). */
        openSession(sessionId)
      } catch (error) {
        endOpening()
        console.error('[conversation-search] opening the session failed', error)
        const layout = ctx.get('layout')
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel(null)
          } catch (fallbackError) {
            console.error('[conversation-search] revealing the conversation panel failed', fallbackError)
          }
        }
        return
      }
      /* Ask for the target history at once instead of waiting for the first poll. */
      if (jump !== null && jump !== undefined && typeof jump.seq === 'number') requestThrough(ctx, sessionId, jump.seq)
      /* Mirror the page's query into the panel so both entries behave the same afterwards. */
      if (jump !== null && jump !== undefined && typeof jump.query === 'string' && jump.query.trim() !== '') {
        requestPanelSearch(sessionId, jump.query, panelScopeOf(jump.scope), jump.filters, jump.paragraph)
        /* Opening the tab right away is only the fast path: a cross-Session switch can remount the
           sidebar after this call, so the request stays pending until the Session is actually open. */
        requestPanelOpen(sessionId)
        openSearchTab(ctx, sessionId, { focus: false, until: panelOpenDeadline(sessionId) })
      }
    }

    /** Render one segmented text run list, marking the matched runs. */
    function markSegments(segments) {
      return segments.map((segment, index) =>
        segment.hit ? h('mark', { key: index }, segment.text) : h('span', { key: index }, segment.text),
      )
    }

    /** Move focus between the result rows of one panel; false when there is nowhere to go. */
    function moveRowFocus(container, delta) {
      if (!container || typeof container.querySelectorAll !== 'function') return false
      const rows = Array.prototype.slice.call(container.querySelectorAll('[data-csearch-row]'))
      if (rows.length === 0) return false
      const current = rows.indexOf(document.activeElement)
      const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta))
      const row = rows[next]
      if (row === undefined) return false
      row.focus()
      return true
    }

    // #endregion

    // #region Icons

    /** One inline SVG spinner: border-free, so it renders the same in every host build. */
    function spinner(size) {
      const edge = size === 'sm' ? 12 : 16
      return h(
        'svg',
        { className: 'dsh-spin', viewBox: '0 0 24 24', width: edge, height: edge, 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 3, opacity: 0.2 }),
        h('path', { d: 'M21 12a9 9 0 0 0-9-9', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
      )
    }

    function IconSearch() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: '7', cy: '7', r: '4.4', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M10.4 10.4 14 14', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    function IconClose() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 4 12 12M12 4 4 12', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function IconCaret(props) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', className: props.className, 'data-open': props.open ? 'true' : 'false', 'aria-hidden': 'true' },
        h('path', { d: 'M6 4l4 4-4 4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** The left rail's glyph: a magnifier over message lines. */
    function GlobalSearchIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: '8.5', cy: '8.5', r: '5.2', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M12.4 12.4 17 17', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M6.2 8.7h4.6M6.2 6.3h2.6', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', opacity: '0.7' }),
      )
    }

    /** A small funnel for the filter toggle. */
    function IconFilter() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 3.5h11l-4.2 5v4l-2.6-1.4V8.5z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
      )
    }

    // #endregion

    // #region Components

    /**
     * The date-range and turn-count inputs, shared by the page and the panel.
     *
     * Empty dates and a zero turn count mean "no bound"; the reset button restores the defaults.
     */
    function filterFields(t, value, onChange) {
      /* Any hand edit turns the window from "last 14 days" into a fixed range: it stops following
         today, which is what the reader asked for by typing dates. */
      const update = (patch) => onChange({ ...value, ...patch, rolling: false, savedOn: '' })
      return h(
        'div',
        { className: 'dsh-filter-body' },
        h(
          'label',
          { className: 'dsh-filter-field' },
          h('span', { className: 'dsh-filter-label' }, t('filters.since')),
          h('input', {
            type: 'date',
            className: 'dsh-filter-input',
            value: value.since,
            'aria-label': t('filters.since'),
            onChange: (event) => update({ since: event.target.value }),
          }),
        ),
        h('span', { className: 'dsh-filter-dash', 'aria-hidden': 'true' }, '~'),
        h(
          'label',
          { className: 'dsh-filter-field' },
          h('span', { className: 'dsh-filter-label' }, t('filters.until')),
          h('input', {
            type: 'date',
            className: 'dsh-filter-input',
            value: value.until,
            'aria-label': t('filters.until'),
            onChange: (event) => update({ until: event.target.value }),
          }),
        ),
        h(
          'label',
          { className: 'dsh-filter-field dsh-filter-field-turns' },
          h('span', { className: 'dsh-filter-label' }, t('filters.turns')),
          h('input', {
            type: 'number',
            min: 0,
            step: 1,
            className: 'dsh-filter-input dsh-filter-number',
            value: value.turns === 0 ? '' : String(value.turns),
            placeholder: t('filters.unlimited'),
            'aria-label': t('filters.turns'),
            onChange: (event) =>
              update({ turns: event.target.value === '' ? 0 : Math.max(0, Math.floor(Number(event.target.value) || 0)) }),
          }),
        ),
        h(
          'button',
          { type: 'button', className: 'dsh-filter-reset', onClick: () => onChange(defaultFilters()) },
          t('filters.reset'),
        ),
      )
    }

    /** The page's always-visible bar. */
    function filterBarWide(t, value, onChange) {
      return h(
        'div',
        { className: 'dsh-filters' },
        h('span', { className: 'dsh-filter-title' }, t('filters.label')),
        filterFields(t, value, onChange),
      )
    }

    /** The panel's collapsed bar: one toggle line that names the active window. */
    function filterBarCompact(t, value, onChange, open, onToggle) {
      return h(
        'div',
        { className: 'dsh-filters dsh-filters-compact' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-filter-toggle',
            'aria-expanded': open,
            onClick: onToggle,
          },
          h(IconFilter, null),
          h('span', { className: 'dsh-filter-toggle-label' }, t('filters.label')),
          h('span', { className: 'dsh-filter-summary' }, filtersSummary(t, value)),
        ),
        open ? filterFields(t, value, onChange) : null,
      )
    }

    /** Header utility: the one click that opens the panel. */
    function SearchButton(props) {
      const t = props.t
      const openSearch = props.openSearch
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-csearch-btn',
          title: t('action.open'),
          'aria-label': t('action.open'),
          onClick: () => {
            try {
              openSearch()
            } catch (error) {
              console.error('[conversation-search] opening the panel failed', error)
            }
          },
        },
        h(IconSearch, null),
      )
    }

    /** The tab chip. */
    function SearchTitle(props) {
      return h('span', { className: 'dsh-csearch-title' }, h(IconSearch, null), props.t('tab.title'))
    }

    /** The search panel: input, history notice, and the grouped result list. */
    function SearchPanel(props) {
      const t = props.t
      const sessionId = props.sessionId
      const useChat = props.useChat
      const useSession = props.useSession
      const requestOlder = props.requestOlder
      /* The seat hands every tab body `useTabInfo`; `closeTab` comes from this plugin's inject. */
      const useTabInfo = props.useTabInfo
      const closeTab = props.closeTab
      const closeSelf = useCallback(() => {
        try {
          const info = typeof useTabInfo === 'function' ? useTabInfo() : null
          const tab = info !== null && info !== undefined && info.tab !== null && info.tab !== undefined ? info.tab : null
          const tabId = tab !== null && typeof tab.id === 'string' ? tab.id : ''
          if (tabId !== '' && typeof closeTab === 'function') closeTab(tabId)
        } catch (error) {
          debugLog('closing the search tab failed', { message: String(error && error.message) })
        }
      }, [useTabInfo, closeTab])

      const order = useChat((snapshot) => snapshot.order)
      const nodeStore = useChat((snapshot) => snapshot.nodes)
      const running = useSession((snapshot) => snapshot.running)
      const hasMore = useSession((snapshot) => snapshot.hasMore)
      const loadingOlder = useSession((snapshot) => snapshot.loadingOlder)

      const [query, setQuery] = useState(() => storedQuery(sessionId))
      const [filters, setFilters] = useState(() => defaultFilters())
      const [filtersOpen, setFiltersOpen] = useState(false)
      const [scope, setScope] = useState('all')
      /* The row that was opened last (or that a global jump landed on): both lists mark it the same. */
      const [pickedAnchor, setPickedAnchor] = useState('')
      const [results, setResults] = useState(EMPTY_RESULTS)
      const [error, setError] = useState('')
      const [autoLoad, setAutoLoad] = useState(false)
      const inputRef = useRef(null)
      const bodyRef = useRef(null)
      const pagesRequested = useRef(0)
      const autoStarted = useRef(false)
      /* True while the query came from a global jump rather than from typing. */
      const mirrored = useRef(false)

      /* Focus the box when the header button opened (or re-revealed) this panel. */
      useEffect(() => {
        const focusNow = () => {
          const input = inputRef.current
          if (input === null) return
          input.focus()
          if (typeof input.select === 'function') input.select()
        }
        /* A shortcut asks "whatever panel is on screen" to focus; hidden panels skip themselves. */
        const focusVisible = () => {
          const input = inputRef.current
          if (input === null || input.offsetParent === null) return
          focusNow()
        }
        if (takePendingFocus(sessionId)) focusNow()
        if (takePendingFocus(null)) focusVisible()
        return onFocusRequest((target) => {
          if (target === sessionId) focusNow()
          else if (target === null) focusVisible()
        })
      }, [sessionId])

      /* The panel being on screen is the only acknowledgement a jump-requested open needs. */
      useEffect(() => {
        markPanelOpen(sessionId)
      }, [sessionId])

      /* A global jump mirrors itself here: same words, same window, same landing. */
      useEffect(() => {
        const apply = (request) => {
          if (request === undefined) return
          mirrored.current = true
          setQuery(request.query)
          storeQuery(sessionId, request.query)
          setScope(request.scope)
          /* Same window as the page that jumped, or the two trees would show different Turns. */
          if (request.filters !== null && request.filters !== undefined) setFilters(request.filters)
          /* The jump names the paragraph it landed on: mark that row once the results are in. */
          setPickedAnchor(typeof request.anchor === 'string' ? request.anchor : '')
        }
        apply(takePanelSearch(sessionId))
        return onPanelSearchRequest((target) => {
          if (target === sessionId) apply(takePanelSearch(sessionId))
        })
      }, [sessionId])

      /* The marker belongs to the search that produced it: a new query or a closed panel clears it. */
      const lastQuery = useRef(query)
      useEffect(() => {
        if (lastQuery.current === query) return
        lastQuery.current = query
        clearHighlight()
      }, [query])
      useEffect(() => () => clearHighlight(), [])

      /* Load the saved window once, then keep it in this Session only. */
      useEffect(() => {
        const controller = new AbortController()
        let cancelled = false
        fetchFilters(controller.signal).then(
          (next) => {
            if (!cancelled) setFilters((current) => (sameFilters(current, next) ? current : next))
          },
          () => {},
        )
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [])

      const filterSaveTimer = useRef(null)
      const applyFilters = useCallback((next) => {
        const normalized = normalizeFilters(next)
        setFilters((current) => (sameFilters(current, normalized) ? current : normalized))
        if (filterSaveTimer.current !== null) clearTimeout(filterSaveTimer.current)
        filterSaveTimer.current = setTimeout(() => {
          filterSaveTimer.current = null
          saveFilters(normalized)
        }, 400)
      }, [])
      useEffect(
        () => () => {
          if (filterSaveTimer.current !== null) clearTimeout(filterSaveTimer.current)
        },
        [],
      )

      /* Re-run the search on a short debounce: typing, new Turns, and a finished reply all land here. */
      useEffect(() => {
        const trimmed = query.trim()
        if (trimmed === '') {
          setResults(EMPTY_RESULTS)
          setError('')
          return undefined
        }
        const timer = setTimeout(() => {
          try {
            setResults(searchConversation(order, nodeStore, trimmed, filters, scope))
            setError('')
          } catch (failure) {
            console.error('[conversation-search] search failed', failure)
            setResults(EMPTY_RESULTS)
            setError(String((failure && failure.message) || failure))
          }
        }, SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [query, order, nodeStore, running, filters, scope])

      /* Searching a truncated window is a trap: page the rest in as soon as a query exists.
         A mirrored search deliberately skips this: the jump already loaded what it needed. */
      useEffect(() => {
        if (mirrored.current) return
        if (query.trim() === '' || !hasMore || autoLoad || loadingOlder) return
        if (autoStarted.current) return
        autoStarted.current = true
        pagesRequested.current = 0
        setAutoLoad(true)
      }, [query, hasMore, autoLoad, loadingOlder])

      /* Page in the rest of the log one slice at a time until nothing older is left. */
      useEffect(() => {
        if (!autoLoad) return undefined
        if (!hasMore) {
          setAutoLoad(false)
          return undefined
        }
        if (loadingOlder) return undefined
        const timer = setTimeout(() => {
          if (pagesRequested.current >= MAX_PAGE_REQUESTS) {
            setAutoLoad(false)
            setError(t('history.failed'))
            return
          }
          pagesRequested.current += 1
          if (!requestOlder()) {
            setAutoLoad(false)
            setError(t('history.failed'))
          }
        }, LOAD_PAGE_DELAY_MS)
        return () => clearTimeout(timer)
      }, [autoLoad, hasMore, loadingOlder, requestOlder, t])

      const onChange = useCallback(
        (event) => {
          const next = event.target.value
          /* Typing takes the search back from the jump that mirrored it. */
          mirrored.current = false
          setQuery(next)
          storeQuery(sessionId, next)
        },
        [sessionId],
      )

      const onClear = useCallback(() => {
        setQuery('')
        storeQuery(sessionId, '')
        const input = inputRef.current
        if (input !== null) input.focus()
      }, [sessionId])

      const onPick = useCallback(
        (item, words) => {
          if (!jumpToNode(item.key, words, item.anchor)) {
            setError(t('jump.missing'))
            return
          }
          setError('')
          setPickedAnchor(item.kind === 'file' ? '' : item.anchor)
        },
        [t],
      )

      const words = useMemo(() => normalizeWords(query), [query])

      const jumpFirst = useCallback(() => {
        const group = results.groups[0]
        if (group === undefined || group.items.length === 0) return
        onPick(group.items[0], words)
      }, [results, words, onPick])

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            jumpFirst()
            return
          }
          if (event.key === 'ArrowDown') {
            if (moveRowFocus(bodyRef.current, 1)) event.preventDefault()
            return
          }
          if (event.key === 'Escape') {
            /* Esc closes the panel, like every other dismissible surface. */
            event.preventDefault()
            event.stopPropagation()
            closeSelf()
          }
        },
        [closeSelf, jumpFirst],
      )

      const onListKeyDown = useCallback((event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        if (moveRowFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault()
      }, [])

      const total = results.groups.length
      const showBanner = hasMore

      let body
      if (query.trim() === '') {
        body = h(
          'div',
          { className: 'dsh-csearch-hint' },
          h('strong', null, t('hint.title')),
          h('span', null, t('hint.body')),
          h('span', { className: 'dsh-csearch-build' }, BUILD),
        )
      } else if (total === 0) {
        body = h(
          'div',
          { className: 'dsh-csearch-empty' },
          h('strong', null, t('empty.title')),
          h('span', null, t('empty.body')),
        )
      } else {
        body = h(
          'div',
          { className: 'dsh-csearch-results', 'data-loading': running ? 'true' : 'false' },
          h(
            'div',
            { className: 'dsh-csearch-summary' },
            h('span', null, t('summary', { turns: total, matches: results.matches })),
            h('span', { className: 'dsh-csearch-enter' }, t('panel.enter')),
          ),
          results.truncated ? h('div', { className: 'dsh-csearch-summary' }, t('truncated', { count: MAX_RESULTS })) : null,
          results.groups.map((group) =>
            h(
              'section',
              { className: 'dsh-csearch-group', key: 'turn:' + group.turn },
              h(
                'div',
                { className: 'dsh-csearch-group-head' },
                h('span', { className: 'dsh-csearch-turn' }, t('group.turn', { turn: group.turn })),
                h(
                  'span',
                  { className: 'dsh-csearch-question', title: group.question },
                  markSegments(segmentsOf(group.question === '' ? t('group.noQuestion') : group.question, words)),
                ),
              ),
              group.items.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    className: item.kind !== 'file' && anchorMatches(item.anchor, pickedAnchor)
                      ? 'dsh-csearch-item dsh-csearch-item--picked'
                      : 'dsh-csearch-item',
                    key: item.key + ':' + item.index,
                    'data-csearch-row': '',
                    title: t('jump.paraHint'),
                    onClick: () => onPick(item, words),
                  },
                  h(
                    'span',
                    { className: 'dsh-csearch-meta' },
                    h('span', null, t('role.' + item.role)),
                    h('span', null, item.kind === 'file' ? t('file.only') : t('para.index', { index: item.index })),
                    typeof item.hits === 'number' && item.hits > 1
                      ? h('span', { className: 'dsh-csearch-hits' }, t('global.paragraph.hits', { count: item.hits }))
                      : null,
                    h('span', { className: 'dsh-csearch-go', 'aria-hidden': 'true' }, '↗'),
                  ),
                  item.kind === 'file'
                    ? h(
                        'span',
                        { className: 'dsh-csearch-files' },
                        item.files.map((name) =>
                          h('span', { className: 'dsh-csearch-file', key: name, title: name }, markSegments(segmentsOf(name, words))),
                        ),
                      )
                    : h('span', { className: 'dsh-csearch-snippet' }, markSegments(item.segments)),
                ),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-csearch-root', onKeyDown },
        h(
          'div',
          { className: 'dsh-csearch-head' },
          h(
            'div',
            { className: 'dsh-csearch-field' },
            h(IconSearch, null),
            h('input', {
              ref: inputRef,
              className: 'dsh-csearch-input',
              value: query,
              placeholder: t('placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': t('placeholder'),
              onChange,
              onKeyDown,
            }),
            query === ''
              ? null
              : h('button', { type: 'button', className: 'dsh-csearch-clear', title: t('clear'), 'aria-label': t('clear'), onClick: onClear }, h(IconClose, null)),
          ),
          filterBarCompact(t, filters, applyFilters, filtersOpen, () => setFiltersOpen((current) => !current)),
          query.trim() === ''
            ? null
            : h(
                'div',
                { className: 'dsh-csearch-scopes', role: 'radiogroup', 'aria-label': t('panel.scope.label') },
                ['all', 'question', 'paragraph'].map((id) =>
                  h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'dsh-csearch-scope',
                      role: 'radio',
                      'aria-checked': scope === id,
                      onClick: () => setScope(id),
                    },
                    t('panel.scope.' + id),
                  ),
                ),
              ),
          showBanner
            ? h(
                'div',
                { className: 'dsh-csearch-banner' },
                h('span', null, t('history.missing')),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: autoLoad || loadingOlder,
                    onClick: () => {
                      pagesRequested.current = 0
                      setError('')
                      setAutoLoad(true)
                    },
                  },
                  autoLoad || loadingOlder
                    ? h(
                        'span',
                        { className: 'dsh-csearch-loading' },
                        h('span', { className: 'dsh-cg-spinner dsh-cg-spinner-sm', 'aria-hidden': 'true' }),
                        t('history.loading'),
                      )
                    : t('history.load'),
                ),
              )
            : null,
          error === '' ? null : h('div', { className: 'dsh-csearch-error' }, error),
        ),
        h('div', { className: 'dsh-csearch-body', ref: bodyRef, onKeyDown: onListKeyDown }, body),
      )
    }

    /** The left rail's page: scope chips, one query box, and the three-layer result tree. */
    function GlobalSearchPage(props) {
      const t = props.t
      const useSessions = props.useSessions
      const openTarget = props.openTarget
      const sessionIndex = useSessions((snapshot) => snapshot.byId)

      const [query, setQuery] = useState(() => globalMemory.query)
      const [scope, setScope] = useState(() => globalMemory.scope)
      const [status, setStatus] = useState(() => globalMemory.status)
      const [result, setResult] = useState(() => globalMemory.result)
      const [error, setError] = useState(() => globalMemory.error)
      const [expanded, setExpanded] = useState(() => defaultOpen(globalMemory.result))
      const [recent, setRecent] = useState(() => recentQueries.slice())
      const [filters, setFilters] = useState(() => defaultFilters())
      const [tick, setTick] = useState(0)
      const [refreshing, setRefreshing] = useState(false)
      /* The row whose jump is in flight: it spins in place, so feedback never depends on the overlay. */
      const [pendingRow, setPendingRow] = useState('')
      useEffect(() => onOpeningChange((snapshot) => {
        if (!snapshot.active) setPendingRow('')
      }), [])
      const abortRef = useRef(null)
      const inputRef = useRef(null)
      const bodyRef = useRef(null)
      const forceRefresh = useRef(false)
      const lastQuery = useRef(query)

      /* The marker belongs to the search that produced it: a new query clears it. */
      useEffect(() => {
        if (lastQuery.current === query) return
        lastQuery.current = query
        clearHighlight()
      }, [query])

      useEffect(() => {
        const trimmed = query.trim()
        if (trimmed === '') {
          setStatus('idle')
          setResult(null)
          setError('')
          globalMemory.status = 'idle'
          globalMemory.result = null
          globalMemory.error = ''
          return undefined
        }
        if (abortRef.current !== null) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const force = forceRefresh.current
        forceRefresh.current = false
        const timer = setTimeout(() => {
          setStatus('loading')
          fetchGlobalSearch(trimmed, scope, controller.signal, force, filters).then(
            (value) => {
              if (controller.signal.aborted) return
              /* The Host owns the persisted history; fall back to local memory if it has none. */
              if (Array.isArray(value.recent)) {
                recentQueries.length = 0
                recentQueries.push(...value.recent.filter((entry) => typeof entry === 'string'))
              } else {
                recordRecent(trimmed)
              }
              setRecent(recentQueries.slice())
              setResult(value)
              setStatus('ready')
              setRefreshing(false)
              setError('')
              setExpanded(defaultOpen(value))
              globalMemory.result = value
              globalMemory.status = 'ready'
              globalMemory.error = ''
            },
            (failure) => {
              if (controller.signal.aborted) return
              const message =
                failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
                  ? failure.message
                  : String(failure)
              setStatus('error')
              setRefreshing(false)
              setError(message)
              globalMemory.status = 'error'
              globalMemory.error = message
            },
          )
        }, GLOBAL_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [query, scope, tick, filters])

      /* Highlight the words the RESULTS matched, not what is being typed right now: typing must
         not rebuild the whole tree while the next request is in flight. */
      const resultWords = useMemo(() => {
        const source = result !== null && typeof result.query === 'string' ? result.query : query
        return normalizeWords(source)
      }, [result])

      const onChange = useCallback((event) => {
        const next = event.target.value
        setQuery(next)
        globalMemory.query = next
      }, [])

      const chooseScope = useCallback((id) => {
        setScope(id)
        globalMemory.scope = id
      }, [])

      const submit = useCallback(() => {
        setTick((value) => value + 1)
      }, [])

      const refresh = useCallback(() => {
        forceRefresh.current = true
        setRefreshing(true)
        setTick((value) => value + 1)
      }, [])

      /* The window is a preference: debounce the write so typing a date or a count is cheap. */
      const filterSaveTimer = useRef(null)
      const applyFilters = useCallback((next) => {
        const normalized = normalizeFilters(next)
        setFilters((current) => (sameFilters(current, normalized) ? current : normalized))
        if (filterSaveTimer.current !== null) clearTimeout(filterSaveTimer.current)
        filterSaveTimer.current = setTimeout(() => {
          filterSaveTimer.current = null
          saveFilters(normalized)
        }, 400)
      }, [])
      useEffect(
        () => () => {
          if (filterSaveTimer.current !== null) clearTimeout(filterSaveTimer.current)
        },
        [],
      )

      const pickRecent = useCallback((value) => {
        setQuery(value)
        globalMemory.query = value
      }, [])

      const expandAll = useCallback(() => {
        const sessions = result !== null && Array.isArray(result.sessions) ? result.sessions : []
        const next = new Set()
        for (const session of sessions) {
          next.add('s:' + session.id)
          for (const question of session.questions || []) next.add('q:' + session.id + ':' + question.seq)
        }
        setExpanded(next)
      }, [result])

      const collapseAll = useCallback(() => {
        setExpanded(new Set())
      }, [])

      const onListKeyDown = useCallback((event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        if (moveRowFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault()
      }, [])

      /* A search page opens ready to type. */
      useEffect(() => {
        const input = inputRef.current
        if (input !== null && typeof input.focus === 'function') input.focus()
      }, [])

      /* Warm the Host index in the background, so the first query is not the one paying for it. */
      useEffect(() => {
        if (warmStarted) return
        warmStarted = true
        postGlobal({ action: 'warm' }).catch(() => {})
      }, [])

      /* Pull the persisted history once; a failure keeps whatever memory already holds. */
      useEffect(() => {
        const controller = new AbortController()
        let cancelled = false
        fetchRecent(controller.signal).then(
          (list) => {
            if (cancelled) return
            recentQueries.length = 0
            recentQueries.push(...list)
            setRecent(recentQueries.slice())
          },
          () => {},
        )
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [])

      /* Pull the saved filter window once; a failure keeps the defaults. */
      useEffect(() => {
        const controller = new AbortController()
        let cancelled = false
        fetchFilters(controller.signal).then(
          (next) => {
            if (!cancelled) setFilters((current) => (sameFilters(current, next) ? current : next))
          },
          () => {},
        )
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [])

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
          if (event.key === 'ArrowDown') {
            if (moveRowFocus(bodyRef.current, 1)) {
              event.preventDefault()
              return
            }
          }
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation()
            setQuery('')
            globalMemory.query = ''
          }
        },
        [query, submit],
      )

      const toggle = useCallback((key) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      const titleOf = useCallback(
        (session) => {
          const known = sessionIndex === null || sessionIndex === undefined ? undefined : sessionIndex[session.id]
          if (known !== undefined && known !== null && typeof known.title === 'string' && known.title !== '') return known.title
          if (typeof session.displayTitle === 'string' && session.displayTitle !== '') return session.displayTitle
          if (typeof session.title === 'string' && session.title !== '') return session.title
          return t('global.untitled')
        },
        [sessionIndex, t],
      )

      const openSession = useCallback(
        (session) => {
          setPendingRow('s:' + session.id)
          openTarget(session.id, null, titleOf(session))
        },
        [openTarget, titleOf],
      )
      /* The panel mirrors this query after the jump: same words, same window, same landing. */
      const jumpQuery = result === null || typeof result.query !== 'string' ? '' : result.query
      const openQuestion = useCallback(
        (session, question) => {
          setPendingRow('q:' + session.id + ':' + question.seq)
          openTarget(
            session.id,
            {
              seq: question.seq,
              kind: 'question',
              words: resultWords,
              anchor: question.anchor,
              turn: question.number,
              query: jumpQuery,
              scope,
              filters,
            },
            titleOf(session),
          )
        },
        [openTarget, resultWords, titleOf, jumpQuery, scope, filters],
      )
      /* The row that was opened last stays marked, so coming back to this page shows where you went. */
      const [picked, setPicked] = useState(() => globalMemory.picked || '')
      const pickKey = (session, question, paragraph) => session.id + '|' + question.seq + '|' + paragraph.anchor
      const openParagraph = useCallback(
        (session, question, paragraph) => {
          setPendingRow(question.seq + ':' + paragraph.index)
          setPicked(pickKey(session, question, paragraph))
          globalMemory.picked = pickKey(session, question, paragraph)
          openTarget(
            session.id,
            {
              seq: paragraph.seq,
              kind: 'paragraph',
              words: resultWords,
              anchor: paragraph.anchor,
              paragraph: paragraph.anchor,
              index: paragraph.index,
              turn: paragraph.turn,
              query: jumpQuery,
              scope,
              filters,
            },
            titleOf(session),
          )
        },
        [openTarget, resultWords, titleOf, jumpQuery, scope, filters],
      )

      const paragraphRow = (session, question, paragraph) => {
        const files = Array.isArray(paragraph.outputFiles) ? paragraph.outputFiles : []
        const fileOnly = paragraph.kind === 'file'
        const segments = segmentsOf(typeof paragraph.text === 'string' ? paragraph.text : '', resultWords)
        return h(
          'button',
          {
            type: 'button',
            className: picked !== '' && picked === pickKey(session, question, paragraph) ? 'dsh-cg-para dsh-cg-para--picked' : 'dsh-cg-para',
            key: question.seq + ':' + paragraph.index,
            'data-csearch-row': '',
            title: t('jump.paraHint'),
            onClick: () => openParagraph(session, question, paragraph),
          },
          h(
            'span',
            { className: 'dsh-cg-para-meta' },
            h('span', null, fileOnly ? t('file.only') : t('global.paragraph.label', { index: paragraph.index })),
            typeof paragraph.hits === 'number' && paragraph.hits > 1
              ? h('span', { className: 'dsh-cg-para-hits' }, t('global.paragraph.hits', { count: paragraph.hits }))
              : null,
            pendingRow === question.seq + ':' + paragraph.index
              ? spinner('sm')
              : h('span', { className: 'dsh-cg-go', 'aria-hidden': 'true' }, '↗'),
          ),
          fileOnly
            ? h(
                'span',
                { className: 'dsh-cg-files' },
                files.map((name) =>
                  h('span', { className: 'dsh-cg-file', 'data-kind': 'out', key: name, title: name }, markSegments(segmentsOf(name, resultWords))),
                ),
              )
            : h('span', { className: 'dsh-cg-snippet' }, markSegments(segments)),
        )
      }

      const questionBlock = (session, question) => {
        const openKey = 'q:' + session.id + ':' + question.seq
        const open = expanded.has(openKey)
        const paragraphs = Array.isArray(question.paragraphs) ? question.paragraphs : []
        const inputFiles = Array.isArray(question.inputFiles) ? question.inputFiles : []
        const hidden = typeof question.paragraphTotal === 'number' ? question.paragraphTotal - paragraphs.length : 0
        const expandable = paragraphs.length > 0
        const label = h('span', { className: 'dsh-cg-q-tag' }, t('global.question.label', { number: question.number }))
        const text = h(
          'span',
          { className: 'dsh-cg-q-text', title: question.text },
          markSegments(segmentsOf(question.text === '' ? t('global.question.empty') : question.text, resultWords)),
        )
        const head = expandable
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-cg-question-toggle',
                'data-csearch-row': '',
                'aria-expanded': open,
                title: open ? t('collapse') : t('expand'),
                onClick: () => toggle(openKey),
              },
              pendingRow === 'q:' + session.id + ':' + question.seq
                ? spinner('sm')
                : h(IconCaret, { className: 'dsh-cg-caret', open }),
              label,
              text,
            )
          : h(
              'div',
              { className: 'dsh-cg-question-toggle', 'data-csearch-row': '' },
              h('span', { className: 'dsh-cg-caret-space' }),
              label,
              text,
            )
        return h(
          'div',
          { className: 'dsh-cg-question', key: openKey },
          h(
            'div',
            { className: 'dsh-cg-question-row' },
            head,
            hidden > 0 ? h('span', { className: 'dsh-cg-hits' }, t('global.paragraph.more', { count: hidden })) : null,
            expandable
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cg-jump-btn',
                    title: t('jump.paraHint'),
                    onClick: () => openQuestion(session, question),
                  },
                  '↗ ',
                  t('jump.label'),
                ),
          ),
          inputFiles.length === 0
            ? null
            : h(
                'div',
                { className: 'dsh-cg-paras' },
                h(
                  'span',
                  { className: 'dsh-cg-files' },
                  inputFiles.map((name) =>
                    h(
                      'span',
                      { className: 'dsh-cg-file', 'data-kind': 'in', key: name, title: t('global.file.input') + ': ' + name },
                      t('global.file.input') + ': ',
                      markSegments(segmentsOf(name, resultWords)),
                    ),
                  ),
                ),
              ),
          open && expandable
            ? h('div', { className: 'dsh-cg-paras' }, paragraphs.map((paragraph) => paragraphRow(session, question, paragraph)))
            : null,
        )
      }

      const sessionBlock = (session) => {
        const openKey = 's:' + session.id
        const open = expanded.has(openKey)
        const title = titleOf(session)
        const path = displayPath(session.cwd)
        const questions = Array.isArray(session.questions) ? session.questions : []
        const canExpand = questions.length > 0
        let hits = session.matched ? 1 : 0
        for (const question of questions) {
          if (question.matched) hits += 1
          for (const paragraph of question.paragraphs || []) hits += typeof paragraph.hits === 'number' && paragraph.hits > 0 ? paragraph.hits : 1
        }
        return h(
          'section',
          { className: 'dsh-cg-session', key: session.id, 'data-open': open ? 'true' : 'false' },
          h(
            'div',
            { className: 'dsh-cg-session-top' },
            canExpand
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cg-toggle',
                    'data-csearch-row': '',
                    'aria-expanded': open,
                    title: open ? t('collapse') : t('expand'),
                    onClick: () => toggle(openKey),
                  },
                  pendingRow === 's:' + session.id
                    ? spinner('sm')
                    : h(IconCaret, { className: 'dsh-cg-caret', open }),
                  h('span', { className: 'dsh-cg-session-title', title }, markSegments(segmentsOf(title, resultWords))),
                )
              : h(
                  'div',
                  { className: 'dsh-cg-toggle', 'data-csearch-row': '' },
                  h('span', { className: 'dsh-cg-caret-space' }),
                  h('span', { className: 'dsh-cg-session-title', title }, markSegments(segmentsOf(title, resultWords))),
                ),
            hits > 0 ? h('span', { className: 'dsh-cg-hits' }, t('global.resultCount', { count: hits })) : null,
            h('button', { type: 'button', className: 'dsh-cg-open', onClick: () => openSession(session) }, t('open')),
          ),
          h(
            'div',
            { className: 'dsh-cg-session-sub' },
            path === '' ? null : h('span', { className: 'dsh-cg-path', title: session.cwd }, path),
            path === '' ? null : h('span', { className: 'dsh-cg-dot' }),
            h(
              'span',
              null,
              t('global.session.counts', { questions: session.questionTotal, paragraphs: session.paragraphTotal }),
            ),
          ),
          open && canExpand ? h('div', { className: 'dsh-cg-questions' }, questions.map((question) => questionBlock(session, question))) : null,
        )
      }

      const stats = result !== null && result.stats !== null && typeof result.stats === 'object' ? result.stats : null
      const sessions = result !== null && Array.isArray(result.sessions) ? result.sessions : []

      /* One element tree per (result, expansion): status pulses and typing never rebuild it. */
      const tree = useMemo(
        () => (result === null ? null : (Array.isArray(result.sessions) ? result.sessions : []).map((session) => sessionBlock(session))),
        [result, expanded, resultWords, openTarget],
      )

      let body
      if (query.trim() === '' || status === 'idle') {
        body = h(
          'div',
          { className: 'dsh-cg-state' },
          h('strong', null, t('global.idle')),
          h('span', null, t('global.firstIndex')),
          recent.length === 0
            ? null
            : h(
                'div',
                { className: 'dsh-cg-recent' },
                h('span', { className: 'dsh-cg-recent-label' }, t('global.recent')),
                recent.map((entry) =>
                  h('button', { type: 'button', className: 'dsh-cg-recent-item', key: entry, onClick: () => pickRecent(entry) }, entry),
                ),
              ),
        )
      } else if (status === 'error' && result === null) {
        body = h(
          'div',
          { className: 'dsh-cg-state' },
          h('strong', null, t('global.error')),
          h('span', { className: 'dsh-cg-error-text' }, error),
          h('button', { type: 'button', className: 'dsh-cg-submit', onClick: submit }, t('global.retry')),
        )
      } else if (result === null) {
        body = h(
          'div',
          { className: 'dsh-cg-state dsh-cg-state--row' },
          spinner(),
          h('span', null, t('global.loading')),
        )
      } else if (sessions.length === 0) {
        body = h(
          'div',
          { className: 'dsh-cg-state' },
          h('strong', null, t('global.empty')),
          h('span', null, t('global.emptyBody')),
          scope === 'all'
            ? null
            : h('button', { type: 'button', className: 'dsh-cg-submit', onClick: () => chooseScope('all') }, t('global.widen')),
        )
      } else {
        body = h(
          'div',
          { className: 'dsh-cg-tree', 'data-loading': status === 'loading' ? 'true' : 'false' },
          tree,
        )
      }

      return h(
        'div',
        { className: 'dsh-cg-page' },
        refreshing
          ? h(
              'div',
              { className: 'dsh-cg-pill', role: 'status', 'aria-live': 'polite' },
              spinner(),
              h('div', { className: 'dsh-cg-mask-text' }, h('strong', null, t('global.refreshing'))),
            )
          : null,
        h(
          'div',
          { className: 'dsh-cg-head' },
          h('h1', { className: 'dsh-cg-title' }, t('global.title'), h('span', { className: 'dsh-cg-build' }, BUILD)),
          h('p', { className: 'dsh-cg-sub' }, t('global.subtitle')),
        ),
        h(
          'div',
          { className: 'dsh-cg-bar' },
          h(
            'div',
            { className: 'dsh-cg-row' },
            h(
              'div',
              { className: 'dsh-cg-field' },
              h(IconSearch, null),
              h('input', {
                ref: inputRef,
                className: 'dsh-cg-input',
                value: query,
                placeholder: t('global.placeholder'),
                spellCheck: false,
                autoComplete: 'off',
                'aria-label': t('global.placeholder'),
                onChange,
                onKeyDown,
              }),
              query === ''
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-cg-clear',
                      title: t('clear'),
                      'aria-label': t('clear'),
                      onClick: () => {
                        setQuery('')
                        globalMemory.query = ''
                        const input = inputRef.current
                        if (input !== null && typeof input.focus === 'function') input.focus()
                      },
                    },
                    h(IconClose, null),
                  ),
            ),
            h('button', { type: 'button', className: 'dsh-cg-submit', disabled: query.trim() === '', onClick: submit }, t('global.search')),
          ),
          h(
            'div',
            { className: 'dsh-cg-scopes', role: 'radiogroup', 'aria-label': t('global.scope.label') },
            h('span', { className: 'dsh-cg-scope-label' }, t('global.scope.label')),
            SCOPES.map((option) =>
              h(
                'button',
                {
                  type: 'button',
                  key: option.id,
                  className: 'dsh-cg-scope',
                  role: 'radio',
                  'aria-checked': scope === option.id,
                  onClick: () => chooseScope(option.id),
                },
                t(option.label),
              ),
            ),
          ),
          filterBarWide(t, filters, applyFilters),
        ),
        h(
          'div',
          { className: 'dsh-cg-body', ref: bodyRef, onKeyDown: onListKeyDown },
          stats === null
            ? null
            : h(
                'div',
                { className: 'dsh-cg-stats' },
                h(
                  'span',
                  { className: 'dsh-cg-stats-text' },
                  t('global.stats', {
                    sessions: stats.sessions,
                    questions: stats.questions,
                    paragraphs: stats.paragraphs,
                    ms: stats.tookMs,
                  }),
                ),
                h('span', { className: 'dsh-cg-stats-text' }, t('global.indexed', { count: stats.indexed })),
                /* Debug only: the numbers the next performance round has to move. */
                debugEnabled()
                  ? h('span', { className: 'dsh-cg-stats-text' }, `build ${stats.buildMs || 0}ms · match ${stats.matchMs || 0}ms · jump ${jumpTiming.lastMs}ms`)
                  : null,
                h('span', { className: 'dsh-cg-stats-text' }, t('global.scopeHint.' + scope)),
                h('span', { className: 'dsh-cg-stats-text' }, filtersSummary(t, filters)),
                status === 'loading' && !refreshing
                  ? h('span', { className: 'dsh-cg-pulse' }, spinner('sm'), t('global.loading'))
                  : null,
                stats.truncated ? h('span', { className: 'dsh-cg-stats-text' }, t('global.truncated', { count: stats.sessions })) : null,
                sessions.length === 0
                  ? null
                  : h(
                      'span',
                      { className: 'dsh-cg-stats-actions' },
                      h('button', { type: 'button', className: 'dsh-cg-link', onClick: refresh }, t('global.refresh')),
                      h('button', { type: 'button', className: 'dsh-cg-link', onClick: expandAll }, t('expandAll')),
                      h('button', { type: 'button', className: 'dsh-cg-link', onClick: collapseAll }, t('collapseAll')),
                    ),
              ),
          stats === null || sessions.length === 0 ? null : h('div', { className: 'dsh-cg-legend' }, t('global.legend')),
          body,
        ),
      )
    }

    /** The frame-wide transition mask shown while a chosen Session opens. */
    function OpeningMask(props) {
      const t = props.t
      const [state, setState] = useState(openingSnapshot)

      useEffect(() => onOpeningChange((next) => setState(next)), [])

      if (!state.active) return null
      const heading = state.turn === null ? t('opening.title') : t('jump.title', { turn: state.turn })
      return h(
        'div',
        { className: 'dsh-cg-jump', role: 'status', 'aria-live': 'polite' },
        spinner(),
        h(
          'div',
          { className: 'dsh-cg-mask-text' },
          h('strong', null, heading),
          h('span', { className: 'dsh-cg-mask-sub', title: state.title }, state.title === '' ? t('jump.hint') : state.title),
        ),
      )
    }

    /** Ends the transition once the Session it announced is actually open. */
    function OpeningWatcher(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const openState = useSession((snapshot) => snapshot.openState)
      const [token, setToken] = useState(0)

      useEffect(() => onOpeningChange(() => setToken((value) => value + 1)), [])

      useEffect(() => {
        if (!isOpening(sessionId)) return
        if (openState === 'error') {
          endOpening()
          return
        }
        /* A jump owns the mask until it lands: the Session opening is only half the trip. */
        if (openState === 'open' && !pendingJumps.has(sessionId)) endOpening()
      }, [sessionId, openState, token])

      return null
    }

    /**
     * Opens the search panel once the Session a jump asked for is actually open.
     *
     * `openSearchTab` is called right after `openSession`, but a cross-Session switch can remount
     * the sidebar after that call and drop the tab; this seat re-issues the request at the moment
     * the target Session reports `open`.
     */
    function PanelOpener(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const openPanel = props.openPanel
      const openState = useSession((snapshot) => snapshot.openState)

      useEffect(() => {
        if (openState !== 'open') return
        const until = panelOpenWanted(sessionId)
        if (until === 0) return
        openPanel(until)
      }, [sessionId, openState, openPanel])

      return null
    }

    /** Drives one pending cross-Session jump once its Session finishes loading. */
    function JumpRunner(props) {
      const sessionId = props.sessionId
      const requestThroughSeq = props.requestThrough
      const useChat = props.useChat
      const useSession = props.useSession
      const order = useChat((snapshot) => snapshot.order)
      const nodes = useChat((snapshot) => snapshot.nodes)
      const hasMore = useSession((snapshot) => snapshot.hasMore)
      const [request, setRequest] = useState(0)
      const orderRef = useRef(order)
      const nodesRef = useRef(nodes)
      const hasMoreRef = useRef(hasMore)
      orderRef.current = order
      nodesRef.current = nodes
      hasMoreRef.current = hasMore

      /* A jump asked for while this Session is already on screen still needs a turn. */
      useEffect(() => onJumpRequest((target) => {
        if (target === sessionId) setRequest((value) => value + 1)
      }), [sessionId])

      useEffect(() => {
        if (!pendingJumps.has(sessionId)) return undefined
        let cancelled = false
        let timer = null
        const finish = () => {
          pendingJumps.delete(sessionId)
          endOpening()
        }
        const tick = () => {
          if (cancelled) return
          const pending = pendingJumps.get(sessionId)
          if (pending === undefined) return
          pending.tries += 1
          if (pending.tries > 60 || Date.now() - pending.at > 20_000) {
            finish()
            return
          }
          /* The nearest-node fallback is only safe once nothing older can still arrive. */
          const allowNearest = hasMoreRef.current === false || pending.tries > 20
          const target = resolveJump(orderRef.current, nodesRef.current, pending, allowNearest)
          if (target !== null && jumpToNode(target.key, pending.words, pending.paragraph)) {
            finish()
            return
          }
          if (pending.tries === 1 || pending.tries % 8 === 0) requestThroughSeq(pending.seq)
          /* Poll tightly right after opening: the first rows usually land within a frame or two. */
          timer = setTimeout(tick, pending.tries <= 3 ? 60 : 120)
        }
        tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId, requestThroughSeq, request])

      return null
    }

    // #endregion

    /** Package-owned stylesheet, removed with the plugin run. */
    function insertStyles() {
      /* A hot reload replaces this module but not the DOM: drop a box layer a previous run left. */
      try {
        for (const stale of document.querySelectorAll('.dsh-csearch-highlight-layer')) stale.remove()
      } catch (error) {
        /* No document to sweep. */
      }
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = TAB_ID
      tag.textContent = CSS + '\n' + CSS_RESULTS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'conversation-search: dictionaries')
      ctx.effect(() => insertStyles(), 'conversation-search: styles')
      ctx.effect(() => installProbe(), 'conversation-search: probe')
      /* A reader scrolling right after a jump takes over: the landing replays stop moving the view. */
      ctx.effect(() => registerUserScrollWatch(), 'conversation-search: scroll watch')
      ctx.effect(() => registerFindShortcut(ctx, t, () => openSearchTab(ctx, null)), 'conversation-search: find shortcut')

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: TAB_KIND,
                order: 15,
                locale: NS,
                inject: (sessionId) => ({ openSearch: () => openSearchTab(ctx, sessionId) }),
              },
              SearchButton,
            ),
          ),
        'conversation-search: header button',
      )

      /* The left rail entry and the page it opens: the icon's id addresses the `main` key. */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 5,
                label: () => t('global.title'),
                locale: NS,
              },
              GlobalSearchIcon,
            ),
          ),
        'conversation-search: global panel icon',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ openTarget: (sessionId, jump, title) => openSearchTarget(ctx, sessionId, jump, title) }),
              },
              GlobalSearchPage,
            ),
          ),
        'conversation-search: global panel',
      )

      /* The frame-wide transition mask: it must outlive the page it was started from. */
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'conversation-search:opening', locale: NS }, OpeningMask),
          ),
        'conversation-search: opening mask',
      )

      /* A headless seat that performs one pending jump after its Session has loaded. */
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: TAB_ID + ':jump',
                order: 900,
                inject: (sessionId) => ({ requestThrough: (seq) => requestThrough(ctx, sessionId, seq) }),
              },
              JumpRunner,
            ),
          ),
        'conversation-search: jump runner',
      )

      /* Ends the opening transition for the Session that was asked for. */
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              { name: 'conversation.session.header.utilities', id: TAB_ID + ':open', order: 901 },
              OpeningWatcher,
            ),
          ),
        'conversation-search: opening watcher',
      )

      /* Re-issues a jump-requested panel open once the target Session is actually open. */
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: TAB_ID + ':panel',
                order: 902,
                inject: (sessionId) => ({ openPanel: (until) => openSearchTab(ctx, sessionId, { focus: false, until }) }),
              },
              PanelOpener,
            ),
          ),
        'conversation-search: panel opener',
      )

      /* Wait for the tab registry itself: the right sidebar declares its slot before it provides
         the registry, and a slot-triggered registration would read it as missing for good. */
      ctx.effect(() => {
        const seat = ctx.inject(['sidebarRightTabs'], (injected) => {
          const tabs = injected.get('sidebarRightTabs')
          if (!tabs || typeof tabs.register !== 'function') return
          ctx.effect(() => {
            const disposers = []
            try {
              disposers.push(
                tabs.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  priority: 'extension',
                  title: () => t('tab.title'),
                }),
              )
              disposers.push(
                ctx.slots.inject('sidebar.right.pane.tab', () =>
                  ctx.slots.register(
                    {
                      name: 'sidebar.right.pane.tab',
                      key: TAB_ID,
                      locale: NS,
                      inject: (sessionId) => ({
                        requestOlder: () => loadOlderPage(ctx, sessionId),
                        /* Esc closes the tab itself: the seat's own close path, not a simulated click. */
                        closeTab: (tabId) => {
                          const sidebar = ctx.get('sidebarRight')
                          if (sidebar !== undefined && sidebar !== null && typeof sidebar.closeIn === 'function') {
                            sidebar.closeIn(sessionId, tabId)
                          }
                        },
                      }),
                    },
                    SearchPanel,
                  ),
                ),
              )
              disposers.push(
                ctx.slots.inject('sidebar.right.pane.tab.title', () =>
                  ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, SearchTitle),
                ),
              )
            } catch (error) {
              console.error('[conversation-search] registering the sidebar tab failed', error)
              for (const dispose of disposers.reverse()) {
                try {
                  dispose()
                } catch (releaseError) {
                  console.error('[conversation-search] releasing a registration failed', releaseError)
                }
              }
              return
            }
            return () => {
              for (const dispose of disposers.reverse()) {
                try {
                  dispose()
                } catch (error) {
                  console.error('[conversation-search] releasing a registration failed', error)
                }
              }
            }
          }, 'conversation-search: sidebar tab')
        })
        return () => {
          try {
            seat.dispose()
          } catch (error) {
            console.error('[conversation-search] disposing the tab seat failed', error)
          }
        }
      }, 'conversation-search: tab type')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      build: BUILD,
      highlight: HIGHLIGHT,
    }
  },
})
