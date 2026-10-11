import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { AgentRow, AgentStatus, DisplayStatus, LogEntry, MainPhase, Sample, Transcript, TranscriptItem } from '../types'
import { fmtTokens, label } from './core'

export type { DisplayStatus }

export const MAIN_COLOR = '#6B7280'
export const PALETTE: readonly string[] = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00']
export const LIMIT_COLOR = '#DC2626'

/** Statuses the pane draws as live. */
export const LIVE: readonly AgentStatus[] = ['running', 'idle', 'handing-over']

/** Today's terminal header: live and handed-over subagents, the limits, the main mode and any phase. */
export const paneHeader = (
  rows: readonly AgentRow[],
  o: { agentThreshold: number; mainThreshold: number; mainMode: string; phase: MainPhase },
): string => {
  const subs = rows.filter(r => r.id !== 'main')
  const live = subs.filter(r => LIVE.includes(r.status)).length
  const replaced = subs.filter(r => r.status === 'replaced').length
  return `${live} live · ${replaced} handed over · limits ${fmtTokens(o.agentThreshold)} / main ${fmtTokens(o.mainThreshold)} (${o.mainMode}${o.phase !== 'idle' ? `, ${o.phase}` : ''})`
}

/** Whether either pane offers Hand over main: only in ask mode, and not while main is already handing over. */
export const mainButtonShown = (mode: string, phase: MainPhase): boolean =>
  mode === 'ask' && phase !== 'writing' && phase !== 'clearing'

/**
 * main → MAIN_COLOR; every other row in `rows` order (spawn order) → PALETTE[i % PALETTE.length],
 * so a later spawn never shifts an earlier agent's colour.
 */
export const seriesColors = (rows: readonly AgentRow[]): Map<string, string> => {
  const out = new Map<string, string>()
  let i = 0
  for (const row of rows) {
    out.set(row.id, row.id === 'main' ? MAIN_COLOR : (PALETTE[i++ % PALETTE.length] ?? MAIN_COLOR))
  }
  return out
}

/** The UTC hh:mm of a time, as the terminal pane shows it. */
export const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16)

/** An activity line cut to `fits` characters, ending in an ellipsis. */
export const cut = (text: string, fits: number): string => `${text.slice(0, Math.max(1, fits - 1))}…`

/** Text safe for one pane line: ANSI escapes and control characters removed. */
const clean = (s: string): string =>
  s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

/** What the pane shows when an agent's transcript cannot be read. */
export const PEEK_DENIED = 'transcript not readable (teammate in another pane, or finished)'

/** Model families the mod names, and the effort levels it abbreviates. */
const FAMILY = 'opus|sonnet|haiku|fable'
const EFFORT: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/**
 * A model id or alias as a short display name: `claude-sonnet-5-5` → `Sonnet 5.5`,
 * `claude-3-5-sonnet-…` → `Sonnet 3.5`, `sonnet` → `Sonnet`, `inherit` → ''.
 * Context suffixes, provider prefixes, versions and dates are dropped first;
 * anything else stays as written, cut to 16 characters.
 */
export const modelName = (id: string): string => {
  const raw = id.trim()
  const s = raw
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^.*anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-latest$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase()
  if (s === '' || s === 'inherit') return ''
  const modern = new RegExp(`^claude-(${FAMILY})-(\\d+)(?:-(\\d{1,2}))?$`).exec(s)
  if (modern) return `${capital(modern[1]!)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ''}`
  const legacy = new RegExp(`^claude-(\\d+)(?:-(\\d))?-(${FAMILY})$`).exec(s)
  if (legacy) return `${capital(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`
  if (new RegExp(`^(${FAMILY})$`).test(s)) return capital(s)
  return raw.length > 16 ? cut(raw, 16) : raw
}

/** An effort level abbreviated (`medium` → `med`), a token budget formatted (`32000` → `32k`), else as written. */
export const effortAbbrev = (effort: string): string =>
  EFFORT[effort] ?? (/^\d+$/.test(effort) ? fmtTokens(Number(effort)) : effort)

