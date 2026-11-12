/**
 * Headless test for the Host half of dsh-chat-search: the corpus fold, the scope
 * semantics, the filter window, and the route envelope.
 *
 * Run: node test/host.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject } from '../index.js'

/* History lives under the profile; point the plugin at a throwaway one for this run. */
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recent-'))
process.env.DSH_PROFILE_DIR = profileDir

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label + (detail === undefined ? '' : ' — ' + detail))
}

/** Every fixture Turn lands "just now" unless it asks for an older timestamp. */
const NOW = Date.now()
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** One session log: title, then human questions and assistant replies. */
function makeSession(id, title, cwd, turns) {
  const events = []
  let seq = 0
  const push = (type, data, time) => {
    events.push({ type, seq: seq++, time: typeof time === 'number' ? time : NOW - MINUTE, data })
  }
  for (const turn of turns) {
    const at = typeof turn.at === 'number' ? turn.at : NOW - MINUTE
    if (turn.user !== undefined) {
      push(
        'user/message',
        {
          content: [
            { type: 'text', text: turn.user },
            ...(turn.files || []).map((name) => ({ type: 'file', attachment: { kind: 'file', name } })),
          ],
          source: { kind: 'user', rpcId: 'rpc-' + seq },
        },
        at,
      )
    }
    for (const reply of turn.replies || []) {
      const content = [{ type: 'reasoning', text: 'internal thinking' }]
      if (typeof reply.text === 'string') content.push({ type: 'text', text: reply.text })
      for (const path of reply.files || []) {
        content.push({ type: 'tool-call', id: 'call-' + seq, name: 'write', arguments: JSON.stringify({ path }) })
      }
      for (const call of reply.calls || []) {
        content.push({ type: 'tool-call', id: 'call-' + seq, name: call.name, arguments: JSON.stringify(call.args) })
      }
      push('assistant/message', { message: { content } }, at)
    }
  }
  if (title !== null) push('session/title', { title }, NOW)
  return { id, header: { id, createdAt: 1000, cwd }, events }
}

/**
 * One Session log written by a release that records Turn boundaries: `turn/start` carries the
 * Turn number the conversation UI shows, and each reply repeats it.
 */
function makeTurnSession(id, title, turns) {
  const events = []
  let seq = 0
  let clock = NOW - MINUTE
  const push = (type, data, at) => {
    events.push({ type, seq: seq++, time: typeof at === 'number' ? at : clock, data })
  }
  for (const turn of turns) {
    push('turn/start', { turn: turn.number }, turn.at)
    for (const user of turn.users || []) {
      push('user/message', { content: [{ type: 'text', text: user }], source: { kind: 'user', rpcId: 'rpc-' + seq } }, turn.at)
    }
    for (const reply of turn.replies || []) {
      push('assistant/message', { turn: turn.number, step: 1, message: { content: [{ type: 'text', text: reply }] } }, turn.at)
    }
    push('turn/end', { turn: turn.number }, turn.at)
  }
  if (title !== null) push('session/title', { title }, NOW)
  return { id, header: { id, createdAt: 1000, cwd: 'C:/work/turns' }, events }
}

