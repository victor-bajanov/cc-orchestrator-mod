import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, DisplayStatus, LogEntry, MainPhase, ToolView, Transcript } from '../types'
import { toolDetail } from './detail'
import type { ToolDetail } from './detail'
import {
  HANDOVER_CLAUSE,
  contextOf,
  fmtTokens,
  handoverMessage,
  label,
  level,
  mainHandoverPrompt,
  newRow,
  notePathFor,
  orderRows,
  recordStep,
  replacementPrompt,
  resumePrompt,
  rosterMarkdown,
  timeline,
  wrapFill,
} from './core'
import {
  LIVE,
  ceilingOf,
  chartWidthPx,
  contextChart,
  cut,
  displayStatus,
  hhmm,
  logId,
  mainButtonShown,
  modelLabel,
  paneHeader,
  seriesColors,
  statusEmoji,
  statusStyle,
  textKey,
  transcriptItems,
  transcriptView,
} from './view'
import type { TranscriptLine } from './view'

type $ = EngineInterface

const PANE = 'orchestrator'
/** The tool-call detail dialog: a second pane, one at a time. */
const TOOL_PANE = 'orchestrator-tool'
const SYNC_MS = 30_000
const STALL_MS = 20 * 60_000

const agentsAtom = atom({ plugin: 'orchestrator', key: 'agents' } as const, [] as AgentRow[])
const logAtom = atom({ plugin: 'orchestrator', key: 'log' } as const, [] as LogEntry[])
const phaseAtom = atom({ plugin: 'orchestrator', key: 'mainPhase' } as const, 'idle' as MainPhase)
const runAtom = atom({ plugin: 'orchestrator', key: 'runId' } as const, '')
/** The activity line whose full-text card a click pinned open ('' for none). */
const pinnedAtom = atom({ plugin: 'orchestrator', key: 'pinnedLog' } as const, '')
/** The agent a click selected: its chart line is highlighted and its transcript shown beneath its row ('' for none). */
const selectedAtom = atom({ plugin: 'orchestrator', key: 'selectedAgent' } as const, '')
/** The tool call open in the detail dialog, read off the render by refreshTool. */
const toolViewAtom = atom({ plugin: 'orchestrator', key: 'toolView' } as const, null as ToolView | null)
/** Each agent's last transcript items, read off the render by refreshTranscript. */
const transcriptsAtom = atom({ plugin: 'orchestrator', key: 'transcripts' } as const, {} as Record<string, Transcript>)
/** Mirrors `mainHandoverQueued` for drawing: the buttons say a handover waits on this turn. */
const queuedAtom = atom({ plugin: 'orchestrator', key: 'mainQueued' } as const, false)

const patch = (rows: AgentRow[], id: string, change: Partial<AgentRow>) =>
  rows.map(r => (r.id === id ? { ...r, ...change } : r))

const cfg = {
  agentThreshold: 450_000,
  mainThreshold: 450_000,
  mainMode: 'ask',
  autoRespawn: true,
  injectClause: true,
  runRoot: '',
}

/** Running or idle: an agent loop that has not settled or started handing over. */
const isActive = (r: AgentRow) => r.status === 'running' || r.status === 'idle'

/** A subagent that can be handed over now. */
const canHandOver = (r: AgentRow) => r.id !== 'main' && isActive(r)

/** The selection, or '' when it names no row (so a stale one fades no line). */
export const liveSelection = (rows: readonly AgentRow[], selected: string) =>
  rows.some(r => r.id === selected) ? selected : ''
// The run folder outlives a /clear (the session id changes, the run does not).
let runDirCache = ''
let paneOffered = false
/** Main is mid-turn: from its `turn.start` (main's alone) to its `turn.complete`. */
let mainBusy = false
/** A main handover asked for mid-turn: it starts when that turn ends. */
let mainHandoverQueued = false
/** A main handover is being set up: a second press in the meantime does nothing. */
let mainHandoverStarting = false
/** Agents whose transcript read is in flight: one read per agent at a time. */
const peeking = new Set<string>()
/** Agents triggered while their read was in flight: each is read once more when it settles. */
const peekAgain = new Set<string>()
/** Tool calls (`agentId:toolUseId`) whose detail read is in flight, and those triggered meanwhile. */
const toolReading = new Set<string>()
const toolAgain = new Set<string>()
/**
 * When the mod saw each transcript entry, per agent: a call's `tool_use_id` or a text's
 * `textKey` → ms. Module-level, so lost on reload; an entry it never saw draws `--:--`.
 */
const stamps = new Map<string, Map<string, number>>()
/** The most stamps kept per agent; the oldest goes first. */
const STAMPS_MAX = 500
// The id the agent.spawn hook last saw started: a plugin's own spawn may resolve without it.
let lastSpawned: string | undefined


async function runDir($: $) {
  let id = await read($, runAtom)
  if (!id) {
    id = await $.session.id()
    await update($, runAtom, () => id)
  }
  const root = cfg.runRoot || `${await $.session.root()}/.orchestrator`
  runDirCache = `${root}/${id}`
  return runDirCache
}

/** Keeps the default run folder out of `git status` without touching the tracked .gitignore. */
async function excludeFromGit($: $) {
  if (cfg.runRoot) return
  const exclude = `${await $.session.root()}/.git/info/exclude`
  if (!(await $.fs.exists(exclude))) return
  const text = await $.fs.read(exclude)
  if (text.split('\n').some(line => line.trim() === '.orchestrator/')) return
  await $.fs.write(exclude, `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}.orchestrator/\n`)
}

/** After a /clear wiped the session's state, put it back from the run folder. */
async function restore($: $) {
  if (!runDirCache || (await read($, runAtom))) return
  const path = `${runDirCache}/state.json`
  if (!(await $.fs.exists(path))) return
  const saved = JSON.parse(await $.fs.read(path)) as { agents: AgentRow[]; mainPhase: MainPhase; runId: string }
  await update($, runAtom, () => saved.runId)
  await update($, agentsAtom, () => saved.agents)
  await update($, phaseAtom, () => saved.mainPhase)
}