/** `Sonnet 5.5 med`: '' when the model is unknown, the model alone when the effort is. */
export const modelLabel = (model?: string, effort?: string): string => {
  const name = model ? modelName(model) : ''
  if (name === '') return ''
  const e = effort ? effortAbbrev(effort) : ''
  return e ? `${name} ${e}` : name
}

/** Statuses a child can hold that keep its idle parent waiting. */
const BUSY: readonly AgentStatus[] = ['running', 'idle', 'handing-over']

/**
 * What the pane shows for a row: `waiting` when it is idle and a child (its
 * `parentId` is this row's id) is running, idle or handing over, else its own
 * status. An idle child counts, so waiting holds up a whole chain. Display only:
 * every handover, stall and sync check keeps reading `row.status`.
 */
export const displayStatus = (row: AgentRow, rows: readonly AgentRow[]): DisplayStatus =>
  row.status === 'idle' && rows.some(r => r.parentId === row.id && r.id !== row.id && BUSY.includes(r.status))
    ? 'waiting'
    : row.status

/** The terminal's glyph and status-word style per status, in theme keys so it follows the theme. */
export const statusStyle = (status: DisplayStatus): { color: string; dimColor?: true; bold?: true } => {
  switch (status) {
    case 'waiting':
      return { color: 'planMode' }
    case 'running':
      return { color: 'success', bold: true }
    case 'idle':
      return { color: 'warning', dimColor: true }
    case 'done':
      return { color: 'success', dimColor: true }
    case 'stalled':
      return { color: 'error', bold: true }
    case 'handing-over':
      return { color: 'suggestion', bold: true }
    case 'replaced':
      return { color: 'inactive', dimColor: true }
  }
}

/** djb2 over UTF-16 code units, as an unsigned 32-bit number. */
const djb2 = (s: string): number => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** djb2 of a string, base 36. */
export const hashText = (s: string): string => djb2(s).toString(36)

/** A running agent's runner, fixed per id: 🏃‍♂️ for an even hash, 🏃‍♀️ for an odd one. */
export const runnerFor = (id: string): string => (djb2(id) % 2 === 0 ? '🏃‍♂️' : '🏃‍♀️')

/** The desktop's status emoji, placed before the status word. */
export const statusEmoji = (status: DisplayStatus, id: string): string => {
  switch (status) {
    case 'waiting':
      return '⏳'
    case 'running':
      return runnerFor(id)
    case 'idle':
      return '😴'
    case 'done':
      return '✅'
    case 'stalled':
      return '🛑'
    case 'handing-over':
      return '📝'
    case 'replaced':
      return '♻️'
  }
}

/** Text safe for a Code, Markdown or Text body: ANSI escapes and every control character but `\n` and `\t` removed. */
export const cleanBlock = (s: string): string =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

/** Text as one pane line: control characters stripped, then whitespace collapsed and trimmed. */
const oneLine = (s: string): string => clean(cleanBlock(s).replace(/\s+/g, ' ')).trim()

/**
 * The key a message's text is stamped and looked up under: `txt:` plus the hash of
 * its role and its whole one-line text, so whitespace and escapes do not change it.
 */
export const textKey = (role: string, text: string): string => `txt:${hashText(`${role}:${oneLine(text)}`)}`

/** `$.session.messages` gives at most this many entries; a list this long may have lost its first (the brief). */
const MESSAGES_CAP = 4096

/** The longest tool brief kept. */
const BRIEF_CHARS = 300

/** The input field each tool is summed up by; other tools use their first string field. */
const BRIEF_FIELD: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  Agent: 'description',
}

/** A tool call in one line: Bash's command, a file's path, a search's `pattern in path`, … capped at 300. */
export const toolBrief = (tool: string, input: Record<string, unknown>): string => {
  const field = BRIEF_FIELD[tool]
  const named = field !== undefined ? input[field] : undefined
  let brief = typeof named === 'string' ? named : (Object.values(input).find(v => typeof v === 'string') as string | undefined) ?? ''
  if ((tool === 'Grep' || tool === 'Glob') && typeof named === 'string' && typeof input.path === 'string' && input.path !== '') {
    brief = `${named} in ${input.path}`
  }
  const line = oneLine(brief)
  return line.length > BRIEF_CHARS ? cut(line, BRIEF_CHARS) : line
}

