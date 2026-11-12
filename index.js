/**
 * Host half of the conversation-search bundle.
 *
 * The in-conversation panel searches what the browser has loaded; this half answers the
 * global search, which must cover EVERY stored Session. It reads the whole logical corpus
 * through `ctx.sessionQuery` (live history preferred, persisted logs otherwise), folds each
 * log into Session → question → paragraph, and serves one POST route for the Web page.
 *
 * The route is browser-only and loopback-bound like the rest of the GUI: it carries no
 * mutation, so a local reader gains nothing it could not read from the session logs.
 */

import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One POST route; the client resolves it relative to the page's own base. */
const ROUTE_PATH = '/conversation-search/api'
/** The request is a small JSON document; anything larger is a wiring mistake. */
const MAX_BODY_BYTES = 128 * 1024
/** Corpus refreshes reuse parsed Sessions for this long. */
const INDEX_TTL_MS = 30_000
/** A hard floor between rebuilds, so a streaming reply cannot rebuild on every keystroke. */
const INDEX_MIN_AGE_MS = 2_500
/** A stored log has no cheap revision: its parsed entry is reused for this long between rebuilds. */
const STORED_REUSE_MS = 10 * 60_000
/** Identical searches reuse their serialized result for this long. */
const RESPONSE_TTL_MS = 60_000
const MAX_RESPONSE_CACHE = 32
/** Sessions indexed at most (newest first), and the text budget across all of them. */
const MAX_SESSIONS = 400
const MAX_TOTAL_CHARS = 8_000_000
/** Guard against one pathological log monopolizing a rebuild. */
const MAX_EVENTS_PER_SESSION = 30_000
/** Caps on one response, so a broad query stays readable and cheap to render. */
const MAX_RESULT_SESSIONS = 30
const MAX_RESULT_QUESTIONS = 12
const MAX_RESULT_PARAGRAPHS = 8
const SNIPPET_CHARS = 150
const QUESTION_CHARS = 180
/** How many recent queries the page keeps, and where they survive a restart. */
const MAX_RECENT = 8
const RECENT_FILE = 'recent.json'
/** Filter defaults: the last two weeks and the last thirty turns of each Session. */
const FILTER_FILE = 'filters.json'
const DEFAULT_FILTER_DAYS = 14
const DEFAULT_FILTER_TURNS = 30
/** Anchor budget: enough text to identify the message in the client's loaded window. */
const ANCHOR_CHARS = 80

/** Which fields each scope matches. */
const SCOPES = {
  all: { session: true, question: true, paragraph: true },
  'session-question': { session: true, question: true, paragraph: false },
  session: { session: true, question: false, paragraph: false },
  question: { session: false, question: true, paragraph: false },
  paragraph: { session: false, question: false, paragraph: true },
}

/** Tool-argument keys that name a file. `name` is deliberately absent: tools use it for labels. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'target', 'filename']
/** Display-name keys an attachment or a content block carries. */
const NAME_KEYS = ['title', 'name', 'filename', 'file_name', 'path']
/** One message contributes at most this many file names. */
const MAX_FILES = 6

export const inject = ['webServer', 'sessionQuery']

/**
 * Register the one route and keep the index in this plugin's own effect scope.
 * @param ctx - Host plugin context carrying the webserver and the session query service.
 */
export function apply(ctx) {
  const index = createIndex(ctx)
  const recent = createRecentStore()
  const filters = createFilterStore()
  /** Identical search results, keyed by query/scope/filters/index version. */
  const responseCache = new Map()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (req, res) => handleRequest(ctx, index, recent, filters, responseCache, req, res),
      }),
    'conversation-search: api route',
  )
}

// #region HTTP plumbing -------------------------------------------------------

/**
 * Serve one search request.
 * @param ctx - Host plugin context.
 * @param index - the corpus index.
 * @param recent - the recent-query store.
 * @param filters - the saved filter store.
 * @param responseCache - the TTL cache for identical searches.
 * @param req - the request face (async-iterable body).
 * @param res - the response face.
 */
