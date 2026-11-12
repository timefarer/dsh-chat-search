/**
 * Headless smoke test for the dsh-chat-search client module.
 *
 * Loads client.js with a minimal React hook runtime and a fake Cordis context, then
 * exercises the real components: the sidebar panel (registration, search, grouping) and the
 * global page (registrations, scope chips, result tree, click-through).
 *
 * Run: node test/client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'client.js')
const code = fs.readFileSync(file, 'utf8')

let moduleDef = null
globalThis.window = { __ModuleLoader__: { load: (def) => { moduleDef = def } } }
new Function('window', code)(globalThis.window)

// #region minimal DOM ----------------------------------------------------------

globalThis.document = {
  baseURI: 'http://dsh.test/',
  head: { appendChild() {} },
  body: {},
  documentElement: {},
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ top: 0, height: 0 }) }),
  createTreeWalker: () => ({ nextNode: () => null }),
  querySelectorAll: () => [],
}
globalThis.NodeFilter = { SHOW_TEXT: 4 }

// #endregion

// #region minimal React runtime ------------------------------------------------

const states = new Map()
const refs = new Map()
const memos = new Map()
const effectDeps = new Map()
const cleanups = new Map()
let hooks = []
let hookIndex = 0
let dirty = false
let instance = 'default'

const shallowEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length > 0) merged.children = children
    return { type, props: merged, key: merged.key === undefined ? null : merged.key }
  },
  useState(initial) {
    const key = instance + '#' + hookIndex++
    if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial)
    return [
      states.get(key),
      (value) => {
        const next = typeof value === 'function' ? value(states.get(key)) : value
        if (!Object.is(next, states.get(key))) {
          states.set(key, next)
          dirty = true
        }
      },
    ]
  },
  useRef(value) {
    const key = instance + '#' + hookIndex++
    if (!refs.has(key)) refs.set(key, { current: value })
    return refs.get(key)
  },
  useMemo(factory, deps) {
    const key = instance + '#' + hookIndex++
    const previous = memos.get(key)
    if (previous === undefined || !shallowEqual(previous.deps, deps)) {
      const value = factory()
      memos.set(key, { deps, value })
      return value
    }
    return previous.value
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
  useEffect(fn, deps) {
    hooks.push({ key: instance + '#' + hookIndex++, fn, deps })
  },
}

function renderComponent(name, Component, props) {
  instance = name
  hooks = []
  hookIndex = 0
  const tree = Component(props)
  for (const hook of hooks) {
    const previous = effectDeps.get(hook.key)
    if (previous !== undefined && shallowEqual(previous, hook.deps)) continue
    const cleanup = cleanups.get(hook.key)
    if (typeof cleanup === 'function') cleanup()
    const result = hook.fn()
    cleanups.set(hook.key, typeof result === 'function' ? result : undefined)
    effectDeps.set(hook.key, hook.deps)
  }
  return tree
}

/** Render, flush timers, and re-render until no state changed. */
async function settle(name, Component, props) {
  let tree = null
  for (let round = 0; round < 12; round += 1) {
    tree = renderComponent(name, Component, props)
    const changed = dirty
    dirty = false
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (!changed) {
      tree = renderComponent(name, Component, props)
      break
    }
  }
  dirty = false
  return tree
}

// #endregion

// #region fixtures -------------------------------------------------------------

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

const userNode = (key, turn, text, files, at) => ({
  key,
  kind: 'user',
  anchorSeq: 1,
  location: { kind: 'turn', turn: { turn, status: 'closed', start: { time: typeof at === 'number' ? at : NOW } } },
  data: {
    content: [
      { type: 'text', text },
      ...(files || []).map((name) => ({ type: 'file', attachment: { kind: 'file', name } })),
    ],
  },
})

const assistantNode = (key, turn, blocks, at) => ({
  key,
  kind: 'assistant-step',
  anchorSeq: 2,
  location: { kind: 'step', turn: { turn, status: 'closed', start: { time: typeof at === 'number' ? at : NOW } }, step: 1 },
  data: { step: 1, blocks },
})

const nodes = new Map()
const order = []
function add(node) {
  order.push(node.key)
  nodes.set(node.key, node)
}