const logs = [
  makeSession('s1', '侧边栏宽度调整', 'C:/work/demo', [
    {
      user: '帮我把右侧边栏的宽度调整一下，并让文件树默认展开。',
      replies: [{ text: '我已经调整了侧边栏宽度。\n\n具体做法是修改 sb-width 变量，并缓存用户偏好。', files: ['src/sb.css'] }],
    },
    {
      user: '再加一个侧边栏折叠按钮，宽度要记住。',
      replies: [
        { text: '侧边栏折叠按钮已添加，宽度会持久化。' },
        { calls: [{ name: 'read', args: { file_path: 'docs/guide.md' } }] },
        { calls: [{ name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: src/panel.ts\n@@\n-old\n+new\n*** End Patch' } }] },
      ],
    },
  ]),
  makeSession('s2', '文件树默认展开', 'C:/work/other', [
    {
      user: '文件树能不能默认展开？',
      files: ['notes.md'],
      replies: [{ text: '文件树现在默认展开，展开状态会保存。' }],
    },
  ]),
  makeSession('s3', null, 'C:/work/third', [
    { user: '帮我写一个排序函数。', replies: [{ text: '这是快速排序的实现。' }] },
  ]),
  /* One old Turn and one recent Turn: the filter tests below need both. */
  makeSession('s4', '筛选验证', 'C:/work/filter', [
    { at: NOW - 40 * DAY, user: '远古记录的锚点词语', replies: [{ text: '这条回复里有远古记录的锚点词语。' }] },
    { at: NOW - 2 * DAY, user: '近期记录的独特标记', replies: [{ text: '这条回复里有近期记录的独特标记。' }] },
  ]),
  /* Turn-aware log: two questions in Turn 2, and a Turn without any user message. */
  makeTurnSession('s5', '轮次一致验证', [
    {
      number: 1,
      users: ['第一问的锚点'],
      replies: ['甲段内容在这里。\n\n乙段内容在这里。'],
    },
    {
      number: 2,
      users: ['第二问的锚点', '补充提问的锚点'],
      replies: ['丙段内容在这里。'],
    },
    {
      number: 3,
      replies: ['无提问轮的段落锚点。'],
    },
  ]),
  /* Turn numbers with gaps: an aborted Turn leaves no row, but the numbers stay real. */
  makeTurnSession('s6', '轮次间隙验证', [
    { number: 1, users: ['间隙一的提问'], replies: ['丁段回复。'] },
    { number: 4, users: ['间隙四的提问'], replies: ['戊段回复。'] },
    { number: 9, users: ['间隙九的提问'], replies: ['己段回复。'] },
  ]),
]

const registered = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name === 'sessionQuery') {
      return {
        async listSessions() {
          return logs.map((log) => ({ header: log.header, live: false, persisted: true }))
        },
        async readSession(id) {
          const log = logs.find((entry) => entry.id === id)
          if (log === undefined) throw new Error('missing ' + id)
          return { header: log.header, inheritedEventCount: 0, events: log.events }
        },
      }
    }
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    return undefined
  },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
  logger: { warn() {} },
}

check('inject lists the required Host services', Array.isArray(inject) && inject.includes('sessionQuery') && inject.includes('webServer'))
apply(ctx)
check('one route registered', registered.length === 1, String(registered.length))
check('route path', registered[0] && registered[0].path === '/conversation-search/api', registered[0] && registered[0].path)
check('route kind', registered[0] && registered[0].kind === 'prefix')

/** One POST to the registered handler. */
async function post(body) {
  const text = JSON.stringify(body)
  const req = {
    method: 'POST',
    url: '/conversation-search/api',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text)
    },
  }
  let status = 0
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      status = this.statusCode
      payload = String(chunk || '')
    },
  }
  await registered[0].handler(req, res)
  return { status, body: JSON.parse(payload || 'null') }
}

// #region scope semantics ------------------------------------------------------

const all = await post({ action: 'search', query: '侧边栏', scope: 'all' })
check('all: 200', all.status === 200, String(all.status))
check('all: ok envelope', all.body.ok === true)
const allValue = all.body.value
check('all: only s1 returned', allValue.sessions.length === 1, JSON.stringify(allValue.sessions.map((s) => s.id)))
check('all: session title matched', allValue.sessions[0].matched === true)
check('all: two question groups', allValue.sessions[0].questions.length === 2, String(allValue.sessions[0].questions.length))
check('all: question text matched', allValue.sessions[0].questions[0].matched === true)
check('all: first reply paragraph kept', allValue.sessions[0].questions[0].paragraphs.length >= 1)
check(
  'all: paragraph skips the non-matching one',
  allValue.sessions[0].questions[0].paragraphs.every((p) => p.text.includes('侧边栏')),
  JSON.stringify(allValue.sessions[0].questions[0].paragraphs.map((p) => p.text)),
)
check(
  'all: text rows carry no file payload',
  allValue.sessions[0].questions[0].paragraphs.every((p) => p.kind !== 'text' || p.outputFiles.length === 0),
  JSON.stringify(allValue.sessions[0].questions[0].paragraphs.map((p) => [p.kind, p.outputFiles])),
)
check('all: stats counted', allValue.stats.sessions === 1 && allValue.stats.questions === 2, JSON.stringify(allValue.stats))