async function handleRequest(ctx, index, recent, filters, responseCache, req, res) {
  const connection = ctx.get('connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch (error) {
      rejection = 403
    }
    if (rejection !== undefined && rejection !== null) {
      sendJson(res, rejection, { ok: false, error: { code: 'forbidden', message: 'request rejected' } })
      return
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    sendJson(res, 405, { ok: false, error: { code: 'method', message: 'POST only' } })
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: messageOf(error) } })
    return
  }

  const started = Date.now()
  try {
    if (payload.action === 'status') {
      const corpus = await index.ensure()
      sendJson(res, 200, {
        ok: true,
        value: { sessions: corpus.size, builtAt: index.builtAt(), buildMs: index.buildMs() },
      })
      return
    }
    if (payload.action === 'warm') {
      const corpus = await index.ensure(payload.refresh === true)
      sendJson(res, 200, {
        ok: true,
        value: { sessions: corpus.size, builtAt: index.builtAt(), buildMs: index.buildMs() },
      })
      return
    }
    if (payload.action === 'recent') {
      sendJson(res, 200, { ok: true, value: { recent: await recent.read() } })
      return
    }
    if (payload.action === 'filters') {
      const saved = payload.filters === undefined ? await filters.read() : await filters.write(payload.filters)
      sendJson(res, 200, { ok: true, value: { filters: saved } })
      return
    }
    const query = typeof payload.query === 'string' ? payload.query : ''
    const scope = typeof payload.scope === 'string' && SCOPES[payload.scope] !== undefined ? payload.scope : 'all'
    const active = normalizeFilters(payload.filters)
    if (query.trim() === '') {
      const value = emptyResult(query, scope, started)
      value.recent = await recent.read()
      value.filters = active
      sendJson(res, 200, { ok: true, value })
      return
    }
    const corpus = await index.ensure(payload.refresh === true)
    /* An identical search inside the TTL reuses the folded result; the index version keys it. */
    const cacheKey = `${index.builtAt()}|${query}|${scope}|${active.since}|${active.until}|${active.turns}`
    const cached = responseCache.get(cacheKey)
    const fresh = cached === undefined || Date.now() - cached.at >= RESPONSE_TTL_MS
    if (fresh) {
      const computed = searchCorpus(corpus, query, scope, started, active)
      responseCache.set(cacheKey, { at: Date.now(), value: computed })
      if (responseCache.size > MAX_RESPONSE_CACHE) {
        const oldest = responseCache.keys().next().value
        if (oldest !== undefined) responseCache.delete(oldest)
      }
    }
    const base = fresh ? responseCache.get(cacheKey).value : cached.value
    const value = {
      query,
      scope,
      sessions: base.sessions,
      stats: {
        ...base.stats,
        tookMs: Date.now() - started,
        cached: !fresh,
        /* Index timing travels with every reply, cached or not: that is the number to optimise. */
        buildMs: index.buildMs(),
        indexAgeMs: Date.now() - index.builtAt(),
      },
    }
    /* Recorded only after the search succeeded, so a failed request never enters history. */
    value.recent = await recent.remember(query)
    value.filters = await filters.write(active)
    sendJson(res, 200, { ok: true, value })
  } catch (error) {
    ctx.logger?.warn?.(`conversation-search: ${messageOf(error)}`)
    sendJson(res, 500, { ok: false, error: { code: 'search-failed', message: messageOf(error) } })
  }
}

/** Write one JSON envelope. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** Read the bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    throw new Error('request body is not valid JSON')
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// #endregion

// #region Recent queries ------------------------------------------------------

/** The directory this plugin keeps its small state files in. */
function dataDir() {
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile !== '') return path.join(profile, 'plugin-data', 'conversation-search')
  return path.join(os.homedir(), '.dsh', 'conversation-search')
}

/** The file this plugin's search history lives in. */
function recentPath() {
  return path.join(dataDir(), RECENT_FILE)
}

/**
 * One lazily loaded, write-through list of recent queries.
 *
 * The file is a cache of what the reader typed: an unreadable or read-only location degrades
 * to in-memory history instead of failing a search.
 */
