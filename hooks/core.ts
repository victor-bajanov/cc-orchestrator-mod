import type { AgentRow, Brief, Sample, Shell, ShellExit } from '../types'

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
          // A step proves it alive: idle wakes, and done (or respawn-failed) was resumed by a message. A stalled
          // handover stays stalled: its run's end checks for the note it may still be writing and
          // marks it replaced or done, which running would skip (its end would only set idle).
          status: r.status === 'idle' || r.status === 'done' || r.status === 'respawn-failed' ? 'running' : r.status,
          ...(r.status === 'done' || r.status === 'respawn-failed' ? { resumedAt: step.t } : {}),
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

/** The old agent's children now hang under its replacement (display, waiting, collapse and check-ins follow parentId). */
export const adoptChildren = (rows: AgentRow[], oldId: string, newId: string): AgentRow[] =>
  rows.map(r => (r.parentId === oldId && r.id !== newId ? { ...r, parentId: newId } : r))

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
      ? `Then end with this final reply and nothing else: "HANDED OVER: note at ${notePath}. The orchestrator mod will spawn the replacement with my brief and tell you; no action needed unless it reports that none started."`
      : `Then end with this final reply: "HANDED OVER: note at ${notePath}. Please spawn a replacement with my original brief plus: start from the handover note at ${notePath}."`,
  ].join(' ')

export const replacementPrompt = (brief: Brief, notePath: string): string =>
  `${brief.prompt}\n\n---\nYou replace an agent that reached its context limit. Start from the handover note at ${notePath}: read it first and continue from its next concrete step; do not redo finished work.`

/** Tells an agent the engine registered it under a suffixed name, so its children report to the right one. */
export const nameNotice = (name: string, requested: string): string =>
  `[orchestrator mod] You are registered as \`${name}\` (you asked for \`${requested}\`); tell your children to SendMessage \`${name}\`.`

/** Where a failed respawn's replacement prompt is saved: beside its note, as `<note>.brief.md`. */
export const briefPathFor = (notePath: string): string => notePath.replace(/\.md$/, '') + '.brief.md'

/** Tells a parent that its child handed over but no replacement started, and how to start one itself. */
export const respawnFailedNotice = (o: {
  label: string
  id: string
  notePath: string
  reason: string
  brief?: Brief
  briefPath?: string
}): string => {
  const head =
    `[orchestrator mod] Agent ${o.label} (id ${o.id}) handed over (note at ${o.notePath}), but no replacement started: ${o.reason}. ` +
    `Nothing is carrying its work now. Spawn the replacement yourself`
  const startLine = `"Start from the handover note at ${o.notePath}: read it first and continue from its next concrete step."`
  if (!o.brief) return `${head} with its original brief plus: ${startLine} No brief was recorded for it.`
  const b = o.brief
  const opts = [
    b.name && `name "${b.name}"`,
    `subagent_type "${b.subagentType}"`,
    b.model && `model "${b.model}"`,
    `description "${b.description}"`,
  ]
    .filter(Boolean)
    .join(', ')
  return o.briefPath
    ? `${head}: the Agent tool with ${opts}, and as its prompt the text of ${o.briefPath} (its original brief plus the line to start from the note).`
    : `${head}: the Agent tool with ${opts}, and its original brief plus: ${startLine}`
}

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

/** The most lines activity.log keeps; the oldest go first. */
export const ACTIVITY_MAX = 2000

/** One activity.log line: UTC ISO time, level, the text on one line. */
export const activityLine = (t: number, level: 'info' | 'warn', text: string): string =>
  `${new Date(t).toISOString()} ${level === 'warn' ? 'WARN' : 'info'} ${text.replace(/\r?\n/g, ' ⏎ ')}`

// ---- background shells

/** A number setting: the value when finite and not negative, else the default. */
export const numberSetting = (v: unknown, d: number): number => {
  const n = Number(v ?? d)
  return Number.isFinite(n) && n >= 0 ? n : d
}