async function log($: $, text: string, lvl: LogEntry['level'] = 'info') {
  const t = await $.clock.now()
  await update($, logAtom, l => [...l, { t, text, level: lvl }].slice(-200))
  if (lvl === 'warn') $.ui.toast(`orchestrator: ${text}`)
}

async function persist($: $) {
  const dir = await runDir($)
  const agents = await read($, agentsAtom)
  const mainPhase = await read($, phaseAtom)
  const runId = await read($, runAtom)
  await $.fs.write(`${dir}/state.json`, JSON.stringify({ runId, mainPhase, agents }))
  await $.fs.write(`${dir}/roster.md`, rosterMarkdown(agents))
  const subs = agents.filter(a => a.id !== 'main')
  const live = subs.filter(a => LIVE.includes(a.status))
  const main = agents.find(a => a.id === 'main')
  const top = live.reduce((m, a) => Math.max(m, a.tokens), 0)
  $.ui.status(
    [
      live.length ? `${live.length} agent${live.length === 1 ? '' : 's'}, max ${fmtTokens(top)}/${fmtTokens(cfg.agentThreshold)}` : '',
      main ? `main ${fmtTokens(main.tokens)}/${fmtTokens(cfg.mainThreshold)}` : '',
      mainPhase !== 'idle' && mainPhase !== 'cooldown' ? `handover: ${mainPhase}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined,
  )
}

// ---- pane presses ----------------------------------------------------

function togglePinned($: $, id: string) {
  return update($, pinnedAtom, p => (p === id ? '' : id))
}

async function toggleSelected($: $, id: string) {
  await update($, selectedAtom, s => (s === id ? '' : id))
  // Opening a transcript starts its read; the pane shows `loading…` until it settles.
  if ((await read($, selectedAtom)) === id) schedulePeek($, id)
}

/** How long a transcript read may take before the pane calls it not readable. */
export const PEEK_TIMEOUT_MS = 3_000
/** The most items a transcript keeps: the desktop's; the terminal shows fewer. */
const TRANSCRIPT_MAX = 12
/** The terminal's transcript items. */
const TRANSCRIPT_TERMINAL = 6
/** The longest text item stored: whole enough to expand, short enough to keep state small. */
const STEP_CHARS = 2000

/** Records when the mod saw an entry of an agent's transcript. Synchronous; never throws on good input. */
function stamp(agentId: string, key: string, t: number) {
  let m = stamps.get(agentId)
  if (!m) stamps.set(agentId, (m = new Map()))
  m.delete(key)
  m.set(key, t)
  if (m.size > STAMPS_MAX) m.delete(m.keys().next().value!)
}

/**
 * Reads an agent's transcript into `transcriptsAtom` as its last items, off the render (a drawing never
 * awaits it). The agent counts as in flight until the read itself settles, so a hung read never has
 * others piled behind it; a trigger meanwhile is remembered, and one reread follows once it settles.
 * A refusal, a failure or a read past PEEK_TIMEOUT_MS is stored as denied, unless items are already
 * cached: an agent that finished, or a slow read, keeps the last items shown.
 */
async function refreshTranscript($: $, id: string) {
  if (id === 'main') return
  if (peeking.has(id)) {
    peekAgain.add(id)
    return
  }
  peeking.add(id)
  const found = $.session
    .messages({ agentId: id })
    .then(f => ('deny' in f ? undefined : f))
    .catch(() => undefined)
    .finally(() => {
      peeking.delete(id)
      if (peekAgain.delete(id)) schedulePeek($, id)
    })
  let timer: { cancel: () => void } | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(PEEK_TIMEOUT_MS, () => resolve(undefined))
  })
  const messages = await Promise.race([found, late])
  timer?.cancel()
  const startedAt = (await read($, agentsAtom)).find(r => r.id === id)?.startedAt ?? 0
  const items = messages
    ? transcriptItems(messages, key => stamps.get(id)?.get(key), { n: TRANSCRIPT_MAX, chars: STEP_CHARS, startedAt })
    : undefined
  await update($, transcriptsAtom, p =>
    items ? { ...p, [id]: { items } } : p[id] && 'items' in p[id] ? p : { ...p, [id]: { denied: true as const } },
  )
}

/** Starts a transcript read outside the dispatch that asked for it, so no hook or press waits on it. */
function schedulePeek($: $, id: string) {
  if (id === 'main') return
  if (peeking.has(id)) {
    peekAgain.add(id)
    return
  }
  $.clock.after(0, () => void refreshTranscript($, id).catch(() => undefined))
}

/** Rereads the transcript of the agent an event came from, when it is the one open in the pane. Never throws. */
async function peekIfSelected($: $, id: string | undefined) {
  try {
    if (id && id === (await read($, selectedAtom))) schedulePeek($, id)
  } catch {
    // The transcript is a convenience: whatever fails here must not reach a handover or a step's record.
  }
}

/**
 * Opens a tool call's detail in the dialog pane, or closes it when that call is the one open.
 * Only state is awaited: the read is scheduled and the open is fire-and-forget, so a press never
 * waits on either. A session that places no dialog (an older desktop) gets the detail inline.
 */
async function openTool($: $, agentId: string, toolUseId: string) {
  const open = await read($, toolViewAtom)
  if (open?.agentId === agentId && open.toolUseId === toolUseId) return closeTool($)
  await update($, toolViewAtom, () => ({ agentId, toolUseId, inline: false }))
  scheduleTool($, agentId, toolUseId)
  const r = (await read($, agentsAtom)).find(a => a.id === agentId)
  const tr = (await read($, transcriptsAtom))[agentId]
  const item = tr && 'items' in tr ? tr.items.find(i => i.kind === 'tool' && i.toolUseId === toolUseId) : undefined
  const title = `${r ? label(r) : agentId} · ${item?.kind === 'tool' ? item.tool : 'tool call'}`
  void $.ui
    .open({ id: TOOL_PANE, title, focus: true, closeOnEscape: true, holdToasts: true, rows: 20 })
    .then(async res => {
      if (res.isPlaced) return
      await update($, toolViewAtom, v => (v && v.agentId === agentId && v.toolUseId === toolUseId ? { ...v, inline: true } : v))
    })
    .catch(() => undefined)
}

/** Closes the detail dialog and forgets the call it showed. */
async function closeTool($: $) {
  await update($, toolViewAtom, () => null)
  await $.ui.close({ id: TOOL_PANE })
}

/**
 * Reads one tool call's detail into `toolViewAtom`, off the render, as refreshTranscript reads a
 * transcript: one read per call in flight, one reread for triggers meanwhile, PEEK_TIMEOUT_MS at most.
 * It writes only while that call is still the one open. A call missing from the transcript, or a
 * read refused, failed or late, is stored as denied unless a detail is already shown.
 */
async function refreshTool($: $, agentId: string, toolUseId: string) {
  const key = `${agentId}:${toolUseId}`
  if (toolReading.has(key)) {
    toolAgain.add(key)
    return
  }
  toolReading.add(key)
  const found = $.session
    .messages({ agentId })
    .then(f => {
      if ('deny' in f) return undefined
      for (let i = f.length - 1; i >= 0; i--) {
        const use = f[i]!.toolUses.find(u => u.tool_use_id === toolUseId)
        if (use) return use
      }
      return undefined
    })
    .catch(() => undefined)
    .finally(() => {
      toolReading.delete(key)
      if (toolAgain.delete(key)) scheduleTool($, agentId, toolUseId)
    })
  let timer: { cancel: () => void } | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(PEEK_TIMEOUT_MS, () => resolve(undefined))
  })
  const use = await Promise.race([found, late])
  timer?.cancel()
  const detail = use ? toolDetail(use, stamps.get(agentId)?.get(toolUseId)) : undefined
  await update($, toolViewAtom, v => {
    if (!v || v.agentId !== agentId || v.toolUseId !== toolUseId) return v
    if (detail) return { agentId, toolUseId, inline: v.inline, detail }
    return v.detail ? v : { ...v, denied: true as const }
  })
}

/** Starts a tool detail read outside the dispatch that asked for it. */
function scheduleTool($: $, agentId: string, toolUseId: string) {
  const key = `${agentId}:${toolUseId}`
  if (toolReading.has(key)) {
    toolAgain.add(key)
    return
  }
  $.clock.after(0, () => void refreshTool($, agentId, toolUseId).catch(() => undefined))
}

/** Rereads the open tool call's detail when its own call settles. Never throws. */
async function toolIfOpen($: $, agentId: string | undefined, toolUseId: string | undefined) {
  try {
    const v = await read($, toolViewAtom)
    if (agentId && v && v.agentId === agentId && v.toolUseId === toolUseId) scheduleTool($, agentId, toolUseId)
  } catch {
    // The dialog is a convenience: whatever fails here must not reach a handover.
  }
}

type Ui = ReturnType<$['ui']['resolve']>

/** A tool call's detail as elements: header, then each section labelled (D11). No `$`: it only draws. */
function detailBody(ui: Ui, d: ToolDetail) {
  const { Box, Text, Code, Markdown } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {d.time} ⚙ {d.tool}
        {d.isError && <Text color="error"> failed</Text>}
        {d.isPending && <Text dimColor> running…</Text>}
      </Text>
      {d.sections.map((sec, i) => (
        <Box key={`s${i}`} flexDirection="column">
          <Text dimColor bold>
            {sec.label}
          </Text>
          {sec.kind === 'code' ? (
            <Code
              source={sec.source}
              language={sec.language}
              path={sec.path}
              startLine={sec.startLine}
              format={sec.diff ? 'diff' : 'source'}
            />
          ) : sec.kind === 'markdown' ? (
            <Markdown text={sec.text} />
          ) : (
            <Text wrap="wrap">{sec.text}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

/** What the dialog shows for the open call: its detail, or one dim line. */
function toolBody(ui: Ui, v: ToolView | null) {
  const { Text } = ui
  if (!v) return <Text dimColor>No tool call selected.</Text>
  if (v.detail) return detailBody(ui, v.detail)
  if (v.denied) return <Text dimColor>tool call not readable (teammate in another pane, or finished)</Text>
  return <Text dimColor>loading…</Text>
}

// ---- subagents -------------------------------------------------------

async function startHandover($: $, id: string, why: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r || !canHandOver(r)) return false
  const attempt = (r.handovers ?? 0) + 1
  const notePath = notePathFor(await runDir($), r, attempt)
  const now = await $.clock.now()
  await update($, agentsAtom, l =>
    patch(l, id, { status: 'handing-over', notePath, handoverAt: now, handovers: attempt, handoverVia: undefined }),
  )
  if (r.status === 'idle') return sendHandover($, id, why)
  // A message would wait in a busy teammate's inbox until its turn ends: it rides on the next tool result instead.
  await log($, `${label(r)} ${why}: HANDOVER goes with its next tool result`)
  await persist($)
  return true
}

/** Sends HANDOVER as a message, which wakes an idle teammate or resumes a finished subagent. */
async function sendHandover($: $, id: string, why: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r?.notePath) return false
  const sent = await $.session.send({ to: { agentId: id }, text: handoverMessage(r.notePath, cfg.autoRespawn) })
  if (sent.isDelivered) {
    const now = await $.clock.now()
    await update($, agentsAtom, l => patch(l, id, { handoverVia: 'message', handoverAt: now }))
    await log($, `${label(r)} ${why}: HANDOVER sent`)
  } else {
    await update($, agentsAtom, l => patch(l, id, { status: 'stalled' }))
    await log($, `${label(r)}: HANDOVER could not be delivered (${sent.reason})`, 'warn')
  }
  await persist($)
  return sent.isDelivered
}

async function tellParent($: $, parentId: string | undefined, text: string) {
  if (parentId === undefined || parentId === 'main') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    await $.session.send({ to: { agentId: parentId }, text })
  }
}

async function respawn($: $, old: AgentRow) {
  const brief = old.brief
  if (!brief || !old.notePath) {
    await log($, `${label(old)}: no brief recorded, cannot respawn`, 'warn')
    return
  }
  lastSpawned = undefined
  const res = await $.agent.spawn({
    prompt: replacementPrompt(brief, old.notePath),
    subagentType: brief.subagentType,
    description: brief.description,
    model: brief.model,
    name: brief.name,
  })
  const newId = res.agentId ?? lastSpawned
  if (res.deny !== undefined || !newId) {
    await log($, `${label(old)}: respawn refused (${res.deny ?? 'no agent id'})`, 'warn')
    return
  }
  // A teammate's name is suffixed when the original still holds it; the engine delivers its final reply itself.
  const info = (await $.agent.list()).find(a => a.id === newId)
  const name = info?.name ?? brief.name
  const isTeammate = info?.teammateId !== undefined
  const now = await $.clock.now()
  await update($, agentsAtom, l => {
    const known = l.some(a => a.id === newId) ? l : [...l, newRow(newId, now)]
    return known.map(a =>
      a.id === old.id
        ? { ...a, replacedBy: newId }
        : a.id === newId
          ? {
              ...a,
              name,
              description: brief.description,
              type: brief.subagentType,
              brief,
              replaces: old.id,
              parentId: old.parentId,
              isOurs: true,
              isTeammate,
            }
          : a,
    )
  })
  await log($, `${label(old)} replaced by ${newId}, resuming from ${old.notePath}`)
  await tellParent(
    $,
    old.parentId,
    `[orchestrator mod] Agent ${label(old)} (id ${old.id}) reached ${fmtTokens(old.tokens)} context and handed over; note at ${old.notePath}. ` +
      `Replacement id ${newId}${name ? ` (SendMessage name "${name}")` : ''} continues from the note. ` +
      `No action needed: do not spawn another.${!isTeammate && (old.parentId === 'main' || old.parentId === undefined) ? ' Its final report will be forwarded to you.' : ''} Update your roster.`,
  )
}

async function onAgentEnd($: $, id: string, answer: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r) return
  if (r.status === 'handing-over') {
    if (r.notePath && (await $.fs.exists(r.notePath))) {
      await update($, agentsAtom, l => patch(l, id, { status: 'replaced' }))
      await log($, `${label(r)} handed over (${r.notePath})`)
      if (cfg.autoRespawn) await respawn($, { ...r, status: 'replaced' })
    } else if (r.handoverVia !== 'message') {
      // It finished before a tool result could carry the HANDOVER: the message wakes it to write the note.
      await sendHandover($, id, 'ended before seeing it')
      return
    } else {
      await update($, agentsAtom, l => patch(l, id, { status: 'done' }))
      await log($, `${label(r)} ended without writing its handover note`, 'warn')
    }
  } else if (isActive(r)) {
    await update($, agentsAtom, l => patch(l, id, { status: 'idle' }))
    if (r.isOurs && !r.isTeammate && r.parentId !== undefined) {
      const text = `[orchestrator mod] ${label(r)} (id ${id}, replacement for ${r.replaces}) reports:\n\n${answer}`
      if (r.parentId === 'main') $.clock.after(0, () => void $.prompt.submit({ text }))
      else await $.session.send({ to: { agentId: r.parentId }, text })
    }
  }
  await persist($)
}

/** Marks agents the engine no longer lists as done, and handovers that hang as stalled. */
async function sync($: $) {
  const listed = new Set((await $.agent.list()).map(a => a.id))
  const now = await $.clock.now()
  const rows = await read($, agentsAtom)
  let changed = false
  for (const r of rows) {
    if (r.id === 'main') continue
    if (r.status === 'handing-over' && r.handoverAt && now - r.handoverAt > STALL_MS) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'stalled' }))
      await log($, `${label(r)} has not handed over after ${Math.round(STALL_MS / 60_000)} min`, 'warn')
      void $.ui.notify(`${label(r)} has not handed over`, { title: 'orchestrator' })
      changed = true
    } else if (isActive(r) && !listed.has(r.id)) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'done' }))
      changed = true
    }
  }
  if (changed) await persist($)
  // The open transcript is read again now and then, so one left loading (a reload, a lost read) settles.
  const selected = liveSelection(await read($, agentsAtom), await read($, selectedAtom))
  if (selected) schedulePeek($, selected)
}

// ---- main thread -----------------------------------------------------

function setPhase($: $, p: MainPhase) {
  return update($, phaseAtom, () => p)
}

async function startMainHandover($: $) {
  // Synchronous guards, before any await: a second press cannot start a second round.
  if (mainHandoverStarting) return
  if (mainBusy) {
    // A prompt submitted now would queue behind the running turn, whose end would then look for the note too early.
    if (mainHandoverQueued) return
    mainHandoverQueued = true
    await update($, queuedAtom, () => true)
    await log($, 'main thread hands over when this turn ends')
    return
  }
  mainHandoverStarting = true
  try {
    const phase = await read($, phaseAtom)
    if (phase === 'writing' || phase === 'clearing') return
    const main = (await read($, agentsAtom)).find(a => a.id === 'main') ?? newRow('main', await $.clock.now())
    const attempt = (main.handovers ?? 0) + 1
    const notePath = `${await runDir($)}/handover/main-${attempt}.md`
    await update($, agentsAtom, l =>
      (l.some(a => a.id === 'main') ? l : [main, ...l]).map(a =>
        a.id === 'main' ? { ...a, notePath, handovers: attempt } : a,
      ),
    )
    await setPhase($, 'writing')
    await log($, `main thread at ${fmtTokens(main.tokens)}: writing handover note`)
    await persist($)
    await $.prompt.submit({ text: mainHandoverPrompt(notePath) })
  } finally {
    mainHandoverStarting = false
  }
}

async function finishMainHandover($: $) {
  const main = (await read($, agentsAtom)).find(a => a.id === 'main')
  const notePath = main?.notePath
  if (!notePath || !(await $.fs.exists(notePath))) {
    await setPhase($, 'idle')
    await log($, 'main thread did not write its handover note; not clearing', 'warn')
    await persist($)
    return
  }
  const note = await $.fs.read(notePath)
  await setPhase($, 'clearing')
  await persist($)
  await $.command.run({ command: 'clear' })
  await restore($)
  const agents = await read($, agentsAtom)
  await setPhase($, 'cooldown')
  await log($, `main thread cleared; resuming from ${notePath}`)
  await persist($)
  await $.prompt.submit({
    text: resumePrompt({ note, notePath, rosterPath: `${await runDir($)}/roster.md`, agents }),
  })
}

async function checkMain($: $, tokens: number) {
  const phase = await read($, phaseAtom)
  // 'clearing' too: a restart cut short (Esc) never reaches cooldown, so the next main step settles it.
  if ((phase === 'cooldown' || phase === 'clearing') && tokens < cfg.mainThreshold) await setPhase($, 'idle')
  if (phase === 'idle' && cfg.mainMode !== 'off' && tokens >= cfg.mainThreshold) {
    await setPhase($, 'offered')
    if (cfg.mainMode === 'ask') {
      await log($, `main thread at ${fmtTokens(tokens)}: handover offered above the prompt`, 'warn')
    }
  }
}

export const register: Register = (on, options) => {
  cfg.agentThreshold = Number(options.agentThreshold ?? 450_000)
  cfg.mainThreshold = Number(options.mainThreshold ?? 450_000)
  cfg.mainMode = String(options.mainHandover ?? 'ask')
  cfg.autoRespawn = options.autoRespawn !== false
  cfg.injectClause = options.injectClause !== false
  cfg.runRoot = String(options.runRoot ?? '').replace(/\/+$/, '')
  paneOffered = false
  mainBusy = false
  mainHandoverQueued = false
  mainHandoverStarting = false
  peeking.clear()
  peekAgain.clear()
  stamps.clear()
  toolReading.clear()
  toolAgain.clear()

  // ---- events ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch',
      description: 'Orchestrator: open or close the agents pane, show the roster, or hand an agent (or main) over now',
      argumentHint: '[close | roster | handover [name|id]]',
    })
    await runDir($)
    await excludeFromGit($).catch(() => undefined)
    // A (re)load starts with no handover queued: the state must not say otherwise.
    await update($, queuedAtom, () => false)
    $.clock.every(SYNC_MS, () => void sync($))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(cfg.injectClause ? { ...e, prompt: e.prompt + HANDOVER_CLAUSE } : e)
    if (res.deny !== undefined || !res.agentId) return res
    const id = res.agentId
    lastSpawned = id
    const type = e.subagentType ?? (e as typeof e & { subagent_type?: string }).subagent_type ?? 'agent'
    const now = await $.clock.now()
    await update($, agentsAtom, l => [
      ...l.filter(a => a.id !== id),
      {
        ...newRow(id, now),
        name: e.name,
        description: e.description,
        type,
        parentId: e.parentAgentId ?? 'main',
        brief: {
          prompt: e.prompt,
          subagentType: type,
          description: e.description,
          model: e.model,
          name: e.name,
        },
      },
    ])
    await log($, `spawned ${e.name ?? e.description} (${id})`)
    await persist($)
    if (!paneOffered) {
      paneOffered = true
      void $.ui.open({ id: PANE, title: 'Orchestrator' })
    }
    return res
 }).catch(($, e, next) => next(e)) // tracking failed: the spawn goes ahead either way

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (!res.usage) return res
    try {
      await restore($)
      const id = e.agentId ?? 'main'
      const now = await $.clock.now()
      if (id !== 'main' && !(await read($, agentsAtom)).some(a => a.id === id)) {
        const info = (await $.agent.list()).find(a => a.id === id)
        if (!info) return res // an engine fork (compaction, memory): not an agent of the run
        await update($, agentsAtom, l => [
          ...l,
          { ...newRow(id, now), name: info.name, description: info.description, type: info.type, parentId: info.parentId ?? 'main' },
        ])
      }
      const tokens = contextOf(res.usage)
      // The answering model wins over the requested one; an engine without effort leaves it out.
      const ran = { model: res.usage?.model ?? e.model, effort: e.effort === undefined ? undefined : String(e.effort) }
      await update($, agentsAtom, l => patch(recordStep(l, { id, tokens, t: now, tools: res.toolUses.length }), id, ran))
      try {
        // When the step's visible text was seen, for the transcript; synchronous, and it can cost the step nothing.
        if (id !== 'main' && res.answer) stamp(id, textKey('assistant', res.answer), now)
      } catch {
        // A lost stamp only leaves the item's time `--:--`.
      }
      if (id === 'main') await checkMain($, tokens)
      else if (tokens >= cfg.agentThreshold) {
        const r = (await read($, agentsAtom)).find(a => a.id === id)
        const startedAt = r?.samples[0]?.tokens ?? 0
        if (r && r.replaces && startedAt >= cfg.agentThreshold * 0.5) {
          // Its brief and note alone fill half the window: another handover would only loop.
          if (!r.noHandover) {
            await update($, agentsAtom, l => patch(l, id, { noHandover: true }))
            await log(
              $,
              `${label(r)} starts at ${fmtTokens(startedAt)} (≥ half the ${fmtTokens(cfg.agentThreshold)} threshold): not handing it over again`,
              'warn',
            )
          }
        } else if (r && canHandOver(r)) {
          await startHandover($, id, `at ${fmtTokens(tokens)} ≥ ${fmtTokens(cfg.agentThreshold)}`)
        }
      }
      await persist($)
    } catch (err) {
      $.ui.log(`orchestrator: step not recorded: ${String(err)}`)
    }
    // Last, after the step is recorded and any handover started: the peek can cost them nothing.
    await peekIfSelected($, e.agentId)
    return res
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // Stamped as the call starts, when the mod saw it, for the transcript. The call never waits on the clock,
      // and a lost stamp only leaves the item's time `--:--`: the call and its HANDOVER go ahead.
      const agentId = e.agentId
      const id = e.tool_use_id
      try {
        void $.clock.now().then(
          t => {
            try {
              stamp(agentId, id, t)
            } catch {
              // see above
            }
          },
          () => undefined,
        )
      } catch {
        // see above
      }
    }
    const res = await next(e)
    if (e.agentId === undefined || res.deny !== undefined) return res
    let out = res
    try {
      const r = (await read($, agentsAtom)).find(a => a.id === e.agentId)
      if (r?.status === 'handing-over' && !r.handoverVia && r.notePath) {
        await update($, agentsAtom, l => patch(l, r.id, { handoverVia: 'tool' }))
        await log($, `${label(r)}: HANDOVER delivered with a tool result`)
        await persist($)
        out = { ...res, context: [...(res.context ?? []), handoverMessage(r.notePath, cfg.autoRespawn)] }
      }
    } catch (err) {
      $.ui.log(`orchestrator: HANDOVER not attached: ${String(err)}`)
    }
    // Last, after the HANDOVER is attached: the peek and the open detail's reread can cost it nothing.
    await peekIfSelected($, e.agentId)
    await toolIfOpen($, e.agentId, e.tool_use_id)
    return out
  })

  // Raised for main's turns alone: a subagent's run raises no turn.start.
  on('turn.start', ($, e, next) => {
    mainBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main's turn is over whatever happens beneath: a failing `next` must not leave it marked busy.
    // A handover queued mid-turn starts even then, so it is taken off the queue before `next` too.
    const queued = e.agentId === undefined && mainHandoverQueued
    if (e.agentId === undefined) {
      mainBusy = false
      mainHandoverQueued = false
    }
    let res: Awaited<ReturnType<typeof next>>
    try {
      res = await next(e)
    } catch (err) {
      if (queued) {
        await update($, queuedAtom, () => false)
        $.clock.after(0, () => void startMainHandover($))
      }
      throw err
    }
    try {
      if (e.agentId !== undefined) await onAgentEnd($, e.agentId, e.answer)
      else {
        if (queued) await update($, queuedAtom, () => false)
        const phase = await read($, phaseAtom)
        if (queued && phase !== 'writing' && phase !== 'clearing') {
          // Asked for mid-turn: started now, before the `writing` check, so this turn's end never looks for a note.
          $.clock.after(0, () => void startMainHandover($))
        } else if (phase === 'offered' && cfg.mainMode === 'auto' && !e.isAborted) {
          $.clock.after(0, () => void startMainHandover($))
        } else if (phase === 'writing') {
          $.clock.after(0, () => void finishMainHandover($))
        }
      }
    } catch (err) {
      $.ui.log(`orchestrator: turn end not handled: ${String(err)}`)
    }
    return res
  })

  on('command.run', { command: 'orch' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    const target = rest.join(' ')
    if (!verb) {
      await $.ui.open({ id: PANE, title: 'Orchestrator' })
      return { text: 'Orchestrator pane opened.' }
    }
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Orchestrator pane closed; /orch opens it again.' }
    }
    if (verb === 'roster') return { text: rosterMarkdown(await read($, agentsAtom)) }
    if (verb === 'handover' && (!target || target === 'main')) {
      $.clock.after(0, () => void startMainHandover($))
      return { text: 'Main thread handover started: it writes a note, then is cleared and resumed.' }
    }
    if (verb === 'handover') {
      const rows = await read($, agentsAtom)
      const live = rows.filter(canHandOver)
      const r = live.find(a => a.id === target) ?? live.filter(a => a.name === target).at(-1)
      if (!r) return { text: `No live agent named or with id "${target}".` }
      const ok = await startHandover($, r.id, 'by /orch')
      return { text: ok ? `HANDOVER sent to ${label(r)} (${r.id}).` : `Could not hand ${label(r)} over.` }
    }
    return { text: 'Usage: /orch [close | roster | handover [name|id|main]]' }
  })

  // ---- drawing ---------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const phase = await read($, phaseAtom)
    if (phase !== 'offered' || cfg.mainMode !== 'ask') return next(e)
    const main = (await read($, agentsAtom)).find(a => a.id === 'main')
    const queued = await read($, queuedAtom)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="warning">
          Main context {fmtTokens(main?.tokens ?? 0)} ≥ {fmtTokens(cfg.mainThreshold)}.{' '}
        </Text>
        <Button
          key="handover"
          variant="primary"
          label={queued ? 'Handover queued' : 'Hand over & restart'}
          onPress={() => startMainHandover($)}
        />
        <Text> </Text>
        <Button key="dismiss" label="Not now" onPress={() => setPhase($, 'cooldown')} />
      </Box>
    )
  })

  // The dialog closed by anyone (Close, Escape, the host): forget its call. The close always goes on.
  on('ui.close', async ($, e, next) => {
    try {
      if (e.id === TOOL_PANE) await update($, toolViewAtom, () => null)
    } catch {
      // A stale view only shows until the next open.
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: TOOL_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button } = ui
    const v = await read($, toolViewAtom)
    return (
      <Box flexDirection="column" gap={1}>
        {toolBody(ui, v)}
        <Button key="close" role="dismiss" label="Close" onPress={() => closeTool($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const rows = await read($, agentsAtom)
    const pinned = await read($, pinnedAtom)
    const entries = await read($, logAtom)
    const phase = await read($, phaseAtom)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const now = await $.clock.now()
    const header = paneHeader(rows, {
      agentThreshold: cfg.agentThreshold,
      mainThreshold: cfg.mainThreshold,
      mainMode: cfg.mainMode,
      phase,
    })
    const tone = { ok: 'success', warn: 'warning', hot: 'error' } as const
    const shown = mainButtonShown(cfg.mainMode, phase)
    // A press while queued does nothing: startMainHandover returns on the queued flag.
    const queued = await read($, queuedAtom)
    // The transcript the host has open beside the pane (read-only; absent on older hosts and kit mounts). Main is never marked.
    const viewed = liveSelection(rows, e.props.view?.agentId ?? '')

    if (e.surface !== 'terminal') {
      // Desktop, VS Code, mobile: a vector chart, native buttons, activity that expands in flow.
      const { Box, Button, Text, Svg } = $.ui.resolve(e)
      const selected = liveSelection(rows, await read($, selectedAtom))
      const colors = seriesColors(rows)
      // A click selection wins; with none, the agent in view stands out.
      const hl = selected || viewed
      const chart = contextChart({
        rows,
        now,
        width: chartWidthPx(cols),
        height: 180,
        agentThreshold: cfg.agentThreshold,
        mainThreshold: cfg.mainThreshold,
        colors,
        selected: hl,
      })
      const fits = cols - 6
      // Main is the main view already: only a subagent's transcript is shown.
      // Drawn from the cache alone: the read is refreshPeek's, never the render's.
      const peek =
        selected && selected !== 'main' ? transcriptView((await read($, transcriptsAtom))[selected], fits, TRANSCRIPT_MAX) : undefined
      // A session that places no dialog shows the open call's detail in flow beneath it.
      const tv = await read($, toolViewAtom)
      const ui = $.ui.resolve(e)
      /** One transcript item: a tool call opens its detail; a cut text expands in flow beneath itself. */
      const item = (agentId: string, it: TranscriptLine) => {
        const time = <Text dimColor>{it.time} </Text>
        if (it.kind === 'tool') {
          const button = (
            <Button key={`tool:${agentId}:${it.toolUseId}`} plain onPress={() => openTool($, agentId, it.toolUseId!)}>
              {time}
              {it.isError && <Text color="error">✗ </Text>}
              <Text>{it.short}</Text>
              {it.isPending && <Text dimColor> (running)</Text>}
            </Button>
          )
          if (!tv?.inline || tv.agentId !== agentId || tv.toolUseId !== it.toolUseId) return button
          return (
            <Box key={`toolrow:${it.toolUseId}`} flexDirection="column">
              {button}
              <Box key={`tooldetail:${it.toolUseId}`} borderStyle="round" flexDirection="column">
                {toolBody(ui, tv)}
              </Box>
            </Box>
          )
        }
        const who = it.role === 'user' && <Text dimColor>» </Text>
        if (it.full === undefined) {
          return (
            <Text key={it.id} wrap="truncate">
              {time}
              {who}
              {it.short}
            </Text>
          )
        }
        const pin = it.id.replace(/^step-/, `step-${agentId}-`)
        return (
          <Box key={it.id} flexDirection="column">
            <Button key={pin} plain onPress={() => togglePinned($, pin)}>
              {time}
              {who}
              <Text>{it.short}</Text>
            </Button>
            {pinned === pin && (
              <Box key={`full:${pin}`} borderStyle="round" flexDirection="column">
                <Text wrap="wrap">{it.full}</Text>
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text bold>{header}</Text>
            {shown && (
              <Button
                key="handover:main"
                variant="secondary"
                label={queued ? 'Handover queued' : 'Hand over main'}
                onPress={() => startMainHandover($)}
              />
            )}
          </Box>
          {rows.length === 0 ? (
            <Text dimColor>No model requests yet.</Text>
          ) : (
            <Svg key="chart" isInteractive source={chart.source} alt={chart.alt} width={chart.width} height={chart.height} />
          )}
          <Box flexDirection="column">
            {orderRows(rows).flatMap(({ row, depth }) => {
              const ceiling = ceilingOf(row, cfg)
              const pct = Math.round((row.tokens / ceiling) * 100)
              const shows = displayStatus(row, rows)
              const model = modelLabel(row.model ?? row.brief?.model, row.effort)
              return [
                <Box key={`row:${row.id}`} flexDirection="row" paddingLeft={depth * 2} gap={1}>
                  <Button key={`agent:${row.id}`} plain onPress={() => toggleSelected($, row.id)}>
                    <Text color={colors.get(row.id)}>● </Text>
                    <Text bold={hl === row.id}>{label(row)} </Text>
                    {model !== '' && <Text dimColor>{model} </Text>}
                    <Text color={tone[level(row.tokens, ceiling)]}>
                      {fmtTokens(row.tokens)}/{fmtTokens(ceiling)} {pct}%{' '}
                    </Text>
                    <Text>{statusEmoji(shows, row.id)} </Text>
                    <Text dimColor>{shows}</Text>
                    {viewed === row.id && <Text dimColor> · in view</Text>}
                  </Button>
                  {canHandOver(row) && (
                    <Button
                      key={`handover:${row.id}`}
                      variant="secondary"
                      label="Hand over"
                      onPress={() => startHandover($, row.id, 'from the pane')}
                    />
                  )}
                </Box>,
                peek && selected === row.id && (
                  <Box key={`transcript:${row.id}`} borderStyle="round" flexDirection="column" marginLeft={depth * 2}>
                    {'dim' in peek ? <Text dimColor>{peek.dim}</Text> : peek.items.map(it => item(row.id, it))}
                  </Box>
                ),
              ]
            })}
          </Box>
          <Box flexDirection="column">
            <Text bold>Activity</Text>
            {entries.length === 0 && <Text dimColor>Nothing yet.</Text>}
            {entries.slice(-50).map((l, i) => {
              const color = l.level === 'warn' ? 'warning' : undefined
              if (l.text.length <= fits) {
                return (
                  <Text key={`l${i}`} color={color} wrap="wrap">
                    <Text dimColor>{hhmm(l.t)} </Text>
                    {l.text}
                  </Text>
                )
              }
              const id = logId(l)
              return (
                <Box key={`l${i}`} flexDirection="column">
                  <Button key={id} plain onPress={() => togglePinned($, id)}>
                    <Text dimColor>{hhmm(l.t)} </Text>
                    <Text color={color}>{cut(l.text, fits)}</Text>
                  </Button>
                  {pinned === id && (
                    <Box key={`full:${id}`} borderStyle="round" flexDirection="column">
                      <Text color={color} wrap="wrap">
                        {l.text}
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const NAME = Math.min(24, Math.max(12, Math.floor(cols * 0.25)))
    // The model cell: 16 columns padded, plus a space.
    const MODEL = 17
    const width = Math.max(8, cols - NAME - 7 - 14 - MODEL)
    const t0 = rows.reduce((m, r) => Math.min(m, r.startedAt), now)
    const ordered = orderRows(rows)
    const glyph: Record<DisplayStatus, string> = {
      running: '●',
      waiting: '◐',
      idle: '○',
      'handing-over': '↻',
      replaced: '⤳',
      done: '✓',
      stalled: '!',
    }
    const selected = liveSelection(rows, await read($, selectedAtom))
    // Main is the main view already: only a subagent's transcript is shown, in a bordered box beneath its row.
    const peek =
      selected && selected !== 'main'
        ? transcriptView((await read($, transcriptsAtom))[selected], Math.max(10, cols - 4), TRANSCRIPT_TERMINAL)
        : undefined
    const peekRows = peek ? ('items' in peek ? peek.items.length : 1) + 2 : 0
    /** One transcript row: a tool call opens its detail; a cut text shows whole in a card on hover, pinned by a press. */
    const item = (agentId: string, it: TranscriptLine) => {
      const time = <Text dimColor>{it.time} </Text>
      if (it.kind === 'tool') {
        return (
          <Button key={`tool:${agentId}:${it.toolUseId}`} plain onPress={() => openTool($, agentId, it.toolUseId!)}>
            {time}
            {it.isError && <Text color="error">✗ </Text>}
            <Text>{it.short}</Text>
            {it.isPending && <Text dimColor> (running)</Text>}
          </Button>
        )
      }
      const who = it.role === 'user' && <Text dimColor>» </Text>
      if (it.full === undefined) {
        return (
          <Text key={it.id} wrap="truncate">
            {time}
            {who}
            {it.short}
          </Text>
        )
      }
      const pin = it.id.replace(/^step-/, `step-${agentId}-`)
      // It overlays other lines and paints only the cells it writes: each line is padded to the full width.
      // It opens downward, over the activity (the top of the pane would clip it), with as many lines as fit there.
      const all = wrapFill(it.full, Math.max(10, cols - 4))
      const fit = Math.max(1, room)
      const wrapped = all.length > fit ? [...all.slice(0, fit - 1), '…'] : all
      return (
        <Box key={it.id}>
          <Button key={pin} plain onPress={() => togglePinned($, pin)}>
            {time}
            {who}
            <Text>{it.short}</Text>
          </Button>
          <Box
            position="absolute"
            top={1}
            left={-1}
            width={cols}
            borderStyle="round"
            flexDirection="column"
            display={pinned === pin ? 'flex' : 'none'}
            hover={pinned === pin ? undefined : { display: 'flex' }}
          >
            {wrapped.map((w, j) => (
              <Text key={`w${j}`} wrap="truncate">{` ${w} `}</Text>
            ))}
          </Box>
        </Box>
      )
    }
    // The header's button can wrap onto a row of its own.
    const room = Math.max(3, (e.viewport?.rows ?? 30) - ordered.length - 8 - (shown ? 1 : 0) - peekRows)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text bold>{header}</Text>
          {shown && (
            <Button
              key="handover:main"
              label={queued ? 'Handover queued' : 'Hand over main'}
              onPress={() => startMainHandover($)}
            />
          )}
        </Box>
        {ordered.length === 0 && <Text dimColor>No model requests yet.</Text>}
        {ordered.flatMap(({ row, depth }) => {
          const ceiling = ceilingOf(row, cfg)
          const live = LIVE.includes(row.status)
          const shows = displayStatus(row, rows)
          const style = statusStyle(shows)
          // The glyph takes the status colour; the name keeps its own marks. Together they fill NAME columns.
          const lead = `${'  '.repeat(depth)}${glyph[shows]} `.slice(0, NAME)
          const glyphCell = (
            <Text color={style.color} dimColor={style.dimColor} bold={style.bold} wrap="truncate">
              {lead}
            </Text>
          )
          const nameCell = (
            <Text dimColor={!live} inverse={viewed === row.id} bold={selected === row.id} wrap="truncate">
              {label(row).slice(0, NAME - lead.length).padEnd(NAME - lead.length)}
            </Text>
          )
          const model = modelLabel(row.model ?? row.brief?.model, row.effort)
          return [
            <Box key={row.id}>
              {row.id === 'main' ? (
                glyphCell
              ) : (
                <Button key={`agent:${row.id}`} plain onPress={() => toggleSelected($, row.id)}>
                  {glyphCell}
                  {nameCell}
                </Button>
              )}
              {row.id === 'main' && nameCell}
              <Text dimColor={!live}>{fmtTokens(row.tokens).padStart(6)} </Text>
              <Text dimColor>{model.slice(0, MODEL - 1).padEnd(MODEL - 1)} </Text>
              <Text color={live ? tone[level(row.tokens, ceiling)] : 'subtle'}>
                {timeline(row.samples, width, t0, now, ceiling, live)}
              </Text>
              <Text color={style.color} dimColor={style.dimColor} bold={style.bold}>
                {` ${shows.padEnd(12)}`}
              </Text>
            </Box>,
            peek && selected === row.id && (
              <Box key={`transcript:${row.id}`} borderStyle="round" flexDirection="column" width={cols}>
                {'dim' in peek ? (
                  <Text dimColor wrap="truncate">
                    {peek.dim}
                  </Text>
                ) : (
                  peek.items.map(it => item(row.id, it))
                )}
              </Box>
            ),
          ]
        })}
        <Text dimColor>
          {' '.repeat(NAME + 7 + MODEL)}
          {hhmm(t0).padEnd(Math.max(0, width - 5))}
          {hhmm(now)}
        </Text>
        <Text bold>Activity</Text>
        {entries.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {entries.slice(-room).map((l, i) => {
          const color = l.level === 'warn' ? 'warning' : undefined
          const fits = cols - 6
          if (l.text.length <= fits) {
            return (
              <Text key={`l${i}`} color={color} wrap="truncate">
                <Text dimColor>{hhmm(l.t)} </Text>
                {l.text}
              </Text>
            )
          }
          // Too long: cut with an ellipsis; the full text shows in a card above while hovered, or pinned by a click.
          const id = logId(l)
          // It overlays other lines and paints only the cells it writes: each line is padded to the full width.
          const inner = Math.max(10, cols - 4)
          const wrapped = wrapFill(l.text, inner)
          return (
            <Box key={`l${i}`}>
              <Button key={id} plain onPress={() => togglePinned($, id)}>
                <Text dimColor>{hhmm(l.t)} </Text>
                <Text color={color}>{cut(l.text, fits)}</Text>
              </Button>
              <Box
                position="absolute"
                top={-(wrapped.length + 2)}
                left={0}
                width={cols}
                borderStyle="round"
                flexDirection="column"
                display={pinned === id ? 'flex' : 'none'}
                hover={pinned === id ? undefined : { display: 'flex' }}
              >
                {wrapped.map((w, j) => (
                  <Text key={`w${j}`} color={color} wrap="truncate">{` ${w} `}</Text>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