const sessionOnly = await post({ action: 'search', query: '侧边栏', scope: 'session' })
check('session scope: only the title hit', sessionOnly.body.value.sessions.length === 1)
check(
  'session scope: no question or paragraph rows',
  sessionOnly.body.value.sessions[0].questions.length === 0,
  JSON.stringify(sessionOnly.body.value.sessions[0].questions),
)
check('session scope: keeps the totals for context', sessionOnly.body.value.sessions[0].questionTotal === 2)

const questionOnly = await post({ action: 'search', query: '折叠', scope: 'question' })
check('question scope: one session', questionOnly.body.value.sessions.length === 1)
check('question scope: one question', questionOnly.body.value.sessions[0].questions.length === 1)
check('question scope: question flagged', questionOnly.body.value.sessions[0].questions[0].matched === true)
check('question scope: no paragraphs', questionOnly.body.value.sessions[0].questions[0].paragraphs.length === 0)

const paragraphOnly = await post({ action: 'search', query: 'sb-width', scope: 'paragraph' })
check('paragraph scope: one paragraph', paragraphOnly.body.value.stats.paragraphs === 1, JSON.stringify(paragraphOnly.body.value.stats))
check('paragraph scope: parent question is not a hit', paragraphOnly.body.value.sessions[0].questions[0].matched === false)
check('paragraph scope: snippet window', paragraphOnly.body.value.sessions[0].questions[0].paragraphs[0].text.includes('sb-width'))

const andQuery = await post({ action: 'search', query: '侧边栏 折叠', scope: 'all' })
check('AND: only the second question survives', andQuery.body.value.stats.questions === 1, JSON.stringify(andQuery.body.value.stats))
check('AND: title no longer matches alone', andQuery.body.value.sessions[0].matched === false)

const inputFile = await post({ action: 'search', query: '文件树', scope: 'all' })
check('input files: s2 found', inputFile.body.value.sessions.some((s) => s.id === 's2'))
check(
  'input files: attachment title carried',
  JSON.stringify(inputFile.body.value.sessions.find((s) => s.id === 's2').questions[0].inputFiles).includes('notes.md'),
  JSON.stringify(inputFile.body.value.sessions.find((s) => s.id === 's2').questions[0].inputFiles),
)

const miss = await post({ action: 'search', query: '绝对不存在的词', scope: 'all' })
check('miss: empty list', miss.body.value.sessions.length === 0)

const blank = await post({ action: 'search', query: '   ', scope: 'all' })
check('blank: empty result', blank.body.value.sessions.length === 0 && blank.body.value.stats.indexed === 0)

const badScope = await post({ action: 'search', query: '侧边栏', scope: 'nonsense' })
check('unknown scope falls back to all', badScope.body.value.scope === 'all', badScope.body.value.scope)

const method = await post({ action: 'search' })
check('empty action body still answers', method.status === 200)

// #region file names ----------------------------------------------------------

const fileParagraphHit = await post({ action: 'search', query: 'sb.css', scope: 'paragraph' })
const fileRow = fileParagraphHit.body.value.sessions[0].questions[0].paragraphs.find((p) => p.kind === 'file')
check('paragraph scope matches a file name', fileRow !== undefined, JSON.stringify(fileParagraphHit.body.value.stats))
check('file row names the match', fileRow !== undefined && fileRow.matchedFiles[0] === 'sb.css', JSON.stringify(fileRow && fileRow.matchedFiles))
check('file row is not a text match', fileRow !== undefined && fileRow.textMatched === false)
check('file row carries the file for display', fileRow !== undefined && fileRow.outputFiles.includes('sb.css'))