add(userNode('n1', 1, '帮我把右侧边栏的宽度调整一下，并让文件树默认展开。', ['notes.md']))
add(
  assistantNode('n2', 1, [
    { kind: 'reasoning', text: '先看宽度变量，再看文件树的展开状态。' },
    { kind: 'text', text: '我已经调整了侧边栏宽度。\n\n具体做法是修改 sb-width 变量，并缓存用户偏好。\n\n另外文件树会默认展开。' },
    { kind: 'tool-call', name: 'write', callId: 'c1', argsRaw: '{"file_path":"src/sb.css"}' },
  ]),
)
/* A second reply message inside Turn 1: paragraph numbers must continue, not restart. */
add(assistantNode('n2b', 1, [{ kind: 'text', text: '补记一句话：那次改动之后没有回退。' }]))
add(userNode('n3', 2, '再来一次侧边栏宽度的调整，这次要记住上次的值。'))
add(
  assistantNode('n4', 2, [
    { kind: 'text', text: '侧边栏宽度现在会持久化了。' },
    { kind: 'text', text: '这一段落与搜索词无关。' },
  ]),
)
/* An old Turn: the default window must leave it out. */
const OLD = NOW - 40 * DAY
add(userNode('n5', 3, '这是远古标记的那一轮提问。', undefined, OLD))
add(assistantNode('n6', 3, [{ kind: 'text', text: '远古标记的回复内容在这里。' }], OLD))

const chatSnapshot = { order, nodes }
const sessionSnapshot = { running: false, hasMore: false, loadingOlder: false }
const useChat = (selector) => selector(chatSnapshot)
const useSession = (selector) => selector(sessionSnapshot)

// #endregion

// #region fake Cordis context --------------------------------------------------

const zh = {
  'action.open': '检索当前对话',
  'tab.title': '对话检索',
  'placeholder': '输入关键词',
  'hint.title': '检索当前对话',
  'hint.body': '说明',
  'empty.title': '没有匹配的内容',
  'empty.body': '换个关键词',
  'group.turn': '第 {turn} 轮',
  'group.noQuestion': '（无提问文本）',
  'role.user': '提问',
  'role.assistant': '回复',
  'para.index': '第 {index} 段',
  'summary': '{turns} 组 · {matches} 条结果',
  'truncated': '仅显示前 {count} 条',
  'history.missing': '更早的历史尚未加载',
  'history.load': '加载全部',
  'history.loading': '加载中…',
  'history.failed': '无法加载',
  'jump.missing': '尚未加载',
  'clear': '清空',
  'global.title': '全局搜索',
  'global.placeholder': '搜索所有会话',
  'global.subtitle': '副标题',
  'global.scope.label': '检索范围',
  'global.scope.all': '会话 + 问题 + 段落',
  'global.scope.sessionQuestion': '会话 + 问题',
  'global.scope.session': '仅会话',
  'global.scope.question': '仅问题',
  'global.scope.paragraph': '仅段落',
  'global.scopeHint.all': '任一命中',
  'global.scopeHint.session': '只匹配会话标题',
  'global.search': '搜索',
  'global.idle': '输入关键词开始全局检索',
  'global.loading': '检索中…',
  'global.empty': '没有匹配的内容',
  'global.emptyBody': '换个关键词',
  'global.error': '检索失败',
  'global.retry': '重试',
  'global.stats': '{sessions} 个会话 · {questions} 个问题 · {paragraphs} 个段落 · {ms}ms',
  'global.indexed': '已索引 {count} 个会话',
  'global.truncated': '仅显示前 {count} 个会话',
  'global.untitled': '（无标题会话）',
  'global.session.matched': '标题命中',
  'global.session.counts': '{questions} 问 · {paragraphs} 段',
  'global.session.open': '打开会话',
  'filters.label': '筛选',
  'filters.since': '开始',
  'filters.until': '结束',
  'filters.turns': '最近轮次',
  'filters.unlimited': '不限',
  'filters.reset': '重置',
  'filters.summary.range': '{since} ~ {until}',
  'filters.summary.turns': '最近 {count} 轮',
  'filters.summary.all': '全部范围',
  'panel.scope.label': '检索范围',
  'panel.scope.all': '全部',
  'panel.scope.question': '仅问题',
  'panel.scope.paragraph': '仅段落',
  'jump.title': '正在跳到第 {turn} 轮…',
  'jump.hint': '正在定位并高亮命中内容',
  'jump.label': '跳转',
  'jump.paraHint': '跳到这一段并高亮命中内容',
  'global.legend': '▾ 展开 / 收起 　 ↗ 点击跳到该段落并高亮',
  'global.refreshing': '正在重建索引…',
  'expand': '展开',
  'collapse': '收起',
  'global.question.label': '第 {number} 轮',
  'global.question.matched': '问题命中',
  'global.question.empty': '（无提问文本）',
  'global.paragraph.label': '第 {index} 段',
  'global.paragraph.hits': '{count} 处',
  'global.paragraph.more': '还有 {count} 段未显示',
  'global.file.input': '输入',
  'global.file.output': '输出',
  'global.jumpFailed': '尚未加载',
  'global.resultCount': '{count} 处命中',
  'global.question.jump': '跳到该问题',
  'open': '打开',
  'expandAll': '全部展开',
  'collapseAll': '全部收起',
  'panel.enter': '回车跳到第一条',
  'opening.title': '正在打开会话…',
  'opening.tip': '历史较长时需要一点时间',
  'file.only': '文件',
  'global.refresh': '刷新索引',
  'global.widen': '在全部范围中搜索',
  'global.recent': '最近搜索',
  'global.firstIndex': '首次检索需要建立索引',
}
const t = (key, params) => {
  const text = zh[key] === undefined ? key : zh[key]
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params && params[name] !== undefined ? params[name] : ''))
}