function createRecentStore() {
  let loaded = null
  let loading = null
  let writing = Promise.resolve()

  async function read() {
    if (loaded !== null) return loaded
    if (loading !== null) return loading
    loading = (async () => {
      try {
        const text = await fsPromises.readFile(recentPath(), 'utf8')
        const parsed = JSON.parse(text)
        loaded = Array.isArray(parsed)
          ? parsed.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, MAX_RECENT)
          : []
      } catch (error) {
        loaded = []
      }
      loading = null
      return loaded
    })()
    return loading
  }

  async function remember(query) {
    const trimmed = query.trim()
    if (trimmed === '') return read()
    const list = await read()
    const next = [trimmed, ...list.filter((item) => item !== trimmed)].slice(0, MAX_RECENT)
    loaded = next
    const target = recentPath()
    writing = writing.then(async () => {
      try {
        await fsPromises.mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await fsPromises.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
        await fsPromises.rename(temporary, target)
      } catch (error) {
        /* History is a convenience: a read-only home must not fail a search. */
      }
    })
    /* The response is the promise that the history is on disk, so wait for this write. */
    await writing
    return next
  }

  return { read, remember }
}

// #endregion

// #region Filters -------------------------------------------------------------

/** One local calendar date as `YYYY-MM-DD`. */
function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The default window: the last two weeks, the last thirty turns of each Session. */
function defaultFilters() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DEFAULT_FILTER_DAYS - 1))
  return { since: localDate(start), until: localDate(now), turns: DEFAULT_FILTER_TURNS }
}

function dateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

/** Zero means "no turn limit"; anything else is a positive, bounded count. */
function turnCount(value) {
  const count = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(Math.floor(count), 5000)
}

/**
 * Clamp one filter request from the client.
 *
 * Missing filters mean "use the defaults"; an explicit object means exactly what it says, so a
 * reader can clear both bounds and get the whole corpus back.
 */
function normalizeFilters(input) {
  if (input === undefined || input === null || typeof input !== 'object') return defaultFilters()
  let since = dateString(input.since)
  let until = dateString(input.until)
  if (since !== '' && until !== '' && since > until) {
    const swap = since
    since = until
    until = swap
  }
  return { since, until, turns: turnCount(input.turns) }
}

function dayStartMs(value) {
  if (value === '') return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

function dayEndMs(value) {
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

/** The saved filter window, written through so the next launch starts from it. */
function createFilterStore() {
  let loaded = null
  let loading = null
  let writing = Promise.resolve()
  let lastWritten = ''

  async function read() {
    if (loaded !== null) return loaded
    if (loading !== null) return loading
    loading = (async () => {
      try {
        const text = await fsPromises.readFile(path.join(dataDir(), FILTER_FILE), 'utf8')
        loaded = normalizeFilters(JSON.parse(text))
      } catch (error) {
        loaded = defaultFilters()
      }
      loading = null
      return loaded
    })()
    return loading
  }

  async function write(input) {
    const next = normalizeFilters(input)
    const key = JSON.stringify(next)
    loaded = next
    if (key === lastWritten) return next
    lastWritten = key
    const target = path.join(dataDir(), FILTER_FILE)
    writing = writing.then(async () => {
      try {
        await fsPromises.mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await fsPromises.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
        await fsPromises.rename(temporary, target)
      } catch (error) {
        /* Filters are a preference: a read-only home must not fail a search. */
      }
    })
    await writing
    return next
  }

  return { read, write }
}

// #endregion

// #region Corpus index --------------------------------------------------------

/**
 * Create the lazily built, TTL-refreshed corpus index.
 *
 * A live Session is re-parsed only when its event count moved; a stored one is re-read on
 * each rebuild, because the persistence layer exposes no cheap revision here. Rebuilds are
 * serialized, so two searches arriving together do one pass.
 */
function createIndex(ctx) {
  const cache = new Map()
  /* Stored logs have no cheap revision, so their parsed entry is reused for a bounded while. */
  const stored = new Map()
  let builtAt = 0
  let buildMs = 0
  let building = null

  async function rebuild(force) {
    const buildStarted = Date.now()
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw new Error('sessionQuery is unavailable')
    const liveSessions = ctx.get('sessions')
    const records = await query.listSessions()
    const next = new Map()
    let budget = MAX_TOTAL_CHARS
    if (force) stored.clear()

    for (let offset = 0; offset < records.length && offset < MAX_SESSIONS && budget > 0; offset += 8) {
      const batch = records.slice(offset, offset + 8)
      const parsed = await Promise.all(
        batch.map(async (record) => {
          const id = record.header.id
          try {
            const live = liveSessions === undefined ? undefined : liveSessions.get(id)
            const events = live === undefined ? undefined : live.snapshotEvents()
            const signature = events === undefined ? 'stored' : `live:${events.length}`
            const hit = cache.get(id)
            if (hit !== undefined && hit.signature === signature) return hit
            const kept = stored.get(id)
            if (events === undefined && kept !== undefined && Date.now() - kept.at < STORED_REUSE_MS) {
              return kept.entry
            }
            const log = events === undefined ? (await query.readSession(id)).events : events
            const entry = parseSession(id, record.header, log, signature)
            if (events === undefined) stored.set(id, { entry, at: Date.now() })
            return entry
          } catch (error) {
            return undefined
          }
        }),
      )
      for (const entry of parsed) {
        if (entry === undefined) continue
        next.set(entry.id, entry)
        budget -= entry.chars
      }
    }

    cache.clear()
    for (const [id, entry] of next) cache.set(id, entry)
    builtAt = Date.now()
    buildMs = builtAt - buildStarted
    return cache
  }

  return {
    async ensure(force) {
      const now = Date.now()
      const age = now - builtAt
      if (!force) {
        if (cache.size > 0 && age < INDEX_MIN_AGE_MS) return cache
        /* A live Session that grew must be visible at once; stored logs can wait for the TTL. */
        if (cache.size > 0 && age < INDEX_TTL_MS && !liveMoved(ctx, cache)) return cache
      }
      if (building !== null) return building
      building = rebuild(force).finally(() => {
        building = null
      })
      return building
    },
    builtAt: () => builtAt,
    buildMs: () => buildMs,
  }
}

/** Whether any live Session's log has moved since the cached parse. */
function liveMoved(ctx, cache) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.list !== 'function') return false
  for (const session of sessions.list()) {
    const entry = cache.get(session.id)
    if (entry === undefined) return true
    if (typeof session.snapshotEvents !== 'function') continue
    const events = session.snapshotEvents()
    if (entry.signature !== `live:${events.length}`) return true
  }
  return false
}