/** Where a backgrounded Bash call's result text says its output goes. */
export const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\./

/**
 * The shell a Bash call sent to the background, explicitly or by the engine: its id and output path ('' when the
 * text names none). None for a deny, an error, a foreground call, or one that dies with its caller's final response.
 */
export const backgroundedShell = (res: unknown): { id: string; outputPath: string } | undefined => {
  if (!res || typeof res !== 'object') return undefined
  const r = res as { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown }
  if (r.deny || r.isError) return undefined
  const result = (r.result ?? {}) as { backgroundTaskId?: unknown; backgroundEndsWithFinalResponse?: unknown }
  const id = result.backgroundTaskId
  if (typeof id !== 'string' || !id || result.backgroundEndsWithFinalResponse === true) return undefined
  const m = typeof r.text === 'string' ? OUTPUT_PATH.exec(r.text) : null
  return { id, outputPath: m?.[1] ?? '' }
}

/** The exit marker the engine appends to an output file, read at its end: a code, `killed`, or none yet. */
export const shellExit = (text: string): number | 'killed' | undefined => {
  const m = /\n\[(?:exited with code (\d+)|killed)\]\n$/.exec(text.slice(-256))
  if (!m) return undefined
  return m[1] === undefined ? 'killed' : Number(m[1])
}

export const shellEndWords = (exit: ShellExit): string =>
  exit === 'killed' ? 'was killed' : exit === 'unknown' ? 'finished (exit code unknown)' : `exited with code ${exit}`

export const openShells = (r: AgentRow): Shell[] => (r.shells ?? []).filter(s => s.exit === undefined)

/** Tracks a shell on its agent's row (replacing one with the same id); a new shell re-arms the idle watchdog. */
export const addShell = (rows: AgentRow[], agentId: string, shell: Shell): AgentRow[] =>
  rows.some(r => r.id === agentId)
    ? rows.map(r =>
        r.id !== agentId
          ? r
          : { ...r, shells: [...(r.shells ?? []).filter(s => s.id !== shell.id), shell], watchdog: undefined },
      )
    : rows

/** Ends an open shell, wherever it is tracked; its row's shellsDoneAt is set once no shell there is open. */
export const endShell = (rows: AgentRow[], shellId: string, exit: ShellExit, t: number): AgentRow[] =>
  rows.map(r => {
    if (!r.shells?.some(s => s.id === shellId && s.exit === undefined)) return r
    const shells = r.shells.map(s => (s.id === shellId ? { ...s, endedAt: t, exit } : s))
    return { ...r, shells, ...(shells.some(s => s.exit === undefined) ? {} : { shellsDoneAt: t }) }
  })

/**
 * Keeps only `keep`'s shells. shellsDoneAt goes with the last finished one; once none is open (the last open one
 * dropped) and finished ones remain, an unset shellsDoneAt is their latest end. One already set is kept.
 */
const keepShells = (r: AgentRow, keep: (s: Shell) => boolean): AgentRow => {
  const shells = (r.shells ?? []).filter(keep)
  const finished = shells.filter(s => s.exit !== undefined)
  if (!finished.length) return { ...r, shells, shellsDoneAt: undefined }
  if (r.shellsDoneAt !== undefined || finished.length < shells.length) return { ...r, shells }
  return { ...r, shells, shellsDoneAt: Math.max(...finished.map(s => s.endedAt ?? 0)) }
}

/** Stops tracking a shell, wherever it is (TaskStop). */
export const dropShell = (rows: AgentRow[], shellId: string): AgentRow[] =>
  rows.map(r => (r.shells?.some(s => s.id === shellId) ? keepShells(r, s => s.id !== shellId) : r))

