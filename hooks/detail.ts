import { cleanBlock, hhmm } from './view'
import type { ToolUseSummary } from 'claude-code'

export { cleanBlock }

/** One part of a tool call's detail view, drawn as `Code`, `Markdown` or `Text`. */
export type DetailSection =
  | { kind: 'code'; label: string; source: string; language?: string; path?: string; startLine?: number; diff?: true }
  | { kind: 'markdown'; label: string; text: string }
  | { kind: 'text'; label: string; text: string }

/** A tool call, laid out for the detail dialog. */
export type ToolDetail = {
  tool: string
  time: string
  isError: boolean
  isPending: boolean
  sections: DetailSection[]
}

/** The most one section's body may hold before it is cut with a note. */
export const SECTION_CHARS = 20_000
/** The most all sections' bodies may hold together; under the Code element's 100,000. */
export const TOTAL_CHARS = 60_000
/** Room kept for the `\n… (N more characters)` note after a cut. */
const NOTE = 40
/** How many lines of a Read result the excerpt keeps. */
const EXCERPT_LINES = 400


/**
 * One unified hunk turning `before` into `after`: shared leading and trailing
 * lines as context, the rest removed then added. Edit carries no line numbers,
 * so the hunk counts from line 1 of the edited text.
 */
/** A text's lines, CRLF or LF; the empty text has none. */
const lines = (s: string): string[] => (s === '' ? [] : s.split(/\r?\n/))

export const editDiff = (before: string, after: string): string => {
  const a = lines(before)
  const b = lines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const body = [
    ...a.slice(0, head).map((l) => ` ${l}`),
    ...a.slice(head, a.length - tail).map((l) => `-${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+${l}`),
    ...a.slice(a.length - tail).map((l) => ` ${l}`),
  ]
  return [`@@ -1,${a.length} +1,${b.length} @@`, ...body].join('\n')
}

const GUTTER = /^\s*(\d+)(?:→|\t)([^\n]*?)\r?$/

/**
 * A Read result without its line-number gutters (`  12→` or `  12\t`), and the
 * first line's number. Text with no gutter is returned as it is.
 */