const registrations = []
let tabDefinition = null
const openedSessions = []
const openedTabs = []
const shortcutDefinitions = []
const services = {
  sidebarRightTabs: {
    register: (definition) => {
      tabDefinition = definition
      return () => {}
    },
    get: (kind) => (tabDefinition !== null && tabDefinition.kind === kind ? tabDefinition : undefined),
  },
  sidebarRight: {
    openTabIn(kind) {
      openedTabs.push(kind)
    },
    openTab(kind) {
      openedTabs.push(kind)
    },
  },
  sessions: { binding: () => ({ session: { loadOlder() {} } }) },
  uiWorkspace: {
    openSession(id) {
      openedSessions.push(id)
    },
  },
  layout: { selectPanel() {} },
  shortcuts: {
    register(definition) {
      shortcutDefinitions.push(definition)
      return () => {}
    },
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(deps, callback) {
    callback({ get: (name) => services[name] })
    return { dispose() {} }
  },
  get: (name) => services[name],
  slots: {
    inject(name, callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, Component) {
      registrations.push({ name: options.name, options, Component })
      return () => {}
    },
  },
  locale: { register: () => () => {}, bind: () => t },
}

// #endregion

// #region canned Host response ------------------------------------------------

const opened = []
let lastSearchBody = null
globalThis.fetch = async (url, init) => {
  const body = init === undefined || init.body === undefined ? {} : JSON.parse(init.body)
  if (body.action === 'search') lastSearchBody = body
  const query = typeof body.query === 'string' ? body.query : ''
  const value = {
    query,
    scope: body.scope || 'all',
    sessions: [
      {
        id: 's1',
        title: '侧边栏宽度调整',
        cwd: 'C:/work/demo',
        createdAt: 1000,
        matched: true,
        questionTotal: 2,
        paragraphTotal: 2,
        questions: [
          {
            seq: 1,
            number: 1,
            anchor: '帮我把右侧边栏的宽度调整一下',
            text: '帮我把右侧边栏的宽度调整一下',
            matched: true,
            inputFiles: ['notes.md'],
            paragraphTotal: 2,
            paragraphs: [
              {
                seq: 2,
                index: 1,
                turn: 1,
                kind: 'text',
                anchor: '我已经调整了侧边栏宽度。',
                text: '我已经调整了侧边栏宽度。',
                hits: 2,
                matched: true,
                textMatched: true,
                outputFiles: [],
                matchedFiles: [],
              },
              {
                seq: 2,
                index: 2,
                turn: 1,
                kind: 'file',
                anchor: 'sb.css',
                text: '',
                hits: 1,
                matched: true,
                textMatched: false,
                outputFiles: ['sb.css'],
                matchedFiles: ['sb.css'],
              },
            ],
          },
        ],
      },
    ],
    stats: { sessions: 1, questions: 1, paragraphs: 1, indexed: 3, truncated: false, tookMs: 7 },
    recent: body.action === 'recent' ? ['侧边栏'] : query === '' ? [] : [query],
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
}

// #endregion

// #region helpers --------------------------------------------------------------

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label + (detail === undefined ? '' : ' — ' + detail))
}