/**
 * Fold one Session log into the tree the page renders.
 *
 * DSH numbers Turns itself: `turn/start` carries `data.turn` and every `assistant/message`
 * repeats it. A Turn is one row here, so the page shows the same 「第 N 轮」 the in-conversation
 * panel reads from a Chat node's `location.turn.turn`. One Turn can hold several
 * `user/message` events (a steering message); their texts stay as parts of that one question.
 * Logs that predate Turn boundaries fall back to one question per user message, numbered in
 * order — the behaviour older releases had.
 */
function parseSession(id, header, events, signature) {
  let title = ''
  let chars = 0
  const questions = []
  const byTurn = new Map()
  const hasTurnBoundary = events.some(
    (event) => event !== null && typeof event === 'object' && event.type === 'turn/start',
  )
  let currentTurn = null
  let current = null
  let ordinal = 0
  const limit = Math.min(events.length, MAX_EVENTS_PER_SESSION)

  /** The one question row of a Turn (created on first sight, keyed by its real number). */
  const questionFor = (turn) => {
    const known = byTurn.get(turn)
    if (known !== undefined) return known
    const question = { turn, seq: 0, time: 0, parts: [], paragraphs: [] }
    byTurn.set(turn, question)
    questions.push(question)
    return question
  }

  const stamp = (question, event) => {
    if (question.seq === 0 && typeof event.seq === 'number') question.seq = event.seq
    if (question.time === 0 && typeof event.time === 'number') question.time = event.time
  }

  for (let index = 0; index < limit; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue

    if (event.type === 'session/title') {
      const value = event.data !== null && typeof event.data === 'object' ? event.data.title : undefined
      if (typeof value === 'string' && value !== '') title = value
      continue
    }

    if (event.type === 'turn/start') {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
      const turn = data !== undefined && typeof data.turn === 'number' ? data.turn : null
      if (turn !== null) {
        currentTurn = turn
        current = questionFor(turn)
        stamp(current, event)
      }
      continue
    }

    if (event.type === 'user/message') {
      const part = readQuestion(event)
      if (part === null) continue
      chars += part.text.length
      let question
      if (hasTurnBoundary && currentTurn !== null) {
        question = questionFor(currentTurn)
      } else {
        ordinal += 1
        question = questionFor(ordinal)
      }
      stamp(question, event)
      question.parts.push(part)
      current = question
      continue
    }

    if (event.type === 'assistant/message') {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
      const message = data !== undefined ? data.message : undefined
      const content = message !== null && typeof message === 'object' ? message.content : undefined
      if (!Array.isArray(content)) continue
      const turn = data !== undefined && typeof data.turn === 'number' ? data.turn : null
      if (hasTurnBoundary && turn !== null) {
        currentTurn = turn
        current = questionFor(turn)
      }
      if (current === null) {
        ordinal += 1
        current = questionFor(hasTurnBoundary && turn !== null ? turn : ordinal)
      }
      stamp(current, event)
      const text = textOfBlocks(content)
      const files = outputFilesOf(content)
      if (text === '' && files.length === 0) continue
      const seq = typeof event.seq === 'number' ? event.seq : current.seq
      const paragraphs = splitParagraphs(text)
      for (let position = 0; position < paragraphs.length; position += 1) {
        current.paragraphs.push({ seq, kind: 'text', text: paragraphs[position], files: [] })
        chars += paragraphs[position].length
      }
      /* A Tool-only step still names files; give them a row of their own so they are searchable. */
      if (files.length > 0 && !files.every((name) => text.includes(name))) {
        current.paragraphs.push({ seq, kind: 'file', text: '', files })
        chars += files.join(' ').length
      }
      continue
    }
  }

  /* A Turn that started and ended without any searchable content is not a row. */
  const kept = questions.filter((question) => question.parts.length > 0 || question.paragraphs.length > 0)
  let displayTitle = title
  if (displayTitle === '') {
    for (const question of kept) {
      const first = question.parts.find((part) => part.text !== '')
      if (first !== undefined) {
        displayTitle = previewTitle(first.text)
        break
      }
    }
  }

  return {
    id,
    cwd: header !== null && header !== undefined && typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: header !== null && header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0,
    title,
    displayTitle,
    signature,
    chars,
    questions: kept,
  }
}