/**
 * An agent's last `n` transcript items: per message, its text (cleaned, newlines kept,
 * capped at `chars`) then one item per tool call. A user row of tool results alone adds
 * nothing; its outcome is on the call. It reads from the end and stops once it has
 * `n` items. Times come from `stampOf` (a call's id, a text's `textKey`, else the
 * message's first call), message 0 (the brief, unless the list hit the 4096 cap)
 * falls back to `startedAt`, and an
 * item never seen has no `t`. A repeated text's keys are numbered over the whole list.
 */
export const transcriptItems = (
  messages: readonly SessionMessage[],
  stampOf: (key: string) => number | readonly number[] | undefined,
  o: { n: number; chars: number; startedAt: number },
): TranscriptItem[] => {
  const groups: TranscriptItem[][] = []
  let count = 0
  let occ: Occurrences | undefined
  /** A single stamp, or the newest of a list. */
  const one = (key: string): number | undefined => {
    const s = stampOf(key)
    return typeof s === 'number' ? s : s?.[s.length - 1]
  }
  /** Occurrence `n` of `total` of a text: a single stamp serves all; a list is aligned from the end. */
  const nthStamp = (key: string, n: number, total: number): number | undefined => {
    const s = stampOf(key)
    if (s === undefined || typeof s === 'number') return s
    return s[n - (total - s.length)]
  }
  for (let i = messages.length - 1; i >= 0 && count < o.n; i--) {
    const m = messages[i]!
    const uses: readonly ToolUseSummary[] = m.toolUses
    const fallback = i === 0 && messages.length < MESSAGES_CAP ? o.startedAt : undefined
    const group: TranscriptItem[] = []
    if (oneLine(m.text) !== '') {
      occ ??= occurrences(messages)
      const key = occ.keyOf(i)
      const n = occ.nth[i]!
      const t = nthStamp(key, n, occ.total.get(key) ?? n + 1) ?? (uses[0] ? one(uses[0].tool_use_id) : undefined) ?? fallback
      const text = cleanBlock(m.text).trim()
      const capped = text.length > o.chars ? cut(text, o.chars) : text
      group.push({ kind: 'text', key: `${key}#${n}`, ...(t !== undefined && { t }), role: m.role, text: capped })
    }
    for (const u of uses) {
      const t = one(u.tool_use_id) ?? fallback
      group.push({
        kind: 'tool',
        key: `tool:${u.tool_use_id}`,
        ...(t !== undefined && { t }),
        toolUseId: u.tool_use_id,
        tool: clean(u.tool),
        brief: toolBrief(u.tool, u.input ?? {}),
        ...(u.isError && { isError: true as const }),
        ...(u.text === undefined && { isPending: true as const }),
      })
    }
    if (group.length) groups.push(group)
    count += group.length
  }
  return groups.reverse().flat().slice(-o.n)
}

type Occurrences = { nth: number[]; total: Map<string, number>; keyOf: (i: number) => string }

/**
 * Per message, how many earlier messages carry the same text key, counted over the whole list in
 * one pass so a repeat's key stays put as the window slides, and each key's total. A text's key is
 * hashed once per distinct raw text, not once per message.
 */
const occurrences = (messages: readonly SessionMessage[]): Occurrences => {
  const byRaw = new Map<string, string>()
  const seen = new Map<string, number>()
  const keys: string[] = []
  const nth = messages.map((m, i) => {
    if (m.text === '') return 0
    const raw = `${m.role}\u0000${m.text}`
    let key = byRaw.get(raw)
    if (key === undefined) byRaw.set(raw, (key = textKey(m.role, m.text)))
    keys[i] = key
    const k = seen.get(key) ?? 0
    seen.set(key, k + 1)
    return k
  })
  return { nth, total: seen, keyOf: i => keys[i] ?? textKey(messages[i]!.role, messages[i]!.text) }
}

