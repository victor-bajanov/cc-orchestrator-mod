import type { Transcript, TranscriptItem } from '../types'
import { PEEK_DENIED, cut, hhmm } from './view'

export type TimelineTurn = {
  /** Stable across rereads: the opening item's `key`, or 'earlier' for the leading orphan turn. */
  key: string
  /** 1-based, within the cached window. */
  number: number
  /** The opening user text on one line, uncut ('earlier steps' for the orphan turn). */
  preview: string
  /** '✎ 2 files' | '› 3 cmds' | '4 tools' | 'reply'. */
  outcome: string
  /** The opening item's `t`, when known. */
  t?: number
  /** toolUseId of the turn's first tool item; absent when it has none (no jump possible). */
  jumpTo?: string
  /** True for the last turn. */
  isCurrent: boolean
  /** The opening text item (absent on the orphan turn) then every later item up to the next turn. */
  items: TranscriptItem[]
}

const REMINDERS = /<system-reminder>(?:(?!<\/system-reminder>)[\s\S])*(?:<\/system-reminder>|$)/g
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** A user item's text on one line with system-reminder blocks removed (a block cut short loses the rest); undefined for anything else. */
const askOf = (item: TranscriptItem): string | undefined =>
  item.kind === 'text' && item.role === 'user' ? item.text.replace(REMINDERS, ' ').replace(/\s+/g, ' ').trim() : undefined

/** Whether an item opens a turn: a user text with something in it besides system reminders and a cut marker. */
const opens = (item: TranscriptItem): boolean => (askOf(item) ?? '').replace(/…$/, '').trim() !== ''

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What a turn did, first match: files written, commands run, other tools, else just a reply. */
const outcomeOf = (items: readonly TranscriptItem[]): string => {
  const tools = items.flatMap((i) => (i.kind === 'tool' ? [i] : []))
  const files = new Set(tools.filter((i) => FILE_TOOLS.has(i.tool)).map((i) => i.brief))
  if (files.size > 0) return `✎ ${plural(files.size, 'file', 'files')}`
  const cmds = tools.filter((i) => i.tool === 'Bash').length
  if (cmds > 0) return `› ${plural(cmds, 'cmd', 'cmds')}`
  return tools.length > 0 ? plural(tools.length, 'tool', 'tools') : 'reply'
}

const turnOf = (key: string, preview: string, items: TranscriptItem[]): Omit<TimelineTurn, 'number' | 'isCurrent'> => {
  const first = items[0]
  const jump = items.find((i) => i.kind === 'tool')
  return {
    key,
    preview,
    outcome: outcomeOf(items),
    ...(first?.t === undefined ? {} : { t: first.t }),
    ...(jump?.kind === 'tool' ? { jumpTo: jump.toolUseId } : {}),
    items,
  }
}

/** An agent's cached items as turns: each user text opens one, steps before the first form a leading turn. */
export const buildTimeline = (items: readonly TranscriptItem[]): TimelineTurn[] => {
  const groups: Omit<TimelineTurn, 'number' | 'isCurrent'>[] = []
  let open: { key: string; preview: string; items: TranscriptItem[] } | undefined
  const close = (): void => {
    if (open) groups.push(turnOf(open.key, open.preview, open.items))
  }
  for (const item of items) {
    if (opens(item)) {
      close()
      open = { key: item.key, preview: askOf(item) ?? '', items: [item] }
    } else if (open) {
      open.items.push(item)
    } else {
      open = { key: 'earlier', preview: 'earlier steps', items: [item] }
    }
  }
  close()
  return groups.map((g, i) => ({ ...g, number: i + 1, isCurrent: i === groups.length - 1 }))
}

/** `{ dim }` for undefined (`loading…`), denied (PEEK_DENIED) and no turns (`no messages yet`); else the turns. */
export const timelineOf = (tr: Transcript | undefined): { dim: string } | { turns: TimelineTurn[] } => {
  if (!tr) return { dim: 'loading…' }
  if ('denied' in tr) return { dim: PEEK_DENIED }
  const turns = buildTimeline(tr.items)
  return turns.length > 0 ? { turns } : { dim: 'no messages yet' }
}

/** `3 turns` (`1 turn`). */
export const turnCount = (turns: number): string => plural(turns, 'turn', 'turns')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

/** The width of the time column: `28 Oct`, and `• here` in its place on the current turn. */
export const TIME_W = 6

/** A turn's time: `hh:mm` for today, `D Mon` for an earlier day (both UTC, as the log's), `--:--` when unknown. */
export const stampOf = (t: number | undefined, now: number): string => {
  if (t === undefined) return '--:--'
  if (Math.floor(t / DAY_MS) === Math.floor(now / DAY_MS)) return hhmm(t)
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export type TimelineCols = { numW: number; outW: number }

/** The number column (the count's digits) and the outcome column (the widest outcome) of a Timeline's rows. */
export const timelineCols = (turns: readonly TimelineTurn[]): TimelineCols => ({
  numW: String(turns.length).length,
  outW: turns.reduce((w, t) => Math.max(w, t.outcome.length), 0),
})

export type TimelineRow = {
  /** Right-aligned in the number column. */
  num: string
  /** Cut to `room`, not padded. */
  preview: string
  /** The preview column's width. */
  room: number
  /** Right-aligned in the outcome column. */
  outcome: string
  here: boolean
  /** Right-aligned in TIME_W; the current turn draws `• here` instead. */
  time: string
}

/** One row's cells: the fold glyph, number, outcome and time columns and four single-space gaps come off the width, the preview gets the rest, never under 8 columns. */
export const timelineRow = (turn: TimelineTurn, width: number, cols: TimelineCols, now: number): TimelineRow => {
  const room = Math.max(8, width - (1 + cols.numW + cols.outW + TIME_W + 4))
  return {
    num: String(turn.number).padStart(cols.numW),
    preview: turn.preview.length > room ? cut(turn.preview, room) : turn.preview,
    room,
    outcome: turn.outcome.padStart(cols.outW),
    here: turn.isCurrent,
    time: stampOf(turn.t, now).padStart(TIME_W),
  }
}