const attachmentHit = await post({ action: 'search', query: 'notes.md', scope: 'question' })
check('question scope matches an attachment name', attachmentHit.body.value.sessions.length === 1, JSON.stringify(attachmentHit.body.value.stats))
check(
  'attachment hit reports the name',
  JSON.stringify(attachmentHit.body.value.sessions[0].questions[0].matchedFiles).includes('notes.md'),
)
check('attachment hit is not a text match', attachmentHit.body.value.sessions[0].questions[0].textMatched === false)

const sessionScopeFile = await post({ action: 'search', query: 'sb.css', scope: 'session' })
check('session scope ignores file names', sessionScopeFile.body.value.sessions.length === 0, JSON.stringify(sessionScopeFile.body.value.stats))

const readPath = await post({ action: 'search', query: 'guide.md', scope: 'all' })
check('read-tool paths are indexed', readPath.body.value.sessions.length === 1, JSON.stringify(readPath.body.value.stats))

const patched = await post({ action: 'search', query: 'panel.ts', scope: 'paragraph' })
check('apply_patch paths are indexed', patched.body.value.stats.paragraphs >= 1, JSON.stringify(patched.body.value.stats))

const untitled = await post({ action: 'search', query: '排序', scope: 'all' })
const untitledSession = untitled.body.value.sessions[0]
check(
  'untitled session falls back to its first question',
  untitledSession !== undefined && String(untitledSession.displayTitle).startsWith('帮我写一个排序函数'),
  JSON.stringify(untitledSession && untitledSession.displayTitle),
)

const refreshed = await post({ action: 'search', query: '侧边栏', scope: 'all', refresh: true })
check('refresh rebuilds and answers', refreshed.status === 200 && refreshed.body.ok === true)

// #endregion

// #region turn numbering ------------------------------------------------------

const turnOne = await post({ action: 'search', query: '乙段', scope: 'paragraph' })
const turnOneSession = turnOne.body.value.sessions[0]
check(
  'turns: only the turn-aware Session matched',
  turnOne.body.value.sessions.length === 1 && turnOneSession.id === 's5',
  JSON.stringify(turnOne.body.value.sessions.map((s) => s.id)),
)
check('turns: the paragraph carries DSH Turn 1', turnOneSession.questions[0].number === 1, JSON.stringify(turnOneSession.questions[0].number))
check(
  'turns: paragraphs continue across one reply message',
  turnOneSession.questions[0].paragraphs[0].index === 2,
  JSON.stringify(turnOneSession.questions[0].paragraphs[0].index),
)

/* A file row names files; it must not take a paragraph number (the panel skips it the same way). */
const fileOnlyHit = await post({ action: 'search', query: 'sb.css', scope: 'paragraph' })
const fileOnlyParagraph = fileOnlyHit.body.value.sessions[0].questions[0].paragraphs[0]
check(
  'turns: a file row is not numbered',
  fileOnlyParagraph.kind === 'file' && fileOnlyParagraph.index === 0,
  JSON.stringify({ kind: fileOnlyParagraph.kind, index: fileOnlyParagraph.index }),
)
const afterFileHit = await post({ action: 'search', query: '具体做法', scope: 'paragraph' })
check(
  'turns: a text paragraph after a file row keeps its own number',
  afterFileHit.body.value.sessions[0].questions[0].paragraphs[0].index === 2,
  JSON.stringify(afterFileHit.body.value.sessions[0].questions[0].paragraphs[0].index),
)