export type TranscriptLine = {
  id: string
  time: string
  short: string
  full?: string
  kind: TranscriptItem['kind']
  toolUseId?: string
  isError?: true
  isPending?: true
  role?: 'user' | 'assistant'
}

/**
 * What the pane draws for a selected agent's cached transcript: one dim line
 * (`loading…`, the not-readable line, or `no messages yet`), or its last `n`
 * items, each with its `hh:mm` (or `--:--`) and its content on one line, cut to
 * `width - 6` less any tool markers; `full` holds the whole content (newlines
 * kept) only when it was cut.
 */
export const transcriptView = (
  tr: Transcript | undefined,
  width: number,
  n: number,
): { dim: string } | { items: TranscriptLine[] } => {
  if (!tr) return { dim: 'loading…' }
  if ('denied' in tr) return { dim: PEEK_DENIED }
  if (tr.items.length === 0) return { dim: 'no messages yet' }
  const fits = Math.max(1, width - 6)
  return {
    items: tr.items.slice(-n).map(it => {
      const content = it.kind === 'text' ? it.text : `⚙ ${it.tool}${it.brief ? ` ${it.brief}` : ''}`
      const line = it.kind === 'text' ? oneLine(content) : content
      // Room for the markers drawn around a tool item: `✗ ` before it, ` (running)` after.
      // A user text's `» ` takes two more.
      const room =
        it.kind === 'tool'
          ? Math.max(1, fits - (it.isError ? 2 : 0) - (it.isPending ? 10 : 0))
          : Math.max(1, fits - (it.role === 'user' ? 2 : 0))
      const isCut = line.length > room
      return {
        id: `step-${it.key}`,
        time: it.t === undefined ? '--:--' : hhmm(it.t),
        short: isCut ? cut(line, room) : line,
        ...(isCut && { full: content }),
        kind: it.kind,
        ...(it.kind === 'text'
          ? { role: it.role }
          : { toolUseId: it.toolUseId, ...(it.isError && { isError: it.isError }), ...(it.isPending && { isPending: it.isPending }) }),
      }
    }),
  }
}

/** The context limit a row is held to: main's for main, the agents' otherwise. */
export const ceilingOf = (r: AgentRow, t: { agentThreshold: number; mainThreshold: number }): number =>
  r.id === 'main' ? t.mainThreshold : t.agentThreshold

/** `log-${t}-${text.length}`: the id the terminal card already uses. */
export const logId = (l: LogEntry): string => `log-${l.t}-${l.text.length}`

/** clamp(bodyColumns * 8, 320, 1200) */
export const chartWidthPx = (bodyColumns: number): number => Math.min(1200, Math.max(320, bodyColumns * 8))

export type ChartInput = {
  rows: readonly AgentRow[]
  now: number
  width: number // CSS px
  height: number // CSS px
  agentThreshold: number
  mainThreshold: number
  colors: ReadonlyMap<string, string>
  selected?: string // agent id; '' or undefined = none
  /** The left edge of the time axis; defaults to the earliest start among `rows` (or `now`). */
  t0?: number
}

const M = { left: 44, right: 8, top: 8, bottom: 20 }
const AXIS = `fill="${MAIN_COLOR}" font-family="system-ui, sans-serif" font-size="10"`

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

const r1 = (n: number) => Math.round(n)

/** At most `max` samples: first and last kept, each bucket between reduced to its peak. */
const downsample = (s: readonly Sample[], max: number): readonly Sample[] => {
  if (s.length <= max || max < 2) return s
  const inner = s.slice(1, -1)
  const buckets = max - 2
  const out: Sample[] = [s[0]!]
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * inner.length) / buckets)
    const to = Math.floor(((b + 1) * inner.length) / buckets)
    let peak: Sample | undefined
    for (let i = from; i < to; i++) if (!peak || inner[i]!.tokens > peak.tokens) peak = inner[i]
    if (peak) out.push(peak)
  }
  out.push(s[s.length - 1]!)
  return out
}

