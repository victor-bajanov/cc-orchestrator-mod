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

const REMINDER = /^(?:<system-reminder>(?:(?!<\/system-reminder>)[\s\S])*<\/system-reminder>\s*)+$/
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** Whether an item opens a turn: a user text with something in it besides a system reminder. */
const opens = (item: TranscriptItem): boolean => {
  if (item.kind !== 'text' || item.role !== 'user') return false
  const text = item.text.trim()
  return text !== '' && !REMINDER.test(text)
}

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
      open = { key: item.key, preview: item.kind === 'text' ? item.text.replace(/\s+/g, ' ').trim() : '', items: [item] }
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

/** `Timeline · <name> · N turns` (`1 turn`). */
export const timelineHeader = (name: string, turns: number): string => `Timeline · ${name} · ${plural(turns, 'turn', 'turns')}`

export type TimelineRow = {
  num: string
  preview: string
  outcome: string
  here: boolean
  time: string
}

/** One row's cells: the fixed ones (number, outcome, time, jump, `• here`) and single-space gaps come off the width, the preview gets the rest, never under 8 columns. */
export const timelineRow = (turn: TimelineTurn, width: number, numW: number): TimelineRow => {
  const cells = turn.isCurrent ? 6 : 5
  const fixed = numW + turn.outcome.length + 5 + 2 + (turn.isCurrent ? 7 : 0) + (cells - 1)
  const room = Math.max(8, width - fixed)
  return {
    num: String(turn.number).padStart(numW),
    preview: turn.preview.length > room ? cut(turn.preview, room) : turn.preview,
    outcome: turn.outcome,
    here: turn.isCurrent,
    time: turn.t === undefined ? '--:--' : hhmm(turn.t),
  }
}