const steering = await post({ action: 'search', query: '补充提问的锚点', scope: 'question' })
const steeringSession = steering.body.value.sessions[0]
check('turns: a second user message does not add a question row', steeringSession.questionTotal === 3, String(steeringSession.questionTotal))
check('turns: that message keeps Turn 2', steeringSession.questions[0].number === 2, String(steeringSession.questions[0].number))
check(
  'turns: the jump anchor is the message that matched',
  String(steeringSession.questions[0].anchor).includes('补充提问'),
  String(steeringSession.questions[0].anchor),
)

const emptyTurn = await post({ action: 'search', query: '无提问轮的段落锚点', scope: 'paragraph' })
const emptyQuestion = emptyTurn.body.value.sessions[0].questions[0]
check(
  'turns: a Turn without a user message stays searchable',
  emptyQuestion.number === 3 && emptyQuestion.paragraphs.length === 1,
  JSON.stringify([emptyQuestion.number, emptyQuestion.paragraphs.length]),
)
check('turns: it has no question text or question hit', emptyQuestion.matched === false && emptyQuestion.text === '')

/* A turn limit is counted in Turn numbers (maxTurn - N + 1), not in surviving rows. */
const gapWindow = await post({
  action: 'search',
  query: '己段回复',
  scope: 'paragraph',
  filters: { since: '', until: '', turns: 2 },
})
const gapQuestion = gapWindow.body.value.sessions[0] === undefined ? null : gapWindow.body.value.sessions[0].questions[0]
check(
  'turns: a 2-Turn window keeps the real Turn 9',
  gapQuestion !== null && gapQuestion.number === 9,
  JSON.stringify(gapQuestion && gapQuestion.number),
)
const gapDropped = await post({
  action: 'search',
  query: '戊段回复',
  scope: 'paragraph',
  filters: { since: '', until: '', turns: 2 },
})
check(
  'turns: the same window drops Turn 4',
  gapDropped.body.value.sessions.length === 0,
  JSON.stringify(gapDropped.body.value.sessions.map((s) => s.id)),
)

// #endregion

// #region recent queries ------------------------------------------------------

check('file row carries its turn', fileRow !== undefined && fileRow.turn === 1, JSON.stringify(fileRow && fileRow.turn))
check('file row carries its anchor', fileRow !== undefined && fileRow.anchor === 'sb.css', JSON.stringify(fileRow && fileRow.anchor))

const firstRecent = await post({ action: 'search', query: '侧边栏', scope: 'all' })
check(
  'search response carries history',
  Array.isArray(firstRecent.body.value.recent) && firstRecent.body.value.recent[0] === '侧边栏',
  JSON.stringify(firstRecent.body.value.recent),
)

const secondRecent = await post({ action: 'search', query: 'sb.css', scope: 'all' })
check('history keeps the newest first', secondRecent.body.value.recent[0] === 'sb.css', JSON.stringify(secondRecent.body.value.recent))
check('history keeps earlier entries', secondRecent.body.value.recent.includes('侧边栏'))

const listed = await post({ action: 'recent' })
check(
  'recent action returns the same list',
  JSON.stringify(listed.body.value.recent) === JSON.stringify(secondRecent.body.value.recent),
  JSON.stringify(listed.body.value.recent),
)

const historyFile = path.join(profileDir, 'plugin-data', 'conversation-search', 'recent.json')
check('history file written', fs.existsSync(historyFile), historyFile)

/* A fresh plugin instance reads the same file back: this is exactly what survives a restart. */
const routes2 = []
const ctx2 = {
  ...ctx,
  webServer: {
    register(definition) {
      routes2.push(definition)
      return () => {}
    },
  },
}
apply(ctx2)
let reloaded = ''
await routes2[0].handler(
  {
    method: 'POST',
    url: '/conversation-search/api',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'recent' }))
    },
  },
  { statusCode: 0, setHeader() {}, end(chunk) { reloaded = String(chunk || '') } },
)
check('a fresh instance reads the persisted history', JSON.parse(reloaded).value.recent[0] === 'sb.css', reloaded.slice(0, 200))