/** Points shared by every series, so many agents still fit the Svg source limit. */
const POINT_BUDGET = 6000
/** The Svg element's source limit on remote surfaces. */
const SOURCE_LIMIT = 131_072
/** Tooltip labels are cut to this many characters. */
const TITLE_LABEL = 80

/** The context chart for remote surfaces: one step-after line per agent over a shared time axis. */
export const contextChart = (i: ChartInput): { source: string; alt: string; width: number; height: number } => {
  const W = i.width
  const H = i.height
  const plotW = W - M.left - M.right
  const plotH = H - M.top - M.bottom
  const right = M.left + plotW
  const bottom = M.top + plotH
  const series = i.rows.filter(r => r.samples.length > 0)
  const t0 = i.t0 ?? i.rows.reduce((m, r) => Math.min(m, r.startedAt), i.now)
  const span = Math.max(1, i.now - t0)
  const peak = series.reduce((m, r) => Math.max(m, r.peak), 0)
  const yMax = Math.max(i.agentThreshold, i.mainThreshold, peak, 1) * 1.05
  const x = (t: number) => r1(Math.min(right, Math.max(M.left, M.left + ((t - t0) / span) * plotW)))
  const y = (v: number) => r1(M.top + plotH * (1 - Math.min(1, Math.max(0, v / yMax))))
  const ceiling = (r: AgentRow) => ceilingOf(r, i)
  const sel = i.selected ?? ''

  const head: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`,
    `<line x1="${M.left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${MAIN_COLOR}" stroke-width="1"/>`,
    `<text x="${M.left - 4}" y="${bottom}" text-anchor="end" ${AXIS}>0</text>`,
    `<text x="${M.left}" y="${H - 4}" ${AXIS}>${hhmm(t0)}</text>`,
    `<text x="${right}" y="${H - 4}" text-anchor="end" ${AXIS}>${hhmm(i.now)}</text>`,
  ]

  const limits =
    i.agentThreshold === i.mainThreshold
      ? [{ v: i.agentThreshold, text: `limit ${fmtTokens(i.agentThreshold)}` }]
      : [
          { v: i.agentThreshold, text: `agent limit ${fmtTokens(i.agentThreshold)}` },
          { v: i.mainThreshold, text: `main limit ${fmtTokens(i.mainThreshold)}` },
        ]
  for (const l of limits) {
    const ly = y(l.v)
    head.push(
      `<line x1="${M.left}" y1="${ly}" x2="${right}" y2="${ly}" stroke="${LIMIT_COLOR}" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<text x="${M.left + 2}" y="${ly - 2}" ${AXIS}>${esc(l.text)}</text>`,
    )
  }

  const maxPoints = Math.max(2, Math.min(Math.floor(plotW / 3), Math.floor(POINT_BUDGET / Math.max(1, series.length))))
  type Drawn = { path: string; circle: string; title: string }
  const len = (s: Drawn, withCircleTitle: boolean) =>
    s.path.length + s.circle.length + '</circle>'.length + (withCircleTitle ? s.title.length : 0)
  const drawn = new Map<AgentRow, Drawn>()
  for (const r of series) {
    const pts = downsample(r.samples, maxPoints)
    const first = pts[0]!
    let d = `M${x(first.t)} ${y(first.tokens)}`
    let lastY = y(first.tokens)
    for (const p of pts.slice(1)) {
      const py = y(p.tokens)
      d += `H${x(p.t)}`
      if (py !== lastY) d += `V${py}`
      lastY = py
    }
    if (LIVE.includes(r.status)) d += `H${right}`
    const last = pts[pts.length - 1]!
    const color = i.colors.get(r.id) ?? MAIN_COLOR
    const isSel = sel !== '' && r.id === sel
    const width = isSel ? '3' : '1.5'
    const opacity = sel !== '' && !isSel ? '0.3' : '1'
    const name = label(r)
    const shown = name.length > TITLE_LABEL ? cut(name, TITLE_LABEL) : name
    const title = `<title>${esc(`${shown} · ${fmtTokens(r.tokens)} / ${fmtTokens(ceiling(r))} · ${r.status}`)}</title>`
    drawn.set(r, {
      path: `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}">${title}</path>`,
      circle: `<circle cx="${x(last.t)}" cy="${y(last.tokens)}" r="3" fill="${color}" opacity="${opacity}">`,
      title,
    })
  }

  // Still past the limit: drop the oldest finished series until it fits; live ones always stay.
  const tail = '</svg>'
  let size = head.join('').length + tail.length + [...drawn.values()].reduce((n, s) => n + len(s, true), 0)
  const droppable = series.filter(r => !LIVE.includes(r.status)).sort((a, b) => a.startedAt - b.startedAt)
  let dropped = 0
  for (const r of droppable) {
    if (size < SOURCE_LIMIT) break
    const s = drawn.get(r)
    size -= s ? len(s, true) : 0
    drawn.delete(r)
    dropped++
  }
  // Live series alone still too long: the circles give up their tooltips; the lines keep theirs.
  const circleTitles = size < SOURCE_LIMIT

  const kept = series.filter(r => drawn.has(r))
  const parts = kept.map(r => `${label(r)} ${fmtTokens(r.tokens)} of ${fmtTokens(ceiling(r))}`)
  if (dropped) parts.push(`${dropped} finished agent${dropped === 1 ? '' : 's'} not drawn`)
  const alt = series.length ? `Context over time: ${parts.join('; ')}` : 'No model requests yet.'
  const body = kept.map(r => {
    const s = drawn.get(r)!
    return `${s.path}${s.circle}${circleTitles ? s.title : ''}</circle>`
  })
  return { source: [...head, ...body, tail].join(''), alt, width: W, height: H }
}