export const readExcerpt = (text: string): { source: string; startLine?: number } => {
  const rows = text.split(/\r?\n/)
  const first = GUTTER.exec(rows[0] ?? '')
  if (!first) return { source: text }
  const kept: string[] = []
  for (const line of rows) {
    if (kept.length >= EXCERPT_LINES) break
    const m = GUTTER.exec(line)
    if (!m) break
    kept.push(m[2] ?? '')
  }
  return { source: kept.join('\n'), startLine: Number(first[1]) }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A section as built, before cleaning and caps; a diff carries what to draw when it does not fit. */
type Draft = DetailSection & { fallback?: DetailSection[] }

const code = (label: string, source: string, extra: { language?: string; path?: string; startLine?: number } = {}): DetailSection => {
  const s: DetailSection = { kind: 'code', label, source }
  if (extra.language !== undefined) s.language = extra.language
  if (extra.path !== undefined) s.path = extra.path
  if (extra.startLine !== undefined) s.startLine = extra.startLine
  return s
}
const text = (label: string, t: string): DetailSection => ({ kind: 'text', label, text: t })
const markdown = (label: string, t: string): DetailSection => ({ kind: 'markdown', label, text: t })

const json = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

const CHANGE = 'Change (line numbers relative to the edit)'

const editDrafts = (input: Record<string, unknown>, path: string | undefined): Draft[] => {
  const edits: { old: string; neu: string }[] = Array.isArray(input.edits)
    ? input.edits.map((e) => {
        const r = (e ?? {}) as Record<string, unknown>
        return { old: str(r.old_string) ?? '', neu: str(r.new_string) ?? '' }
      })
    : [{ old: str(input.old_string) ?? '', neu: str(input.new_string) ?? '' }]
  const at = path === undefined ? {} : { path }
  return [
    {
      kind: 'code',
      label: CHANGE,
      source: edits.map((e) => editDiff(e.old, e.neu)).join('\n'),
      diff: true,
      fallback: [
        code('Old', edits.map((e) => e.old).join('\n\n'), at),
        code('New', edits.map((e) => e.neu).join('\n\n'), at),
      ],
    },
  ]
}

const drafts = (use: ToolUseSummary): Draft[] => {
  const input = (use.input ?? {}) as Record<string, unknown>
  const out = str(use.text)
  const done = out !== undefined
  const path = str(input.file_path)
  const at = path === undefined ? {} : { path }
  switch (use.tool) {
    case 'Bash': {
      const desc = str(input.description)
      return [
        ...(desc ? [text('Description', desc)] : []),
        code('Command', str(input.command) ?? '', { language: 'bash' }),
        ...(done ? [code('Output', out)] : []),
      ]
    }
    case 'Edit':
    case 'MultiEdit': {
      const all = input.replace_all === true ? ' (all occurrences)' : ''
      return [
        text('File', `${path ?? ''}${all}`),
        ...editDrafts(input, path),
        ...(done ? [text('Result', out)] : []),
      ]
    }
    case 'Write':
      return [
        text('File', path ?? ''),
        code('Content', str(input.content) ?? '', { ...at, startLine: 1 }),
        ...(done ? [text('Result', out)] : []),
      ]
    case 'Read': {
      const offset = num(input.offset)
      const limit = num(input.limit)
      const range =
        offset !== undefined && limit !== undefined
          ? ` lines ${offset}–${offset + limit - 1}`
          : offset !== undefined
            ? ` from line ${offset}`
            : limit !== undefined
              ? ` lines 1–${limit}`
              : ''
      const ex = done ? readExcerpt(out) : undefined
      return [
        text('File', `${path ?? ''}${range}`),
        ...(ex ? [code('Excerpt', ex.source, { ...at, ...(ex.startLine === undefined ? {} : { startLine: ex.startLine }) })] : []),
      ]
    }
    case 'Grep':
    case 'Glob': {
      const fields: [string, unknown][] = [
        ['pattern', input.pattern],
        ['path', input.path],
        ['glob', input.glob],
        ['type', input.type],
        ['output mode', input.output_mode],
      ]
      const lines = fields.flatMap(([k, v]) => (typeof v === 'string' && v !== '' ? [`${k}: ${v}`] : []))
      return [text('Pattern', lines.join('\n')), ...(done ? [code('Results', out)] : [])]
    }
    case 'Agent':
    case 'Task': {
      const desc = str(input.description) ?? ''
      const type = str(input.subagent_type)
      return [
        text('Task', type ? `${desc} (${type})` : desc),
        markdown('Prompt', str(input.prompt) ?? ''),
        ...(done ? [markdown('Result', out)] : []),
      ]
    }
    default:
      return [code('Input', json(input), { language: 'json' }), ...(done ? [code('Result', out)] : [])]
  }
}

const bodyOf = (s: DetailSection): string => (s.kind === 'code' ? s.source : s.text)
const withBody = (s: DetailSection, b: string): DetailSection => (s.kind === 'code' ? { ...s, source: b } : { ...s, text: b })

/**
 * Cleans each draft and holds it to its section cap and what is left of the
 * total. Room for one more note is kept back, so drafts that no longer fit are
 * counted in a closing `… (N more sections)` line.
 */
const finish = (list: Draft[]): DetailSection[] => {
  const kept: DetailSection[] = []
  let used = 0
  const queue = [...list]
  while (queue.length > 0) {
    const room = Math.min(SECTION_CHARS, TOTAL_CHARS - used - 2 * NOTE)
    if (room <= 0) {
      const n = queue.length
      kept.push(text('Omitted', `… (${n} more section${n === 1 ? '' : 's'})`))
      break
    }
    const { fallback, ...s } = queue.shift() as Draft
    const b = cleanBlock(bodyOf(s as DetailSection))
    if (fallback && b.length > room) {
      queue.unshift(...fallback)
      continue
    }
    const capped = b.length > room ? `${b.slice(0, room)}\n… (${b.length - room} more characters)` : b
    used += capped.length
    kept.push(withBody(s as DetailSection, capped))
  }
  return kept
}

/**
 * A tool call laid out for its detail dialog, from its input and the result
 * text the model read (a subagent's transcript stores no structured record).
 * `t` is when the call was made, if the mod stamped it.
 */
export const toolDetail = (use: ToolUseSummary, t?: number): ToolDetail => ({
  tool: cleanBlock(str(use.tool) ?? ''),
  time: t === undefined ? '--:--' : hhmm(t),
  isError: use.isError === true,
  isPending: str(use.text) === undefined,
  sections: finish(drafts(use)),
})