/** One human question, or null for injected context and non-text inputs. */
function readQuestion(event) {
  const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
  if (data === undefined) return null
  const source = data.source
  if (source !== null && source !== undefined && typeof source === 'object' && typeof source.kind === 'string') {
    if (source.kind !== 'user' && source.kind !== 'steering') return null
  }
  if (!Array.isArray(data.content)) return null
  const text = textOfBlocks(data.content)
  const files = inputFilesOf(data.content)
  if (text === '' && files.length === 0) return null
  return {
    seq: typeof event.seq === 'number' ? event.seq : 0,
    time: typeof event.time === 'number' ? event.time : 0,
    text,
    files,
    paragraphs: [],
  }
}

/** Join the text blocks of one message, blank-line separated so each block is a paragraph. */
function textOfBlocks(content) {
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text === '') continue
    out = out === '' ? text : `${out}\n\n${text}`
  }
  return out
}

/** Paragraphs of one message: blank lines separate, runs of whitespace collapse. */
function splitParagraphs(text) {
  const out = []
  for (const part of text.split(/\n\s*\n/)) {
    const normalized = part.replace(/\s+/g, ' ').trim()
    if (normalized !== '') out.push(normalized)
  }
  return out
}

/** Flatten a question into a one-line display title. */
function previewTitle(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return normalized.length <= 40 ? normalized : `${normalized.slice(0, 39).trimEnd()}…`
}

/** Attachment titles a question carried. */
function inputFilesOf(content) {
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') continue
    const name = nameOf(block)
    if (name !== undefined) pushUnique(out, name, 4)
  }
  return out
}

/** File names a reply's Tools named: writes, patches, reads and presentations alike. */
function outputFilesOf(content) {
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
    const args = parseArguments(block.arguments)
    if (args === undefined) continue
    for (const path of pathsIn(args)) pushUnique(out, path, MAX_FILES)
    for (const path of patchPaths(args)) pushUnique(out, path, MAX_FILES)
  }
  return out
}

