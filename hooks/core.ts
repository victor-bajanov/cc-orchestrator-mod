import type { AgentRow, Brief, Sample } from '../types'

export const MAX_SAMPLES = 180

type Usage = {
  input_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  output_tokens?: number
}

/** The context a response was answered over: what the next request starts from. */
export const contextOf = (u: Usage): number =>
  (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)

/** Halves the older half of the samples once there are too many; first and last stay. */
const thin = (s: Sample[]): Sample[] => {
  if (s.length <= MAX_SAMPLES) return s
  const half = Math.floor(s.length / 2)
  const older = s.slice(0, half).filter((_, i) => i % 2 === 0)
  return [...older, ...s.slice(half)]
}

export type Step = { id: string; tokens: number; t: number; tools: number }

export const newRow = (id: string, t: number): AgentRow => ({
  id,
  description: id === 'main' ? 'main thread' : '',
  type: id === 'main' ? 'main' : 'agent',
  status: 'running',
  tokens: 0,
  peak: 0,
  samples: [],
  steps: 0,
  tools: 0,
  startedAt: t,
  lastActive: t,
})

export const recordStep = (rows: AgentRow[], step: Step): AgentRow[] => {
  const known = rows.some(r => r.id === step.id)
  const all = known ? rows : [...rows, newRow(step.id, step.t)]
  return all.map(r =>
    r.id !== step.id
      ? r
      : {
          ...r,
          status: r.status === 'idle' ? 'running' : r.status,
          tokens: step.tokens,
          peak: Math.max(r.peak, step.tokens),
          steps: r.steps + 1,
          tools: r.tools + step.tools,
          lastActive: step.t,
          samples: thin([...r.samples, { t: step.t, tokens: step.tokens }]),
        },
  )
}

/** Live subagents at or past the threshold that have not been told yet. */
export const crossed = (rows: AgentRow[], threshold: number): AgentRow[] =>
  rows.filter(r => r.id !== 'main' && (r.status === 'running' || r.status === 'idle') && r.tokens >= threshold)

export const level = (tokens: number, threshold: number): 'ok' | 'warn' | 'hot' =>
  tokens >= threshold ? 'hot' : tokens >= threshold * 0.6 ? 'warn' : 'ok'

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const BLOCKS = '▁▂▃▄▅▆▇█'

/** One block per column: each bucket's peak over the ceiling, oldest left. */
export const sparkline = (samples: readonly Sample[], width: number, ceiling: number): string => {
  if (samples.length === 0 || width < 1) return ''
  const cols = Math.min(width, samples.length)
  let out = ''
  for (let c = 0; c < cols; c++) {
    const from = Math.floor((c * samples.length) / cols)
    const to = Math.floor(((c + 1) * samples.length) / cols)
    let peak = 0
    for (let i = from; i < to; i++) peak = Math.max(peak, samples[i]?.tokens ?? 0)
    const ratio = Math.min(1, Math.max(0, peak / ceiling))
    out += BLOCKS[Math.round(ratio * (BLOCKS.length - 1))]
  }
  return out
}

/**
 * One column per slice of the shared axis [t0, t1]: the agent's peak in that
 * slice, its last reading carried through slices with none, blank before its
 * first sample and after its last (unless still live).
 */
export const timeline = (
  samples: readonly Sample[],
  width: number,
  t0: number,
  t1: number,
  ceiling: number,
  isLive = false,
): string => {
  const cells: number[] = new Array(width).fill(-1)
  if (samples.length === 0 || width < 1) return ' '.repeat(Math.max(0, width))
  const span = Math.max(1, t1 - t0)
  const col = (t: number) => Math.min(width - 1, Math.max(0, Math.floor(((t - t0) / span) * width)))
  for (const s of samples) cells[col(s.t)] = Math.max(cells[col(s.t)] ?? -1, s.tokens)
  const first = col(samples[0]?.t ?? t0)
  const last = isLive ? width - 1 : col(samples[samples.length - 1]?.t ?? t0)
  let carry = -1
  let out = ''
  for (let c = 0; c < width; c++) {
    const v = cells[c] ?? -1
    if (v >= 0) carry = v
    if (c < first || c > last || carry < 0) {
      out += ' '
      continue
    }
    const ratio = Math.min(1, Math.max(0, carry / ceiling))
    out += BLOCKS[Math.round(ratio * (BLOCKS.length - 1))]
  }
  return out
}