/**
 * Whether a `SendMessage` `to` names this row: its id or name, or `main` for the main thread. A
 * trailing ` [ref]` (as ListAgents prints a row) is ignored.
 */
export const namesAgent = (to: unknown, row: Pick<AgentRow, 'id' | 'name' | 'teammateId'>): boolean => {
  if (typeof to !== 'string') return false
  const name = to.replace(/\s*\[[^\]]*\]$/, '').trim()
  if (name === '') return false
  if (row.id === 'main') return name === 'main'
  if (name === row.id || name === row.name) return true
  // A teammate by its address: its teammateId, or its registered name at that address's team.
  const tid = row.teammateId
  if (typeof tid !== 'string' || !tid.includes('@')) return false
  return name === tid || (row.name !== undefined && name === `${row.name}@${tid.slice(tid.lastIndexOf('@') + 1)}`)
}

/**
 * The agent `target` means among `rows`: its id; else its registered name (the name SendMessage uses),
 * a live holder first, else the newest; else the name it asked for at spawn (`brief.name`), when that
 * picks one agent (or one live agent). A trailing ` [ref]` is ignored. `ambiguous` lists the candidates.
 */
export const resolveAgent = (
  rows: readonly AgentRow[],
  target: string,
): { row: AgentRow } | { ambiguous: AgentRow[] } | undefined => {
  const t = target.replace(/\s*\[[^\]]*\]$/, '').trim()
  if (t === '') return undefined
  const byId = rows.find(r => r.id === t)
  if (byId) return { row: byId }
  const isLive = (r: AgentRow) => LIVE.includes(r.status)
  const named = rows.filter(r => r.name === t)
  const holder = named.filter(isLive).at(-1) ?? named.at(-1)
  if (holder) return { row: holder }
  const asked = rows.filter(r => r.brief?.name === t)
  if (asked.length === 0) return undefined
  if (asked.length === 1) return { row: asked[0]! }
  const live = asked.filter(isLive)
  if (live.length === 1) return { row: live[0]! }
  return { ambiguous: live.length ? live : asked }
}

/** The newest agent in an id's `replacedBy` chain: whoever now carries its work (the id itself when never replaced). */
export const latest = (rows: readonly AgentRow[], id: string): string => {
  const seen = new Set<string>()
  let cur = id
  while (!seen.has(cur)) {
    seen.add(cur)
    const next = rows.find(r => r.id === cur)?.replacedBy
    if (next === undefined) break
    cur = next
  }
  return cur
}