/** Parse a Tool call's raw arguments; a non-object or malformed value names nothing. */
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

/** Every plausible file name one arguments object carries. */
function pathsIn(args) {
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

/** Whether one Tool argument really names a file rather than a label or a command. */
function looksLikePath(value) {
  const text = String(value).trim()
  if (text === '' || text.length > 160) return false
  if (/[\r\n]/.test(text)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
  if (/\s/.test(text)) return false
  return text.includes('/') || text.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(text)
}

/** Paths an `apply_patch` body adds, updates, or deletes. */
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

function basename(value) {
  const text = String(value).replace(/\\/g, '/')
  const name = text.slice(text.lastIndexOf('/') + 1).trim()
  if (name === '' || name.length > 120 || /[\r\n]/.test(name)) return ''
  return name
}

/** The display name a content block or its attachment carries. */
function nameOf(block) {
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

function pushUnique(list, value, cap) {
  if (list.length >= cap || list.includes(value)) return
  list.push(value)
}

// #endregion

// #region Matching ------------------------------------------------------------

function normalizeWords(query) {
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 6)
}

function containsAll(text, words) {
  if (text === '') return false
  const lower = text.toLowerCase()
  for (const word of words) {
    if (lower.indexOf(word) < 0) return false
  }
  return true
}

/** The file names that satisfy every keyword on their own. */
function matchesFiles(files, words) {
  const out = []
  if (!Array.isArray(files)) return out
  for (const name of files) {
    if (containsAll(name, words)) out.push(name)
  }
  return out
}

function countHits(text, words) {
  const lower = text.toLowerCase()
  let total = 0
  for (const word of words) {
    let from = 0
    while (total < 60) {
      const at = lower.indexOf(word, from)
      if (at < 0) break
      total += 1
      from = at + word.length
    }
  }
  return total
}

/** A window of `text` around its earliest keyword. */
function snippetOf(text, words, budget) {
  const lower = text.toLowerCase()
  let anchor = -1
  for (const word of words) {
    const at = lower.indexOf(word)
    if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at
  }
  if (anchor < 0) anchor = 0
  const start = Math.max(0, anchor - Math.floor(budget / 4))
  const end = Math.min(text.length, start + budget)
  const sliced = text.slice(start, end)
  return `${start > 0 ? '…' : ''}${sliced}${end < text.length ? '…' : ''}`
}

function emptyResult(query, scope, started) {
  return {
    query,
    scope,
    sessions: [],
    stats: {
      sessions: 0,
      questions: 0,
      paragraphs: 0,
      indexed: 0,
      truncated: false,
      matchMs: 0,
      tookMs: Date.now() - started,
    },
  }
}

/**
 * Match the corpus and shape the three-layer response.
 *
 * Every returned Session keeps only the questions and paragraphs that matched (plus the
 * containers needed to place them), each flagged with which layer actually hit the keywords.
 */
function searchCorpus(corpus, query, scope, started, filters) {
  const matchStarted = Date.now()
  const words = normalizeWords(query)
  const spec = SCOPES[scope]
  const sinceMs = dayStartMs(filters.since)
  const untilMs = dayEndMs(filters.until)
  const turnLimit = filters.turns > 0 ? filters.turns : 0
  const sessions = []
  let questionCount = 0
  let paragraphCount = 0
  let truncated = false

  if (words.length > 0) {
    for (const entry of corpus.values()) {
      const sessionMatched = spec.session && containsAll(entry.title, words)
      const questions = []
      /* Only the last N Turns of each Session are candidates; the date window narrows further.
         The window is computed from Turn NUMBERS, exactly like the panel's maxTurn - N + 1, so a
         Turn gap (an aborted Turn yields no row) cannot shift the two windows apart. */
      const lastTurn = entry.questions.length === 0 ? -1 : entry.questions[entry.questions.length - 1].turn
      const minTurn = turnLimit > 0 && lastTurn >= 0 ? lastTurn - turnLimit + 1 : Number.NEGATIVE_INFINITY
      for (const question of entry.questions) {
        if (question.turn < minTurn) continue
        if (!inWindow(question.time, sinceMs, untilMs)) continue
        /* The Turn number DSH itself shows; the panel reads the same number off its Chat nodes. */
        const questionNumber = question.turn
        const parts = question.parts
        const partTextHit = spec.question
          ? parts.find((part) => part.text !== '' && containsAll(part.text, words))
          : undefined
        const partFileHit = spec.question
          ? parts.find((part) => matchesFiles(part.files, words).length > 0)
          : undefined
        const matchedPart = partTextHit !== undefined ? partTextHit : partFileHit
        const questionMatched = matchedPart !== undefined
        /* Input files are display metadata: keep them for every scope, match them only for question scope. */
        const questionFiles = []
        for (const part of parts) {
          for (const name of part.files) pushUnique(questionFiles, name, MAX_FILES)
        }
        /* A jump targets the user message that actually matched, not simply the first one. */
        const anchorPart = matchedPart !== undefined ? matchedPart : parts[0]
        const anchorText = anchorPart === undefined ? '' : anchorPart.text
        const anchor = anchorText !== '' ? anchorText.slice(0, ANCHOR_CHARS) : anchorPart === undefined ? '' : anchorPart.files[0] || ''
        const questionSeq = anchorPart === undefined ? question.seq : anchorPart.seq
        const matchedFiles = matchedPart !== undefined && spec.question ? matchesFiles(matchedPart.files, words) : []
        const paragraphs = []
        /* File rows name files; they are not paragraphs, so they never consume a number. The
           panel skips them the same way, which keeps "第 N 段" identical in both views. */
        let paragraphIndex = 0
        let paragraphTotal = 0
        for (let index = 0; index < question.paragraphs.length; index += 1) {
          const paragraph = question.paragraphs[index]
          const isFile = paragraph.kind === 'file'
          if (!isFile) {
            paragraphIndex += 1
            paragraphTotal += 1
          }
          const textMatched = spec.paragraph && !isFile && containsAll(paragraph.text, words)
          const fileHits = spec.paragraph ? matchesFiles(paragraph.files, words) : []
          if (!textMatched && fileHits.length === 0) continue
          paragraphCount += 1
          paragraphs.push({
            seq: paragraph.seq,
            index: isFile ? 0 : paragraphIndex,
            turn: questionNumber,
            kind: isFile ? 'file' : 'text',
            text: isFile ? '' : snippetOf(paragraph.text, words, SNIPPET_CHARS),
            anchor: isFile ? paragraph.files[0] || '' : paragraph.text.slice(0, ANCHOR_CHARS),
            hits: (textMatched ? countHits(paragraph.text, words) : 0) + fileHits.length,
            matched: true,
            textMatched,
            outputFiles: paragraph.files,
            matchedFiles: fileHits,
          })
        }
        if (!questionMatched && paragraphs.length === 0) continue
        questions.push({
          seq: questionSeq,
          number: questionNumber,
          anchor,
          text: anchorText === '' ? '' : snippetOf(anchorText, words, QUESTION_CHARS),
          matched: questionMatched,
          textMatched: partTextHit !== undefined,
          inputFiles: questionFiles,
          matchedFiles,
          paragraphTotal: paragraphTotal,
          paragraphs: paragraphs.slice(0, MAX_RESULT_PARAGRAPHS),
        })
        questionCount += 1
      }
      if (!sessionMatched && questions.length === 0) continue
      sessions.push({
        id: entry.id,
        title: entry.title,
        displayTitle: entry.displayTitle === '' ? entry.title : entry.displayTitle,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        matched: sessionMatched,
        questionTotal: entry.questions.length,
        paragraphTotal: entry.questions.reduce((sum, question) => sum + question.paragraphs.length, 0),
        questions: questions.slice(0, MAX_RESULT_QUESTIONS),
      })
      if (sessions.length >= MAX_RESULT_SESSIONS) {
        truncated = true
        break
      }
    }
  }

  return {
    query,
    scope,
    sessions,
    stats: {
      sessions: sessions.length,
      questions: questionCount,
      paragraphs: paragraphCount,
      indexed: corpus.size,
      truncated,
      /* matchMs is the pure matching cost; tookMs also carries index build and response shaping. */
      matchMs: Date.now() - matchStarted,
      tookMs: Date.now() - started,
    },
  }
}

// #endregion