/** The agent picked up its finished shells: all of them, or with `mention` those whose id or output path it names. */
export const pickUpShells = (rows: AgentRow[], agentId: string, mention?: string): AgentRow[] =>
  rows.map(r =>
    r.id !== agentId
      ? r
      : keepShells(
          r,
          s =>
            s.exit === undefined ||
            (mention !== undefined && !mention.includes(s.id) && !(s.outputPath && mention.includes(s.outputPath))),
        ),
  )

/** Idle agents (never main) whose shells have all finished and gone unpicked for the grace, counted from the later of their end and the agent's last activity. */
export const graceDue = (rows: readonly AgentRow[], now: number, graceMs: number): AgentRow[] =>
  graceMs <= 0
    ? []
    : rows.filter(
        r =>
          r.id !== 'main' &&
          r.status === 'idle' &&
          r.shellsDoneAt !== undefined &&
          openShells(r).length === 0 &&
          (r.shells ?? []).some(s => s.exit !== undefined) &&
          now - Math.max(r.shellsDoneAt, r.lastActive) >= graceMs,
      )

/** How a shell is named to its agent and in the log: its description, else its command cut to 80 characters. */
export const shellName = (s: Shell): string => s.description || s.command.slice(0, 80)
const shellEnd = (s: Shell) =>
  `${shellEndWords(s.exit ?? 'unknown')} at ${new Date(s.endedAt ?? 0).toISOString().slice(11, 16)} UTC`
const outputOf = (s: Shell) => (s.outputPath ? `; output: ${s.outputPath}` : '')

/** Tells an agent which of its background commands finished without it picking them up. */
export const shellNudge = (shells: readonly Shell[]): string =>
  shells.length === 1 && shells[0]
    ? `[orchestrator mod] your background command "${shellName(shells[0])}" (id ${shells[0].id}) ${shellEnd(shells[0])} and you haven't picked it up${outputOf(shells[0])}`
    : [
        "[orchestrator mod] your background commands finished and you haven't picked them up:",
        ...shells.map(s => `- "${shellName(s)}" (id ${s.id}) ${shellEnd(s)}${outputOf(s)}`),
      ].join('\n')

/** Open shells running past the ceiling, not yet nudged, on live rows (main included). */
export const ceilingDue = (rows: readonly AgentRow[], now: number, ceilingMs: number): { row: AgentRow; shell: Shell }[] =>
  ceilingMs <= 0
    ? []
    : rows
        .filter(r => r.status === 'running' || r.status === 'idle' || r.status === 'handing-over')
        .flatMap(r =>
          openShells(r)
            .filter(s => !s.ceilingNudged && now - s.startedAt >= ceilingMs)
            .map(shell => ({ row: r, shell })),
        )

export const markCeiling = (rows: AgentRow[], shellId: string): AgentRow[] =>
  rows.map(r =>
    r.shells?.some(s => s.id === shellId)
      ? { ...r, shells: r.shells.map(s => (s.id === shellId ? { ...s, ceilingNudged: true as const } : s)) }
      : r,
  )

export const ceilingNudge = (shell: Shell, minutes: number): string =>
  `[orchestrator mod] your background command "${shellName(shell)}" (id ${shell.id}) is still running after ${minutes} min; check it (e.g. a suspended process) or stop it (TaskStop).${shell.outputPath ? ` Output: ${shell.outputPath}` : ''}`

/** Open tracked shells the engine's `background_tasks` list no longer names; nothing unless it is a list. */
export const goneShells = (rows: readonly AgentRow[], tasks: unknown): { agentId: string; shell: Shell }[] => {
  if (!Array.isArray(tasks)) return []
  const listed = new Set(
    tasks.map(t => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined)).filter(id => typeof id === 'string'),
  )
  return rows.flatMap(r => openShells(r).filter(s => !listed.has(s.id)).map(shell => ({ agentId: r.id, shell })))
}

export const watchdogNudge = (minutes: number): string =>
  `[orchestrator mod] you've been idle ${minutes} min with no running children or background commands; if you're waiting on something, check it; otherwise carry on or report.`