/** Main first, then each agent under its parent in spawn order; unknown parents at the root. */
export const orderRows = (rows: readonly AgentRow[]): { row: AgentRow; depth: number }[] => {
  const ids = new Set(rows.map(r => r.id))
  const byStart = [...rows].sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.startedAt - b.startedAt))
  const kids = new Map<string, AgentRow[]>()
  const roots: AgentRow[] = []
  for (const r of byStart) {
    if (r.parentId !== undefined && ids.has(r.parentId) && r.parentId !== 'main') {
      kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r])
    } else roots.push(r)
  }
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (r: AgentRow, depth: number) => {
    out.push({ row: r, depth })
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return out
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export const notePathFor = (runDir: string, r: AgentRow, attempt: number): string =>
  `${runDir}/handover/${r.name ? slug(r.name) : 'agent'}-${r.id}-${attempt}.md`

export const label = (r: AgentRow): string => r.name ?? (r.description || r.id)

export const HANDOVER_CLAUSE = [
  '',
  '---',
  'Context-limit protocol (from the orchestrator mod): if you receive a message saying HANDOVER,',
  'stop work at a safe point, write a cold-restart handover note to the path given (task, decisions made,',
  'exact state of files and tests, what is done, what remains, next concrete step, gotchas, and every live',
  'child agent you started with its name, id and state), reply with the path, and end.',
].join('\n')

export const handoverMessage = (notePath: string, isRespawned: boolean): string =>
  [
    `HANDOVER. Your context is near its ceiling. Stop at the next safe point and write your cold-restart handover note to ${notePath}.`,
    isRespawned
      ? `Then end with this final reply and nothing else: "HANDED OVER: note at ${notePath}. The orchestrator mod has spawned the replacement with my brief; no action needed."`
      : `Then end with this final reply: "HANDED OVER: note at ${notePath}. Please spawn a replacement with my original brief plus: start from the handover note at ${notePath}."`,
  ].join(' ')

export const replacementPrompt = (brief: Brief, notePath: string): string =>
  `${brief.prompt}\n\n---\nYou replace an agent that reached its context limit. Start from the handover note at ${notePath}: read it first and continue from its next concrete step; do not redo finished work.`

export const mainHandoverPrompt = (notePath: string): string =>
  [
    `HANDOVER (orchestrator mod): this conversation is near its context ceiling and will be cleared and restarted from a note.`,
    `Write a cold-restart handover note to ${notePath} with: the user's goal and every decision they made, what is running (agents by name and id, background tasks), what is done, what remains, the next concrete step, file paths and gotchas.`,
    `Write only the note, then reply with its path. Do not start new work.`,
  ].join('\n')

export const resumePrompt = (o: { note: string; notePath: string; rosterPath: string; agents: AgentRow[] }): string => {
  const live = o.agents.filter(a => a.id !== 'main' && a.status !== 'done' && a.status !== 'replaced')
  const list = live.length
    ? live.map(a => `- ${label(a)} (id ${a.id}, ${a.type}, ${a.status}, ${fmtTokens(a.tokens)} context)`).join('\n')
    : '- none'
  return [
    `The conversation was cleared at its context ceiling by the orchestrator mod. Resume from your handover note (${o.notePath}):`,
    '',
    o.note.trim(),
    '',
    `Agents still known to the session (full roster at ${o.rosterPath}); they kept running through the clear and will report as before:`,
    list,
    '',
    `Re-orient (re-read anything the note points to), then continue from the note's next step.`,
  ].join('\n')
}

const when = (t: number) => (t ? new Date(t).toISOString().slice(11, 19) : '')

export const rosterMarkdown = (rows: readonly AgentRow[]): string =>
  [
    '| name | id | type | status | context | peak | started | note | replaced by / replaces |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      r =>
        `| ${label(r)} | ${r.id} | ${r.type} | ${r.status} | ${fmtTokens(r.tokens)} | ${fmtTokens(r.peak)} | ${when(r.startedAt)} | ${r.notePath ?? ''} | ${r.replacedBy ? `→ ${r.replacedBy}` : r.replaces ? `← ${r.replaces}` : ''} |`,
    ),
    '',
  ].join('\n')

/** Word-wraps text to `width` columns, hard-breaking longer words, each line padded so it paints every cell. */
export const wrapFill = (text: string, width: number): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    if (line && line.length + 1 + w.length <= width) {
      line += ` ${w}`
      continue
    }
    if (line) lines.push(line)
    while (w.length > width) {
      lines.push(w.slice(0, width))
      w = w.slice(width)
    }
    line = w
  }
  if (line || lines.length === 0) lines.push(line)
  return lines.map(l => l.padEnd(width))
}