/** Depth-first search for an element with one class name, arrays included. */
function findNode(node, className) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, className)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.props && node.props.className === className) return node
  if (node.props && node.props.children !== undefined) return findNode(node.props.children, className)
  return null
}

/** Every node with exactly this className, in tree order. */
function findAll(node, className, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, className, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.props && node.props.className === className) out.push(node)
  if (node.props && node.props.children !== undefined) findAll(node.props.children, className, out)
  return out
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
  return out
}

// #endregion

// #region run ------------------------------------------------------------------

if (moduleDef === null) {
  console.error('FAIL: the module did not call window.__ModuleLoader__.load')
  process.exit(1)
}
if (moduleDef.id !== 'dsh-chat-search') {
  console.error('FAIL: module id mismatch:', moduleDef.id)
  process.exit(1)
}

const plugin = moduleDef.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

/* The UI badge and the manifest must never drift apart. */
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
if (plugin.build !== 'v' + manifest.version) {
  console.error('FAIL: build badge', plugin.build, '!= manifest version', manifest.version)
  process.exit(1)
}

/* The CSS selector and the registry key must agree, or the native highlight silently paints nothing. */
const highlightRule = code.match(/::highlight\(([^)]+)\)/)
if (highlightRule === null || highlightRule[1] !== plugin.highlight) {
  console.error('FAIL: ::highlight() selector', highlightRule && highlightRule[1], '!= highlight name', plugin.highlight)
  process.exit(1)
}