/**
 * Whether two reports say the same: equal once whitespace is collapsed, or one holding the
 * other and at least 80% of its length.
 */
export const sameReport = (a: string, b: string): boolean => {
  const x = oneLine(a)
  const y = oneLine(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.includes(short) && short.length >= long.length * 0.8
}

/** Rows whose check-in deadline has come. */
export const checkinDue = (rows: readonly AgentRow[], now: number): AgentRow[] =>
  rows.filter(r => r.checkinAt !== undefined && r.checkinAt <= now)

/**
 * Whether a child's final answer goes to its parent agent, and whether it may repeat what the child
 * already sent. Skipped: a parent that is main or unknown (the engine tells main), a teammate or a
 * foreground child (its answer is delivered), a handover, an empty or unfinished answer, and a run
 * whose delivered report to the parent was its last act or says the same as the answer. A lost
 * report costs more than a duplicate, so anything else is forwarded, to the parent's `latest`.
 */
export const forwardTarget = (
  row: AgentRow,
  answer: string,
  reason: string,
  rows: readonly AgentRow[] = [],
): 'skip' | { agentId: string; mayDuplicate: boolean } => {
  const parent = row.parentId
  if (parent === undefined || parent === 'main') return 'skip'
  // A replacement's own spawn was the mod's, so its answer reaches no one unless forwarded, foreground or not.
  if (row.isTeammate || (row.background === false && row.replaces === undefined)) return 'skip'
  if (row.status === 'handing-over' || row.status === 'stalled') return 'skip'
  if (reason !== 'answer' || answer.trim() === '') return 'skip'
  const r = row.report
  if (r?.ok && (r.final || sameReport(r.text, answer))) return 'skip'
  // A parent that handed over is carried on by its replacement: the answer goes there.
  return { agentId: latest(rows, parent), mayDuplicate: r !== undefined }
}

/** A row's children: rows whose `parentId` is its id; main's also include rows with no parent. */
export const childrenOf = (rows: readonly AgentRow[], id: string): AgentRow[] =>
  rows.filter(r => r.id !== id && r.id !== 'main' && (r.parentId === id || (id === 'main' && r.parentId === undefined)))

/** Every descendant of a row, each once (cycle-safe). */
const descendants = (rows: readonly AgentRow[], id: string): AgentRow[] => {
  const out: AgentRow[] = []
  const seen = new Set<string>([id])
  const walk = (at: string) => {
    for (const c of childrenOf(rows, at)) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
      walk(c.id)
    }
  }
  walk(id)
  return out
}

const FINISHED: readonly AgentStatus[] = ['done', 'replaced']

/**
 * The rows a collapsed tree hides: for each collapsed id naming a present row, its finished (done or
 * replaced) descendants that have no live descendant of their own. Nothing live is ever hidden, and a
 * finished agent above a live one stays, so the tree never orphans a live row. Display only.
 */
export const collapseHidden = (rows: readonly AgentRow[], collapsed: readonly string[]): Set<string> => {
  const hidden = new Set<string>()
  for (const id of collapsed) {
    if (!rows.some(r => r.id === id)) continue
    for (const d of descendants(rows, id)) {
      if (FINISHED.includes(d.status) && descendants(rows, d.id).every(x => FINISHED.includes(x.status))) hidden.add(d.id)
    }
  }
  return hidden
}

/** How many of a row's descendants are hidden. */
export const hiddenCount = (rows: readonly AgentRow[], id: string, hidden: ReadonlySet<string>): number =>
  descendants(rows, id).filter(d => hidden.has(d.id)).length

/** Whether a row offers to fold: it is collapsed (so it can expand), or collapsing it would hide something. */
export const canFold = (rows: readonly AgentRow[], id: string, collapsed: readonly string[]): boolean =>
  collapsed.includes(id) || collapseHidden(rows, [id]).size > 0

/** The disclosure glyph: `▸` when collapsed, `▾` when not. */
export const foldGlyph = (isCollapsed: boolean): string => (isCollapsed ? '▸' : '▾')