// #endregion

// #region warm-up and response cache -------------------------------------------

const warm = await post({ action: 'warm' })
check('warm returns the corpus size', typeof warm.body.value.sessions === 'number' && warm.body.value.sessions >= 4, JSON.stringify(warm.body.value))
check('warm reports a build time', typeof warm.body.value.buildMs === 'number', JSON.stringify(warm.body.value))

const firstCached = await post({ action: 'search', query: '侧边栏 折叠', scope: 'all' })
const secondCached = await post({ action: 'search', query: '侧边栏 折叠', scope: 'all' })
check('a first search is computed', firstCached.body.value.stats.cached !== true, JSON.stringify(firstCached.body.value.stats))
check('an identical search is served from the cache', secondCached.body.value.stats.cached === true, JSON.stringify(secondCached.body.value.stats))
check(
  'the cached response keeps the same hits',
  JSON.stringify(secondCached.body.value.sessions) === JSON.stringify(firstCached.body.value.sessions),
  'sessions differ',
)

// #endregion

// #region filter window -------------------------------------------------------

/** One local calendar date, `daysAgo` days before now. */
function dayString(daysAgo) {
  const date = new Date(NOW - daysAgo * DAY)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const defaultWindow = await post({ action: 'search', query: '远古记录的锚点词语', scope: 'all' })
check('the default window drops a 40-day-old Turn', defaultWindow.body.value.sessions.length === 0, JSON.stringify(defaultWindow.body.value.stats))
check(
  'the response echoes the default window',
  defaultWindow.body.value.filters !== undefined && defaultWindow.body.value.filters.turns === 30,
  JSON.stringify(defaultWindow.body.value.filters),
)

const everything = await post({
  action: 'search',
  query: '远古记录的锚点词语',
  scope: 'all',
  filters: { since: '', until: '', turns: 0 },
})
check('cleared filters include the old Turn', everything.body.value.sessions.length === 1, JSON.stringify(everything.body.value.stats))

const lastTurnOnly = await post({
  action: 'search',
  query: '记录的',
  scope: 'all',
  filters: { since: '', until: '', turns: 1 },
})
check('the turn limit keeps only the newest Turn', lastTurnOnly.body.value.stats.questions === 1, JSON.stringify(lastTurnOnly.body.value.stats))
check(
  'a filtered Turn keeps its session ordinal',
  String(lastTurnOnly.body.value.sessions[0].questions[0].number) === '2',
  JSON.stringify(lastTurnOnly.body.value.sessions[0].questions[0].number),
)

const recentDates = await post({
  action: 'search',
  query: '记录的',
  scope: 'all',
  filters: { since: dayString(7), until: dayString(0), turns: 0 },
})
check('the date window keeps only the recent Turn', recentDates.body.value.stats.questions === 1, JSON.stringify(recentDates.body.value.stats))

const storedFilters = await post({ action: 'filters' })
check(
  'filters are persisted',
  storedFilters.body.value.filters !== undefined && storedFilters.body.value.filters.turns === 0,
  JSON.stringify(storedFilters.body.value.filters),
)

/* A fresh plugin instance reads the saved window back. */
const routes3 = []
apply({
  ...ctx,
  webServer: {
    register(definition) {
      routes3.push(definition)
      return () => {}
    },
  },
})
let savedWindow = ''
await routes3[0].handler(
  {
    method: 'POST',
    url: '/conversation-search/api',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'filters' }))
    },
  },
  { statusCode: 0, setHeader() {}, end(chunk) { savedWindow = String(chunk || '') } },
)
check('a fresh instance reads the saved window', JSON.parse(savedWindow).value.filters.turns === 0, savedWindow.slice(0, 200))

fs.rmSync(profileDir, { recursive: true, force: true })

// #endregion

if (failures.length > 0) {
  console.error('FAILURES:\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('PASS: host corpus fold, scope semantics, files, and envelope')