/* Keyword marks and the arrival marker share one amber, distinct from every row background. */
if (!/::highlight\(dsh-chat-search\)\{[^}]*rgba\(255,\s*199,\s*0/.test(code)) {
  console.error('FAIL: the native highlight is not amber')
  process.exit(1)
}
if (!/\.dsh-cg-page mark\{[^}]*rgba\(255,\s*199,\s*0/.test(code)) {
  console.error('FAIL: page keyword marks are not amber')
  process.exit(1)
}
/* The landed paragraph is blue, so it never reads as a keyword hit. */
if (!/::highlight\(dsh-chat-search-selected\)\{[^}]*rgba\(74,\s*144,\s*255/.test(code)) {
  console.error('FAIL: the paragraph selection is not blue')
  process.exit(1)
}
if (!/\[data-dsh-csearch-selected\]/.test(code)) {
  console.error('FAIL: the no-Highlight-API selection fallback is missing')
  process.exit(1)
}

plugin.apply(ctx)

const byName = (name) => registrations.filter((entry) => entry.name === name)

check('header button registered', byName('conversation.session.header.utilities').length >= 2)
check(
  'jump runner registered',
  byName('conversation.session.header.utilities').some((entry) => entry.options.id === 'dsh-chat-search/tab:jump'),
)
check('left rail icon registered', byName('sidebar.panellist').some((entry) => entry.options.id === 'global-search'))
check('global page registered', byName('main').some((entry) => entry.options.key === 'global-search'))
check('tab type registered', tabDefinition !== null)
check('body registered under the type id', byName('sidebar.right.pane.tab').length === 1)

// #region in-conversation panel -----------------------------------------------

const bodyRegistration = byName('sidebar.right.pane.tab')[0]
const panelProps = {
  t,
  sessionId: 'session-1',
  useChat,
  useSession,
  requestOlder: () => true,
  ...bodyRegistration.options.inject('session-1'),
}

let panelTree = await settle('panel', bodyRegistration.Component, panelProps)
const panelInput = findNode(panelTree, 'dsh-csearch-input')
check('search input rendered', panelInput !== null)
if (panelInput !== null) panelInput.props.onChange({ target: { value: '侧边栏 宽度' } })
panelTree = await settle('panel', bodyRegistration.Component, panelProps)
const panelText = flatten(panelTree).join('|')
const panelPlain = panelText.replace(/\|/g, '')
check('turn 1 group', panelText.includes('第 1 轮'), panelText.slice(0, 200))
check('turn 2 group', panelText.includes('第 2 轮'), panelText.slice(0, 300))
check('summary reports 2 groups and 4 matches', panelText.includes('2 组 · 4 条结果'), panelText.slice(0, 300))
check('group header carries the question', panelPlain.includes('帮我把右侧边栏的宽度调整一下'), panelText.slice(0, 300))
check('reports paragraph position', panelText.includes('第 1 段'))
check('assistant role label', panelText.includes('回复'))
check('user role label', panelText.includes('提问'))
check('unrelated paragraph excluded', !panelText.includes('这一段落与搜索词无关'))

/* The second reply message of Turn 1: paragraph numbers continue across messages, and the file
   row of the first message must not consume a number (the Host numbers paragraphs the same way). */
let offsetTree = await settle('panel-offset', bodyRegistration.Component, panelProps)
const offsetInput = findNode(offsetTree, 'dsh-csearch-input')
if (offsetInput !== null) offsetInput.props.onChange({ target: { value: '补记一句话' } })
offsetTree = await settle('panel-offset', bodyRegistration.Component, panelProps)
const offsetText = flatten(offsetTree).join('|')
check('a second reply message keeps its Turn', offsetText.includes('第 1 轮'), offsetText.slice(0, 200))
check(
  'paragraph numbers continue across reply messages',
  offsetText.includes('第 4 段'),
  offsetText.slice(0, 300),
)

// #endregion

// #region global page ----------------------------------------------------------

const page = byName('main').find((entry) => entry.options.key === 'global-search')
const pageProps = {
  ...page.options.inject(),
  t,
  useSessions: (selector) => selector({ byId: { s1: { title: '侧边栏宽度调整', cwd: 'C:/work/demo' } } }),
  openTarget: (sessionId, jump) => opened.push({ sessionId, jump }),
}

let pageTree = await settle('page', page.Component, pageProps)
const pageInput = findNode(pageTree, 'dsh-cg-input')
check('global input rendered', pageInput !== null)
check('all five scopes rendered', flatten(pageTree).join('|').includes('会话 + 问题 + 段落'))

if (pageInput !== null) pageInput.props.onChange({ target: { value: '侧边栏' } })
pageTree = await settle('page', page.Component, pageProps)
const pageText = flatten(pageTree).join('|')
const pagePlain = pageText.replace(/\|/g, '')
const findTag = (node, tag) => {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTag(child, tag)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.type === tag) return node
  if (node.props && node.props.children !== undefined) return findTag(node.props.children, tag)
  return null
}
check('session title shown', pagePlain.includes('侧边栏宽度调整'), pageText.slice(0, 300))
check('session path shown', pageText.includes('work/demo'))
check('session hit count shown', pageText.includes('5 处命中'), pageText.slice(0, 300))
check('expand and collapse controls shown', pageText.includes('全部展开') && pageText.includes('全部收起'))
check('question group shown', pageText.includes('第 1 轮'))
check('paragraph row shown', pageText.includes('第 1 段'), pageText.slice(0, 400))
check('snippet shown', pagePlain.includes('我已经调整了侧边栏宽度'), pageText.slice(0, 400))
check('hit count shown', pageText.includes('2 处'))
check('output file chip', pageText.includes('sb.css'))
check('input file chip', pageText.includes('notes.md'))
check('stats line shown', pageText.includes('1 个会话 · 1 个问题 · 1 个段落'), pageText.slice(0, 300))
check('file row is labelled', pageText.includes('文件'), pageText.slice(0, 400))
check('refresh control shown', pageText.includes('刷新索引'))
check('active scope hint shown', pageText.includes('任一命中'))
check('the legend explains expand vs jump', pageText.includes('↗ 点击跳到该段落'), pageText.slice(0, 400))
check('paragraph rows advertise the jump', findAll(pageTree, 'dsh-cg-go').length > 0)

const sessionTitle = findNode(pageTree, 'dsh-cg-session-title')
check('session title highlights the match', sessionTitle !== null && findTag(sessionTitle, 'mark') !== null)

const paragraphButton = findNode(pageTree, 'dsh-cg-para')
check('paragraph row is clickable', paragraphButton !== null)
if (paragraphButton !== null) paragraphButton.props.onClick()
check('click opens the session', opened.length === 1 && opened[0].sessionId === 's1', JSON.stringify(opened))
check(
  'jump carries the sequence and kind',
  opened.length === 1 && opened[0].jump !== null && opened[0].jump.seq === 2 && opened[0].jump.kind === 'paragraph',
  JSON.stringify(opened[0] && opened[0].jump),
)
check(
  'jump carries the query and scope for the panel mirror',
  opened.length === 1 && opened[0].jump.query === '侧边栏' && opened[0].jump.scope === 'all',
  JSON.stringify(opened[0] && opened[0].jump),
)
check(
  'jump carries the text anchor and turn',
  opened.length === 1 && opened[0].jump.anchor === '我已经调整了侧边栏宽度。' && opened[0].jump.turn === 1,
  JSON.stringify(opened[0] && opened[0].jump),
)
check(
  'jump carries the paragraph anchor for the selection marker',
  opened.length === 1 && opened[0].jump.paragraph === '我已经调整了侧边栏宽度。',
  JSON.stringify(opened[0] && opened[0].jump),
)
check(
  'jump mirrors the page filter window into the panel',
  opened.length === 1 && opened[0].jump.filters !== undefined && opened[0].jump.filters.turns === 30,
  JSON.stringify(opened[0] && opened[0].jump),
)

// #endregion

// #region real open path -------------------------------------------------------

/* The page's own injected opener: clicking "打开" must reach uiWorkspace.openSession. */
const liveProps = {
  ...page.options.inject(),
  t,
  useSessions: (selector) => selector({ byId: {} }),
}
let liveTree = await settle('page-live', page.Component, liveProps)
const liveInput = findNode(liveTree, 'dsh-cg-input')
if (liveInput !== null) liveInput.props.onChange({ target: { value: '侧边栏' } })
liveTree = await settle('page-live', page.Component, liveProps)
const openButton = findNode(liveTree, 'dsh-cg-open')
check('session open button rendered', openButton !== null)
if (openButton !== null) openButton.props.onClick()
check('open button reaches uiWorkspace.openSession', openedSessions.length === 1 && openedSessions[0] === 's1', JSON.stringify(openedSessions))

/* Close that transition before the mask cases below start from a clean state. */
const watcherEntry = byName('conversation.session.header.utilities').find((entry) => String(entry.options.id).endsWith(':open'))
renderComponent('watcher-prime', watcherEntry.Component, {
  sessionId: 's1',
  useSession: (selector) => selector({ openState: 'open' }),
})

// #endregion

// #region opening mask ---------------------------------------------------------

const overlay = byName('shell.overlay').find((entry) => entry.options.id === 'conversation-search:opening')
check('opening mask registered in the frame overlay', overlay !== undefined)
const watcher = byName('conversation.session.header.utilities').find((entry) => String(entry.options.id).endsWith(':open'))
check('opening watcher registered', watcher !== undefined)

let maskTree = await settle('mask', overlay.Component, { t })
check('mask hidden before any open', maskTree === null, JSON.stringify(flatten(maskTree)))

/* Click a paragraph through the real opener: the indicator must name the jump. */
const maskPageProps = { ...page.options.inject(), t, useSessions: (selector) => selector({ byId: {} }) }
let maskPage = await settle('page-mask', page.Component, maskPageProps)
const maskInput = findNode(maskPage, 'dsh-cg-input')
if (maskInput !== null) maskInput.props.onChange({ target: { value: '侧边栏' } })
maskPage = await settle('page-mask', page.Component, maskPageProps)
const maskParagraph = findNode(maskPage, 'dsh-cg-para')
if (maskParagraph !== null) maskParagraph.props.onClick()
maskTree = await settle('mask', overlay.Component, { t })
const maskText = flatten(maskTree).join('|')
check('the jump indicator names the target turn', maskText.includes('正在跳到第 1 轮'), maskText)
check('the jump indicator names the session', maskText.includes('侧边栏宽度调整'), maskText)
check('the jump indicator carries a live status role', maskTree !== null && maskTree.props.role === 'status')

/* The Session opening is only half the trip: a pending jump keeps the mask up. */
renderComponent('watcher', watcher.Component, {
  sessionId: 's1',
  useSession: (selector) => selector({ openState: 'open' }),
})
maskTree = await settle('mask', overlay.Component, { t })
check('mask stays while a jump is pending', maskTree !== null, JSON.stringify(flatten(maskTree)))

/* A failed open releases it immediately. */
renderComponent('watcher-failed', watcher.Component, {
  sessionId: 's1',
  useSession: (selector) => selector({ openState: 'error' }),
})
maskTree = await settle('mask', overlay.Component, { t })
check('mask cleared when the open fails', maskTree === null, JSON.stringify(flatten(maskTree)))

// #endregion

// #region find shortcut --------------------------------------------------------

const findDefinition = shortcutDefinitions.find((definition) => definition.id === 'conversation-search.find')
check('find shortcut registered', findDefinition !== undefined, JSON.stringify(shortcutDefinitions.map((d) => d.id)))
check(
  'find shortcut binds Ctrl/Cmd+F',
  findDefinition !== undefined && findDefinition.defaults['desktop:windows'].code === 'KeyF' && findDefinition.defaults['desktop:windows'].modifiers[0] === 'primary',
)
const resolution = findDefinition === undefined ? null : findDefinition.resolve()
check('find shortcut resolves as handled', resolution !== null && resolution.status === 'handled', JSON.stringify(resolution))
if (resolution !== null && resolution.status === 'handled') resolution.run()
check('find shortcut opens the search tab', openedTabs.includes('conversation-search'), JSON.stringify(openedTabs))

// #endregion

// #region file rows and page memory ------------------------------------------

const panelFileProps = {
  ...bodyRegistration.options.inject('session-1'),
  t,
  sessionId: 'session-1',
  useChat,
  useSession,
  requestOlder: () => true,
}
let panelFileTree = await settle('panel-file', bodyRegistration.Component, panelFileProps)
const panelFileInput = findNode(panelFileTree, 'dsh-csearch-input')
if (panelFileInput !== null) panelFileInput.props.onChange({ target: { value: 'sb.css' } })
panelFileTree = await settle('panel-file', bodyRegistration.Component, panelFileProps)
const panelFileText = flatten(panelFileTree).join('|')
check('panel finds a file name', panelFileText.includes('sb.css'), panelFileText.slice(0, 400))
check('panel labels the file row', panelFileText.includes('文件'), panelFileText.slice(0, 400))

if (pageInput !== null) pageInput.props.onChange({ target: { value: '' } })
pageTree = await settle('page', page.Component, pageProps)
const idleText = flatten(pageTree).join('|')
check('recent searches are offered', idleText.includes('最近搜索') && idleText.includes('侧边栏'), idleText.slice(0, 400))

// #endregion

// #region filter window --------------------------------------------------------

/* The panel starts from the default window, so the 40-day-old Turn is out of scope. */
const panelOldProps = {
  ...bodyRegistration.options.inject('session-1'),
  t,
  sessionId: 'session-1',
  useChat,
  useSession,
  requestOlder: () => true,
}
let panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
const panelOldInput = findNode(panelOldTree, 'dsh-csearch-input')
if (panelOldInput !== null) panelOldInput.props.onChange({ target: { value: '远古标记' } })
panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
const panelOldText = flatten(panelOldTree).join('|')
check('the default window hides an old Turn', !panelOldText.includes('远古标记的回复'), panelOldText.slice(0, 400))
const panelToggle = findNode(panelOldTree, 'dsh-filter-toggle')
check('the panel offers the filter toggle', panelToggle !== null)
check('the panel summarises the window', panelOldText.includes('最近 30 轮'), panelOldText.slice(0, 400))

/* Open the editor, clear both dates and the turn count: the old Turn must come back. */
if (panelToggle !== null) panelToggle.props.onClick()
panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
check('opening the filter reveals the fields', findAll(panelOldTree, 'dsh-filter-input').length === 2, String(findAll(panelOldTree, 'dsh-filter-input').length))
check('the turn count field is present', findNode(panelOldTree, 'dsh-filter-input dsh-filter-number') !== null)

let dateFields = findAll(panelOldTree, 'dsh-filter-input')
if (dateFields.length === 2) {
  dateFields[0].props.onChange({ target: { value: '' } })
  panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
  dateFields = findAll(panelOldTree, 'dsh-filter-input')
  dateFields[1].props.onChange({ target: { value: '' } })
  panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
  const numberField = findNode(panelOldTree, 'dsh-filter-input dsh-filter-number')
  if (numberField !== null) numberField.props.onChange({ target: { value: '' } })
  panelOldTree = await settle('panel-old', bodyRegistration.Component, panelOldProps)
}
const clearedText = flatten(panelOldTree).join('|')
check('clearing the window exposes the old Turn', clearedText.replace(/\|/g, '').includes('远古标记的回复内容'), clearedText.slice(0, 400))

const pageFilterBar = findNode(pageTree, 'dsh-filters')
check('the page shows the filter bar', pageFilterBar !== null, flatten(pageTree).join('|').slice(0, 300))
check(
  'the page request carries the window',
  lastSearchBody !== null && lastSearchBody.filters !== undefined && lastSearchBody.filters.turns === 30,
  JSON.stringify(lastSearchBody),
)

// #endregion

// #region mirrored search and panel scope --------------------------------------

/* A panel scope limits which side of the exchange is searched. */
const scopeProps = {
  ...bodyRegistration.options.inject('session-1'),
  t,
  sessionId: 'session-1',
  useChat,
  useSession,
  requestOlder: () => true,
}
let scopeTree = await settle('panel-scope', bodyRegistration.Component, scopeProps)
const scopeInput = findNode(scopeTree, 'dsh-csearch-input')
if (scopeInput !== null) scopeInput.props.onChange({ target: { value: '侧边栏' } })
scopeTree = await settle('panel-scope', bodyRegistration.Component, scopeProps)
check(
  'scope chips appear with a query',
  findAll(scopeTree, 'dsh-csearch-scope').length === 3,
  String(findAll(scopeTree, 'dsh-csearch-scope').length),
)
check('the default scope shows both sides', flatten(scopeTree).join('|').replace(/\|/g, '').includes('我已经调整了侧边栏宽度'))
check('panel rows advertise the jump', findAll(scopeTree, 'dsh-csearch-go').length > 0)

const scopeChips = findAll(scopeTree, 'dsh-csearch-scope')
if (scopeChips.length === 3) {
  scopeChips[1].props.onClick()
  scopeTree = await settle('panel-scope', bodyRegistration.Component, scopeProps)
}
const questionOnlyText = flatten(scopeTree).join('|')
const questionOnlyPlain = questionOnlyText.replace(/\|/g, '')
check('the question-only scope drops replies', !questionOnlyPlain.includes('我已经调整了侧边栏宽度'), questionOnlyText.slice(0, 300))
check(
  'the question-only scope keeps the question',
  questionOnlyPlain.includes('帮我把右侧边栏的宽度调整一下'),
  questionOnlyText.slice(0, 300),
)

// #endregion

// #region panel opener ---------------------------------------------------------

const openerEntry = byName('conversation.session.header.utilities').find((entry) => String(entry.options.id).endsWith(':panel'))
check('panel opener registered', openerEntry !== undefined)
if (openerEntry !== undefined) {
  openedTabs.length = 0
  page.options.inject().openTarget(
    's9',
    {
      seq: 9,
      kind: 'paragraph',
      words: ['锚点'],
      anchor: '锚点段落',
      paragraph: '锚点段落',
      turn: 3,
      query: '锚点',
      scope: 'all',
      filters: { since: '', until: '', turns: 3 },
    },
    '测试会话',
  )
  check('a jump opens the tab immediately', openedTabs.includes('conversation-search'), JSON.stringify(openedTabs))

  openedTabs.length = 0
  renderComponent('panel-opener', openerEntry.Component, {
    ...openerEntry.options.inject('s9'),
    sessionId: 's9',
    useSession: (selector) => selector({ openState: 'open' }),
  })
  check(
    'the opener re-issues the tab once the Session reports open',
    openedTabs.includes('conversation-search'),
    JSON.stringify(openedTabs),
  )
}

// #endregion

if (failures.length > 0) {
  console.error('FAILURES:\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('PASS: registrations, in-conversation panel, global page tree, and click-through')
