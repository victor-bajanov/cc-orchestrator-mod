import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { AgentRow, Delivery, DisplayStatus, LogEntry, MainPhase, ShellExit, ToolView, Transcript } from '../types'
import { bodyOf, toolDetail } from './detail'
import type { ToolDetail } from './detail'
import {
  ACTIVITY_MAX,
  HANDOVER_CLAUSE,
  activityLine,
  addShell,
  adoptChildren,
  backgroundedShell,
  briefPathFor,
  ceilingDue,
  ceilingNudge,
  contextOf,
  dropShell,
  endShell,
  fmtTokens,
  goneShells,
  graceDue,
  handoverMessage,
  label,
  level,
  mainHandoverPrompt,
  markCeiling,
  nameNotice,
  newRow,
  notePathFor,
  numberSetting,
  openShells,
  orderRows,
  pickUpShells,
  recordStep,
  replacementPrompt,
  respawnFailedNotice,
  resumePrompt,
  rosterMarkdown,
  shellEndWords,
  shellExit,
  shellName,
  shellNudge,
  timeline,
  watchdogNudge,
  wrapFill,
} from './core'
import {
  LIVE,
  addressFor,
  capLines,
  ceilingOf,
  chartWidthPx,
  contextChart,
  cut,
  displayStatus,
  expandCap,
  hhmm,
  logId,
  mainButtonShown,
  modelLabel,
  paneHeader,
  checkinDue,
  collapseHidden,
  forwardTarget,
  hiddenCount,
  canFold,
  foldGlyph,
  latest,
  namesAgent,
  redirectTarget,
  resolveAgent,
  seriesColors,
  statusEmoji,
  statusStyle,
  terminalBase,
  textKey,
  transcriptItems,
  transcriptView,
  watchdogDue,
  watchdogTurnEnded,
} from './view'
import type { TranscriptLine } from './view'

type $ = EngineInterface

const PANE = 'orchestrator'
/** The tool-call detail dialog: a second pane, one at a time. */
const TOOL_PANE = 'orchestrator-tool'
const SYNC_MS = 30_000
/** The check-in tool as the model calls it. */
const CHECKIN_TOOL = 'mcp__orchestrator__checkin'
/** A check-in cleared: no deadline, no length, no one who armed it. */
const DISARMED = { checkinAt: undefined, checkinMins: undefined, checkinBy: undefined } as const
const STALL_MS = 20 * 60_000

const agentsAtom = atom({ plugin: 'orchestrator', key: 'agents' } as const, [] as AgentRow[])
const logAtom = atom({ plugin: 'orchestrator', key: 'log' } as const, [] as LogEntry[])
const phaseAtom = atom({ plugin: 'orchestrator', key: 'mainPhase' } as const, 'idle' as MainPhase)
const runAtom = atom({ plugin: 'orchestrator', key: 'runId' } as const, '')
/** The line (activity or transcript text) whose full text a press shows beneath it, in flow ('' for none). */
const pinnedAtom = atom({ plugin: 'orchestrator', key: 'pinnedLog' } as const, '')
/** The agent a click selected: its chart line is highlighted and its transcript shown beneath its row ('' for none). */
const selectedAtom = atom({ plugin: 'orchestrator', key: 'selectedAgent' } as const, '')
/** Messages timers queued for the next hook to deliver (a send from a timer wakes a run without hooks). */
const outboxAtom = atom({ plugin: 'orchestrator', key: 'outbox' } as const, [] as Delivery[])
/** Rows the person collapsed with a row's fold glyph or the `c` hotkey, their finished descendants hidden; display only. */
const collapsedAtom = atom({ plugin: 'orchestrator', key: 'collapsed' } as const, [] as string[])
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
  /** How often open shells' output files are checked; 0: never. */
  shellPollSeconds: 15,
  /** How long an idle agent's finished shells may go unpicked before a nudge; 0: never. */
  shellGraceSeconds: 60,
  /** How long an idle agent with nothing running waits before one nudge; 0: never. */
  idleWatchdogMinutes: 5,
  /** How long a shell may run before one nudge; 0: never. */
  shellCeilingMinutes: 60,
}

/** Running or idle: an agent loop that has not settled or started handing over. */
const isActive = (r: AgentRow) => r.status === 'running' || r.status === 'idle'

/** A subagent that can be handed over now. */
const canHandOver = (r: AgentRow) => r.id !== 'main' && isActive(r)

/** The selection, or '' when it names no row (so a stale one fades no line). */
export const liveSelection = (rows: readonly AgentRow[], selected: string) =>
  rows.some(r => r.id === selected) ? selected : ''

/** A dispatch this plugin raised (`next.origin`, as plugin.json names it); anything malformed is not. */
export const isOwnOrigin = (origin: unknown): boolean =>
  typeof origin === 'object' && origin !== null && (origin as { plugin?: unknown }).plugin === 'orchestrator'

/** One of the mod's sends in flight. */
export type OwnSend = { agentId: string; text: string }

/**
 * Whether a SendMessage check is one of the mod's own sends: the exact text to a recipient one is in flight
 * to; or, this plugin's origin and a send in flight to that recipient. The origin is never enough alone: it
 * also covers the model inside an agent the mod spawned, so it counts only for a check from no loop (no `agentId`):
 * the mod's own send runs in none. `to` names a recipient as `namesAgent` does.
 */
export const isOwnSend = (o: {
  origin: unknown
  /** The loop the check is decided in (`tool.check`'s `agentId`); absent for the main loop or none. */
  agentId?: string
  to: unknown
  message: unknown
  inFlight: readonly OwnSend[]
  rows: readonly AgentRow[]
}): boolean => {
  const own = o.agentId === undefined && isOwnOrigin(o.origin)
  const toward = (s: OwnSend) => {
    if (typeof o.to === 'object' && o.to !== null) return (o.to as { agentId?: unknown }).agentId === s.agentId
    return namesAgent(o.to, o.rows.find(a => a.id === s.agentId) ?? { id: s.agentId })
  }
  return o.inFlight.some(s => toward(s) && (own || (typeof o.message === 'string' && s.text === o.message)))
}

/** One of the mod's own tool calls in flight, other than a send: a respawn's Agent call, or a TaskStop of a replaced agent. */
export type OwnCall = { tool: 'Agent'; prompt: string } | { tool: 'TaskStop'; taskId: string }

/**
 * Whether a tool.check input is one of the mod's own calls in flight: an Agent call with the exact prompt the mod
 * spawned with, or that prompt with the HANDOVER clause the mod's own agent.spawn hook appends; a TaskStop of
 * exactly the agent it is stopping. Anything malformed is not.
 */
export const isOwnCall = (input: unknown, inFlight: readonly OwnCall[]): boolean => {
  if (typeof input !== 'object' || input === null) return false
  const i = input as { prompt?: unknown; task_id?: unknown; shell_id?: unknown }
  return inFlight.some(c =>
    c.tool === 'Agent'
      ? typeof i.prompt === 'string' && (i.prompt === c.prompt || i.prompt === c.prompt + HANDOVER_CLAUSE)
      : i.task_id === c.taskId || i.shell_id === c.taskId,
  )
}

// The run folder outlives a /clear (the session id changes, the run does not).
let runDirCache = ''
let paneOffered = false
/** Teammates already warned that their children's handbacks cannot reach them. */
const teammatesWarned = new Set<string>()
/** Main is mid-turn: from its `turn.start` (main's alone) to its `turn.complete`. */
let mainBusy = false
/** A main handover asked for mid-turn: it starts when that turn ends. */
let mainHandoverQueued = false
/** A main handover is being set up: a second press in the meantime does nothing. */
let mainHandoverStarting = false
/**
 * One kind of read done off the render: the keys whose read is in flight (one per key at a time), and
 * the keys triggered meanwhile (each read once more when its read settles).
 */
type ReadSlot = { busy: Set<string>; again: Set<string> }
/** Transcript reads, keyed by agent id. */
const transcriptReads: ReadSlot = { busy: new Set(), again: new Set() }
/** Tool detail reads, keyed by `agentId:toolUseId`. */
const toolReads: ReadSlot = { busy: new Set(), again: new Set() }
/** What guardedRead gives when the key's read was already in flight (the trigger is remembered instead). */
const IN_FLIGHT = Symbol('in flight')
/**
 * Ids of queued messages already delivered, newest last: a restore skips them, even from a state.json
 * written by a persist that read the queue before the drain. Kept in memory (a /clear does not reset
 * it) and in state.json (for a reload).
 */
const delivered: string[] = []
/** How many delivered ids are kept. */
const DELIVERED_MAX = 200
/** Numbers queued messages within this module's life. */
let deliverySeq = 0
/** How long a drain waits for its respawns and HANDOVERs before letting the turn end go on. */
const DRAIN_TIMEOUT_MS = 10_000
/** A drain is under way: another hook does not start a second. */
let draining = false
/** Main was prompted to run a hooked turn for the outbox, and nothing has drained since: no second prompt. */
let nudgedSinceDrain = false
/**
 * The mod's sends in flight. Under auto mode the engine judges a plugin's `$.session.send` as a
 * SendMessage call, and the classifier refuses it because no user request asked for it. tool.check
 * allows exactly these sends, and only while they are in flight.
 */
const ownSends: OwnSend[] = []
/** A SendMessage check went unmatched while the mod had a send in flight, and was logged: once per load. */
let checkMissLogged = false
/**
 * The mod's own tool calls in flight other than sends (a respawn's Agent call, a TaskStop): under auto mode the
 * classifier refuses them, as it does the mod's sends. tool.check allows exactly these, and only while in flight.
 */
const ownCalls: OwnCall[] = []
/** An Agent or TaskStop check went unmatched while the mod had a call in flight, and was logged: once per load. */
let callMissLogged = false
/**
 * When the mod saw each transcript entry, per agent: a call's `tool_use_id` → ms, or a text's
 * `textKey` → each time it was seen, oldest first (a repeated text takes its own). Module-level,
 * so lost on reload; an entry it never saw draws `--:--`.
 */
const stamps = new Map<string, Map<string, number | number[]>>()
/** The most times kept for one repeated text. */
const TEXT_STAMPS_MAX = 50
/** The most stamps kept per agent; the oldest goes first. */
const STAMPS_MAX = 500
// The id the agent.spawn hook last saw started: a plugin's own spawn may resolve without it.
let lastSpawned: string | undefined
/** Agents already told their registered name: one notice each, however many paths learn the rename. */
const noticed = new Set<string>()
/** activity.log's lines, read back once per load (undefined: not read yet). */
let activity: string[] | undefined
/** The path `activity` was read from: another path is read afresh. */
let activityPath = ''
/** Lines logged before the run folder was known; they go in with the next line written. */
const activityPending: string[] = []
/** activity.log writes, one after another. */
let activityChain: Promise<void> = Promise.resolve()
/** Agents whose Hand over is being set up: a second start in the meantime is refused. */
const handoverStarting = new Set<string>()

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
  const saved = JSON.parse(await $.fs.read(path)) as {
    agents: AgentRow[]
    mainPhase: MainPhase
    runId: string
    outbox?: Delivery[]
    delivered?: string[]
  }
  await update($, runAtom, () => saved.runId)
  await update($, agentsAtom, () => saved.agents)
  await update($, phaseAtom, () => saved.mainPhase)
  // Undelivered messages outlive a /clear too; anything queued since is kept after them.
  const done = new Set([...delivered, ...(saved.delivered ?? [])])
  await update($, outboxAtom, q => [...(saved.outbox ?? []).filter(d => !done.has(d.id)), ...q])
}

/**
 * Appends a line to <run>/activity.log, keeping the last ACTIVITY_MAX (earlier lines read back once per load and
 * per path). Never throws. Uses the run folder already known, never runDir: that writes the run id when it is
 * empty, and after a /clear that would fork the run before restore. A line before the folder is known waits.
 */
async function writeActivity($: $, line: string) {
  const run = activityChain.then(async () => {
    try {
      if (!runDirCache) {
        activityPending.push(line)
        activityPending.splice(0, Math.max(0, activityPending.length - ACTIVITY_MAX))
        return
      }
      const path = `${runDirCache}/activity.log`
      if (path !== activityPath) {
        activity = undefined
        activityPath = path
      }
      if (activity === undefined) {
        activity = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
      }
      activity.push(...activityPending.splice(0), line)
      activity.splice(0, Math.max(0, activity.length - ACTIVITY_MAX))
      await $.fs.write(path, `${activity.join('\n')}\n`)
    } catch (err) {
      try {
        $.ui.log(`orchestrator: activity.log not written: ${String(err)}`, { to: 'debug' })
      } catch {
        // Nothing more to do.
      }
    }
  })
  activityChain = run
  return run
}

/** Writes a line to activity.log only, not to the pane. Never throws, and never waits on the file. */
async function trace($: $, text: string) {
  try {
    void writeActivity($, activityLine(await $.clock.now(), 'info', text))
  } catch {
    // The file is a record; a lost line breaks nothing.
  }
}

async function log($: $, text: string, lvl: LogEntry['level'] = 'info') {
  const t = await $.clock.now()
  await update($, logAtom, l => [...l, { t, text, level: lvl }].slice(-200))
  // Not awaited: a slow or hung file write never holds up the hook that logs (writeActivity never rejects).
  void writeActivity($, activityLine(t, lvl, text))
  if (lvl === 'warn') $.ui.toast(`orchestrator: ${text}`)
}

async function persist($: $) {
  const dir = await runDir($)
  const agents = await read($, agentsAtom)
  const mainPhase = await read($, phaseAtom)
  const runId = await read($, runAtom)
  const outbox = await read($, outboxAtom)
  await $.fs.write(`${dir}/state.json`, JSON.stringify({ runId, mainPhase, agents, outbox, delivered }))
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

/** Copies to the pressing surface's clipboard and says so in a toast. Never throws. */
async function copyText($: $, text: string, surface: RenderSurface) {
  try {
    const r = await $.ui.copy({ text, surface })
    $.ui.toast(r.isCopied ? 'Copied' : `Not copied (${r.reason})`)
  } catch (err) {
    try {
      $.ui.log(`orchestrator: copy failed: ${String(err)}`)
    } catch {
      // The toast still says it.
    }
    try {
      $.ui.toast('Not copied')
    } catch {
      // Nothing more to do.
    }
  }
}

/** The one copy control: a small plain Button, keyed `copy:<id>`, desktop only (the terminal selects natively). */
function copyButton($: $, ui: Ui, id: string, text: string) {
  const { Button } = ui
  return <Button key={`copy:${id}`} plain dimColor label="⧉" onPress={e => void copyText($, text, e.surface)} />
}

/** Collapses or expands a row's finished descendants. Never rejects: a failed write leaves the fold as it was. */
async function toggleCollapsed($: $, id: string) {
  try {
    await update($, collapsedAtom, c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]))
  } catch (err) {
    try {
      $.ui.log(`orchestrator: fold not saved: ${String(err)}`, { to: 'debug' })
    } catch {
      // nothing more to do
    }
  }
}

/** How long a transcript read may take before the pane calls it not readable. */
export const PEEK_TIMEOUT_MS = 3_000
/** The most items a transcript keeps: the desktop's; the terminal shows fewer. */
const TRANSCRIPT_MAX = 12
/** The terminal's transcript items. */
const TRANSCRIPT_TERMINAL = 6
/** The longest text item stored: whole enough to expand, short enough to keep state small. */
const STEP_CHARS = 2000

/**
 * Records when the mod saw an entry of an agent's transcript: a call once, a text once per time it
 * was said (`repeat`). Synchronous; never throws on good input.
 */
function stamp(agentId: string, key: string, t: number, repeat = false) {
  let m = stamps.get(agentId)
  if (!m) stamps.set(agentId, (m = new Map()))
  const had = m.get(key)
  m.delete(key)
  m.set(key, repeat ? [...(Array.isArray(had) ? had : []), t].slice(-TEXT_STAMPS_MAX) : t)
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
  const messages = await guardedRead(
    $,
    transcriptReads,
    id,
    () => $.session.messages({ agentId: id }).then(f => ('deny' in f ? undefined : f)),
    () => schedulePeek($, id),
  )
  if (messages === IN_FLIGHT) return
  const startedAt = (await read($, agentsAtom)).find(r => r.id === id)?.startedAt ?? 0
  const items = messages
    ? transcriptItems(messages, key => stamps.get(id)?.get(key), { n: TRANSCRIPT_MAX, chars: STEP_CHARS, startedAt })
    : undefined
  await update($, transcriptsAtom, p =>
    items ? { ...p, [id]: { items } } : p[id] && 'items' in p[id] ? p : { ...p, [id]: { denied: true as const } },
  )
}

/**
 * Runs `fetch` for `key` under the slot's guard. The key counts as in flight until the read itself
 * settles, so a hung read never has others piled behind it; a trigger meanwhile is remembered and
 * `rerun` follows once it settles. Resolves `undefined` on a failure or past PEEK_TIMEOUT_MS, and
 * IN_FLIGHT (having remembered the trigger) when that key's read is already under way.
 */
async function guardedRead<T>(
  $: $,
  slot: ReadSlot,
  key: string,
  fetch: () => Promise<T | undefined>,
  rerun: () => void,
): Promise<T | undefined | typeof IN_FLIGHT> {
  if (slot.busy.has(key)) {
    slot.again.add(key)
    return IN_FLIGHT
  }
  slot.busy.add(key)
  const found = fetch()
    .catch(() => undefined)
    .finally(() => {
      slot.busy.delete(key)
      if (slot.again.delete(key)) rerun()
    })
  let timer: { cancel: () => void } | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(PEEK_TIMEOUT_MS, () => resolve(undefined))
  })
  const value = await Promise.race([found, late])
  timer?.cancel()
  return value
}

/** Starts `run` outside the dispatch that asked for it, unless the key's read is in flight: then it is remembered. */
function scheduleRead($: $, slot: ReadSlot, key: string, run: () => Promise<unknown>) {
  if (slot.busy.has(key)) {
    slot.again.add(key)
    return
  }
  $.clock.after(0, () => void run().catch(() => undefined))
}

/** Starts a transcript read outside the dispatch that asked for it, so no hook or press waits on it. */
function schedulePeek($: $, id: string) {
  if (id === 'main') return
  scheduleRead($, transcriptReads, id, () => refreshTranscript($, id))
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
  const use = await guardedRead(
    $,
    toolReads,
    `${agentId}:${toolUseId}`,
    () =>
      $.session.messages({ agentId }).then(f => {
        if ('deny' in f) return undefined
        for (let i = f.length - 1; i >= 0; i--) {
          const found = f[i]!.toolUses.find(u => u.tool_use_id === toolUseId)
          if (found) return found
        }
        return undefined
      }),
    () => scheduleTool($, agentId, toolUseId),
  )
  if (use === IN_FLIGHT) return
  const seen = stamps.get(agentId)?.get(toolUseId)
  const detail = use ? toolDetail(use, typeof seen === 'number' ? seen : undefined) : undefined
  await update($, toolViewAtom, v => {
    if (!v || v.agentId !== agentId || v.toolUseId !== toolUseId) return v
    if (detail) return { agentId, toolUseId, inline: v.inline, detail }
    return v.detail ? v : { ...v, denied: true as const }
  })
}

/** Starts a tool detail read outside the dispatch that asked for it. */
function scheduleTool($: $, agentId: string, toolUseId: string) {
  scheduleRead($, toolReads, `${agentId}:${toolUseId}`, () => refreshTool($, agentId, toolUseId))
}

/**
 * Rereads the open tool call's detail while it is still loading or in flight: from its agent's steps
 * (`agentId`) and from sync (no `agentId`). Off the render, through scheduleTool's guard. Never throws.
 */
async function toolIfPending($: $, agentId?: string) {
  try {
    const v = await read($, toolViewAtom)
    if (!v || (agentId !== undefined && v.agentId !== agentId)) return
    if (!v.detail || v.detail.isPending) scheduleTool($, v.agentId, v.toolUseId)
  } catch {
    // The dialog is a convenience: whatever fails here must not reach a step or a handover.
  }
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

/**
 * A tool call's detail as elements: header, then each section labelled (D11). With `copy`, each label has a
 * copy control (`copy:sec:<toolUseId>:<i>`); `$` serves only that control's press.
 */
function detailBody($: $, ui: Ui, d: ToolDetail, copy?: { toolUseId: string }) {
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
          <Box flexDirection="row" gap={1}>
            <Text dimColor bold>
              {sec.label}
            </Text>
            {/* A Code block carries the desktop's own copy button: ours would be a second one. */}
            {copy && sec.kind !== 'code' && copyButton($, ui, `sec:${copy.toolUseId}:${i}`, bodyOf(sec))}
          </Box>
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

/** What the dialog shows for the open call: its detail (with copy controls when `copyable`), or one dim line. */
function toolBody($: $, ui: Ui, v: ToolView | null, copyable: boolean) {
  const { Text } = ui
  if (!v) return <Text dimColor>No tool call selected.</Text>
  if (v.detail) return detailBody($, ui, v.detail, copyable ? { toolUseId: v.toolUseId } : undefined)
  if (v.denied) return <Text dimColor>tool call not readable (teammate in another pane, or finished)</Text>
  return <Text dimColor>loading…</Text>
}

// ---- subagents -------------------------------------------------------

async function startHandover($: $, id: string, why: string) {
  // Checked and taken before any await: two presses in the same tick both pass canHandOver otherwise.
  if (handoverStarting.has(id)) {
    await log($, `${id}: Hand over not started (already starting; ${why})`)
    return false
  }
  handoverStarting.add(id)
  try {
    const r = (await read($, agentsAtom)).find(a => a.id === id)
    if (!r) {
      await log($, `${id}: Hand over not started (no such agent; ${why})`)
      return false
    }
    if (!canHandOver(r)) {
      await log($, `${label(r)}: Hand over not started (status ${r.status}; ${why})`)
      return false
    }
    const attempt = (r.handovers ?? 0) + 1
    const notePath = notePathFor(await runDir($), r, attempt)
    const now = await $.clock.now()
    await update($, agentsAtom, l =>
      patch(l, id, { status: 'handing-over', notePath, handoverAt: now, handovers: attempt, handoverVia: undefined }),
    )
    if (r.status === 'idle') return await sendHandover($, id, why)
    // A message would wait in a busy teammate's inbox until its turn ends: it rides on the next tool result instead.
    await log($, `${label(r)} ${why}: HANDOVER goes with its next tool result`)
    await persist($)
    return true
  } finally {
    handoverStarting.delete(id)
  }
}

/**
 * Sends HANDOVER as a message, which wakes an idle teammate or resumes a finished subagent. From inside a
 * turn.complete registration it is queued (`queue`), and its stall clock is stopped until it is sent.
 */
async function sendHandover($: $, id: string, why: string, queue = false) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r?.notePath) return false
  const text = handoverMessage(r.notePath, cfg.autoRespawn)
  if (queue) {
    // Unset, so a tool result that carries it before delivery marks it, and the queued send is skipped.
    await update($, agentsAtom, l => patch(l, id, { handoverAt: undefined, handoverVia: undefined }))
    await enqueue($, { kind: 'handover', agentId: id, text, what: `${label(r)} ${why}: HANDOVER not delivered` })
    return true
  }
  return deliverHandover($, id, why, text)
}

/** Sends a HANDOVER now and starts its stall clock; one that cannot be delivered marks the agent stalled. */
async function deliverHandover($: $, id: string, why: string, text: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  // Rechecked at delivery: a tool result may have carried it since it was queued, or the agent been replaced.
  if (r?.status !== 'handing-over' || r.handoverVia !== undefined) {
    // A routine skip: to the file only, not the pane.
    await trace(
      $,
      `${r ? label(r) : id}: HANDOVER not sent (status ${r?.status ?? 'gone'}${r?.handoverVia ? `, already via ${r.handoverVia}` : ''})`,
    )
    return false
  }
  const sent = await sendOwn($, id, text)
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

/** A value for a debug line: a string as it is, anything else as JSON (or String when that fails), cut at 80. */
function debugValue(v: unknown) {
  let s: string
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  } catch {
    s = String(v)
  }
  return s.slice(0, 80)
}

/** The mod's only way to send: marks the send as its own for tool.check while it is in flight. */
async function sendOwn($: $, agentId: string, text: string) {
  const mark = { agentId, text }
  const unmark = () => {
    const i = ownSends.indexOf(mark)
    if (i >= 0) ownSends.splice(i, 1)
  }
  ownSends.push(mark) // synchronously, before any await
  // A send that never answers allows nothing past DRAIN_TIMEOUT_MS.
  let timer: { cancel: () => void } | undefined
  try {
    timer = $.clock.after(DRAIN_TIMEOUT_MS, unmark)
  } catch {
    // no timer: the mark lasts as long as the send
  }
  try {
    return await $.session.send({ to: { agentId }, text })
  } finally {
    timer?.cancel()
    unmark()
  }
}

/** Runs one of the mod's own calls, marked for tool.check while in flight (at most DRAIN_TIMEOUT_MS). */
async function callOwn<T>($: $, mark: OwnCall, run: () => Promise<T>): Promise<T> {
  const unmark = () => {
    const i = ownCalls.indexOf(mark)
    if (i >= 0) ownCalls.splice(i, 1)
  }
  ownCalls.push(mark) // synchronously, before any await
  let timer: { cancel: () => void } | undefined
  try {
    timer = $.clock.after(DRAIN_TIMEOUT_MS, unmark)
  } catch {
    // no timer: the mark lasts as long as the call
  }
  try {
    return await run()
  } finally {
    timer?.cancel()
    unmark()
  }
}

/**
 * tool.check's verdict for an Agent or TaskStop call: allow when it is one of the mod's own in flight, else
 * undefined (the engine decides). Logs the first miss while a call is in flight, by length only. Never throws.
 */
function ownCallVerdict($: $, tool: string, input: unknown) {
  try {
    if (ownCalls.length === 0) return undefined
    if (isOwnCall(input, ownCalls)) return { decision: 'allow' as const, reason: 'orchestrator mod: its own call' }
    if (!callMissLogged) {
      callMissLogged = true
      // No prompt text: the debug log may be shared.
      const p = typeof input === 'object' && input !== null ? (input as { prompt?: unknown }).prompt : undefined
      $.ui.log(`orchestrator: ${tool} check not matched: prompt=${typeof p === 'string' ? `${p.length} chars` : typeof p}`, {
        to: 'debug',
      })
    }
  } catch {
    // fall through to the engine's verdict
  }
  return undefined
}

async function tellParent($: $, parentId: string | undefined, text: string) {
  if (parentId === undefined || parentId === 'main') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    await sendOwn($, parentId, text)
  }
}

/** When the engine registered an agent under another name than it asked for, queues it a notice (once) and logs it. Never throws. */
async function noticeRename($: $, id: string, requested: string | undefined, name: string | undefined) {
  try {
    if (!requested || !name || name === requested) return
    // Claimed before any await: the spawn hook's lookup and a respawn may both get here for one agent.
    if (noticed.has(id)) return
    noticed.add(id)
    const text = nameNotice(name, requested)
    if ((await read($, outboxAtom)).some(d => d.agentId === id && d.text === text)) return
    await enqueue($, { agentId: id, text, what: `${name}: name notice not delivered`, liveOnly: true })
    await log($, `"${requested}" registered as ${name} (${id}); told it so`)
  } catch (err) {
    $.ui.log(`orchestrator: name notice not queued: ${String(err)}`)
  }
}

/**
 * The engine suffixes a taken name (`orchestrator` → `orchestrator-2`): SendMessage, check-ins and reports go
 * by the one it registered, which only its list says (F19). Read after the spawn returns, it renames the row
 * (and adds a teammate's address) and queues the renamed agent its notice. An unlisted agent, or a list that
 * fails, keeps the requested name. Never throws.
 */
async function registeredName($: $, id: string, requested: string | undefined) {
  try {
    const info = (await $.agent.list()).find(a => a.id === id)
    if (!info) return
    const r = (await read($, agentsAtom)).find(a => a.id === id)
    if (!r) return
    const name = info.name ?? requested
    const teammateId = r.teammateId ?? info.teammateId
    if (name !== r.name || teammateId !== r.teammateId) {
      await update($, agentsAtom, l =>
        patch(l, id, { name, ...(typeof teammateId === 'string' && { teammateId }) }),
      )
      await persist($)
    }
    await noticeRename($, id, requested, name)
  } catch {
    // the requested name stands
  }
}

/** A respawn that did not start a replacement: marks the gap, saves the brief, and tells the parent, the person and the log. Never throws. */
async function respawnFailed($: $, old: AgentRow, reason: string) {
  try {
    await update($, agentsAtom, l => patch(l, old.id, { status: 'respawn-failed', ...DISARMED }))
    let briefPath: string | undefined
    if (old.brief && old.notePath) {
      try {
        briefPath = briefPathFor(old.notePath)
        await $.fs.write(briefPath, replacementPrompt(old.brief, old.notePath))
      } catch {
        briefPath = undefined
      }
    }
    const rows = await read($, agentsAtom)
    // A parent that handed over is carried on by its replacement: the notice goes there.
    const to = latest(rows, old.parentId ?? 'main')
    const text = respawnFailedNotice({
      label: label(old),
      id: old.id,
      notePath: old.notePath ?? '(none)',
      reason,
      brief: old.brief,
      briefPath,
    })
    const toRow = rows.find(r => r.id === to)
    await log($, `${label(old)}: no replacement started (${reason}); told ${to === 'main' ? 'main' : toRow ? label(toRow) : to}`, 'warn')
    // A refused notification is fine: the toast said it.
    void $.ui.notify(`${label(old)} handed over, but no replacement started`, { title: 'orchestrator' }).catch(() => undefined)
    if (to === 'main') $.clock.after(0, () => void $.prompt.submit({ text }))
    else {
      const sent = await sendOwn($, to, text)
      if (!sent.isDelivered) await log($, `${label(old)}: parent not told of the failed respawn (${sent.reason})`, 'warn')
    }
    await persist($)
  } catch (err) {
    try {
      $.ui.log(`orchestrator: failed respawn not reported: ${String(err)}`)
    } catch {
      // nothing more
    }
  }
}

/** Stops a replaced agent once its replacement has started, so a late message can't wake it to act. Logged, never thrown. */
async function stopReplaced($: $, old: AgentRow) {
  try {
    // Bounded: a stop that never answers holds neither the drain nor the parent's notice past DRAIN_TIMEOUT_MS.
    let timer: { cancel: () => void } | undefined
    const late = new Promise<'late'>(resolve => {
      try {
        timer = $.clock.after(DRAIN_TIMEOUT_MS, () => resolve('late'))
      } catch {
        // no timer: the stop is awaited as it is
      }
    })
    const stop = callOwn($, { tool: 'TaskStop', taskId: old.id }, () => $.tool.call({ tool: 'TaskStop', task_id: old.id }))
    let res: Awaited<typeof stop> | 'late'
    try {
      res = await Promise.race([stop, late])
    } finally {
      timer?.cancel()
    }
    if (res === 'late') {
      void stop.catch(() => undefined)
      await log($, `${label(old)} (${old.id}) not stopped (no answer in ${DRAIN_TIMEOUT_MS / 1000} s)`)
      return
    }
    const bad = res.deny ?? (res.isError ? String(res.text ?? 'error') : undefined)
    await log($, bad === undefined ? `${label(old)} (${old.id}) stopped` : `${label(old)} (${old.id}) not stopped (${bad})`)
  } catch (err) {
    await log($, `${label(old)} (${old.id}) not stopped (${String(err)})`).catch(() => undefined)
  }
}

/** Links a respawn's replacement: the old agent's children move under it. Never throws. */
async function linkReplacement($: $, old: AgentRow, newId: string) {
  try {
    await update($, agentsAtom, l => adoptChildren(l, old.id, newId))
  } catch (err) {
    $.ui.log(`orchestrator: children of ${old.id} not moved: ${String(err)}`)
  }
}

async function respawn($: $, old: AgentRow) {
  const brief = old.brief
  if (!brief || !old.notePath) return respawnFailed($, old, 'no brief recorded')
  lastSpawned = undefined
  const args = {
    prompt: replacementPrompt(brief, old.notePath),
    subagentType: brief.subagentType,
    description: brief.description,
    model: brief.model,
    name: brief.name,
  }
  let res: Awaited<ReturnType<typeof $.agent.spawn>>
  try {
    res = await callOwn($, { tool: 'Agent', prompt: args.prompt }, () => $.agent.spawn(args))
  } catch (err) {
    return respawnFailed($, old, `spawn failed: ${String(err)}`)
  }
  const newId = res.agentId ?? lastSpawned
  if (res.deny !== undefined || !newId) return respawnFailed($, old, res.deny ?? 'no agent id')
  // A teammate's name is suffixed when the original still holds it; the engine delivers its final reply itself.
  const info = (await $.agent.list()).find(a => a.id === newId)
  const name = info?.name ?? brief.name
  const isTeammate = info?.teammateId !== undefined
  const now = await $.clock.now()
  // The old row's parent as it is now, not as queued: a parent replaced meanwhile has adopted it.
  let parentId = old.parentId
  await update($, agentsAtom, l => {
    parentId = l.find(a => a.id === old.id)?.parentId ?? old.parentId
    const known = l.some(a => a.id === newId) ? l : [...l, newRow(newId, now)]
    return known.map(a =>
      a.id === old.id
        ? { ...a, replacedBy: newId, ...DISARMED }
        : a.id === newId
          ? {
              ...a,
              name,
              description: brief.description,
              type: brief.subagentType,
              brief,
              replaces: old.id,
              parentId,
              isOurs: true,
              isTeammate,
              background: old.background,
              checkinAt: old.checkinAt,
              checkinMins: old.checkinMins,
              checkinBy: old.checkinBy,
            }
          : a,
    )
  })
  await log($, `${label(old)} replaced by ${newId}, resuming from ${old.notePath}`)
  await linkReplacement($, old, newId)
  await noticeRename($, newId, brief.name, info?.name)
  await tellParent(
    $,
    // A parent that handed over is carried on by its replacement: the notice goes there.
    latest(await read($, agentsAtom), parentId ?? 'main'),
    `[orchestrator mod] Agent ${label(old)} (id ${old.id}) reached ${fmtTokens(old.tokens)} context and handed over; note at ${old.notePath}. ` +
      `Replacement id ${newId}${name ? ` (SendMessage name "${name}")` : ''} continues from the note. ` +
      `No action needed: do not spawn another.${!isTeammate && (parentId === 'main' || parentId === undefined) ? ' Its final report will be forwarded to you.' : ''} Update your roster.`,
  )
  // Last: the parent is told first, whatever the stop takes.
  await stopReplaced($, old)
}

// ---- check-in and reports ---------------------------------------------

/** A tool call's own arguments: beside the envelope keys on `e`, or under `e.input` on an engine that nests them. */
const argsOf = (e: object): Record<string, unknown> => {
  const raw = e as Record<string, unknown>
  const nested = raw.input && typeof raw.input === 'object' ? (raw.input as Record<string, unknown>) : {}
  return { ...nested, ...raw }
}

/**
 * Serves the `checkin` tool: the calling loop (`agentId`, else main) arms, re-arms or (minutes <= 0)
 * cancels a check-in on one of its own children (a child of a loop it replaced counts), named by id
 * or name (`resolveAgent`: registered name, else an unambiguous requested name). Every answer is one line of result text starting `checkin:`; an unknown child or a bad
 * length stores nothing.
 */
async function checkin($: $, agentId: string | undefined, args: Record<string, unknown>) {
  const parent = agentId ?? 'main'
  const target = String(args.agent ?? '').trim()
  const minutes = Number(args.minutes)
  if (args.minutes === undefined || args.minutes === null || args.minutes === '' || !Number.isFinite(minutes)) {
    return { result: 'checkin: minutes must be a number (0 cancels); nothing changed.' }
  }
  try {
    await restore($)
    const rows = await read($, agentsAtom)
    const kids = rows.filter(r => r.id !== 'main' && latest(rows, r.parentId ?? 'main') === parent)
    const hit = resolveAgent(kids, target)
    if (!hit) return { result: `checkin: no agent "${target}" among the agents you spawned; nothing changed.` }
    if ('ambiguous' in hit) {
      const list = hit.ambiguous.map(k => `${label(k)} (id ${k.id})`).join(', ')
      return { result: `checkin: "${target}" could mean ${list}; name one by id or registered name; nothing changed.` }
    }
    const r = hit.row
    if (minutes <= 0) {
      await update($, agentsAtom, l => patch(l, r.id, DISARMED))
      await persist($)
      return { result: `checkin: check-in for ${label(r)} (id ${r.id}) cancelled.` }
    }
    const at = (await $.clock.now()) + minutes * 60_000
    await update($, agentsAtom, l => patch(l, r.id, { checkinAt: at, checkinMins: minutes, checkinBy: parent }))
    await persist($)
    return {
      result: `checkin: armed; if ${label(r)} (id ${r.id}) has not reported to you by ${hhmm(at)} UTC (${minutes} min), you will get a message.`,
    }
  } catch (err) {
    return { result: `checkin: failed (${String(err)}); nothing changed.` }
  }
}

/**
 * After a subagent's tool call: a `SendMessage` naming its parent (or the parent's replacement) is this
 * run's report (kept with whether it succeeded) and disarms its check-in; any later call means the
 * report was not its last act. Called inside a `try`, after the HANDOVER is attached.
 */
async function noteReport($: $, id: string, tool: string, args: Record<string, unknown>, res: object) {
  const rows = await read($, agentsAtom)
  const c = rows.find(r => r.id === id)
  if (!c) return
  const parentId = c.parentId ?? 'main'
  // Its parent as spawned, or the replacement now carrying that parent's work.
  const parents = [parentId, latest(rows, parentId)].map(p => rows.find(r => r.id === p) ?? { id: p })
  const out = res as { deny?: unknown; isError?: unknown; result?: unknown }
  const result = out.result && typeof out.result === 'object' ? (out.result as { success?: unknown }) : {}
  const sent = out.deny === undefined && !out.isError && result.success !== false
  // The engine delivers a SubagentHandback to the parent only while that parent's run, or a live child, keeps it
  // live, and never to a teammate; otherwise it goes to main or is refused. One that reached the parent is its report.
  const spawner = rows.find(r => r.id === parentId)
  const handedBack =
    tool === 'SubagentHandback' && result.success === true && sent && !!spawner && LIVE.includes(spawner.status) && !spawner.isTeammate
  const isReport = handedBack || (tool === 'SendMessage' && parents.some(p => namesAgent(args.to, p)))
  if (isReport) {
    const report = { t: await $.clock.now(), text: String(args.message ?? args.report ?? ''), ok: sent, final: true }
    await update($, agentsAtom, l => patch(l, id, { report, ...DISARMED }))
    await persist($)
  } else if (tool === 'SubagentHandback' && c.report === undefined) {
    // Refused, or gone to main: no report to the parent, but noted, so the forward that follows is flagged.
    const report = { t: await $.clock.now(), text: String(args.message ?? args.report ?? ''), ok: false, final: false }
    await update($, agentsAtom, l => patch(l, id, { report }))
    await persist($)
  } else if (c.report?.final) {
    await update($, agentsAtom, l => patch(l, id, { report: { ...c.report!, final: false } }))
    await persist($)
  }
}

/** How long before a turn end another agent's shell must have started for that turn end's list to cover it. */
const RECONCILE_MARGIN_MS = 30_000

/**
 * Ends every tracked open shell a turn end's `background_tasks` no longer lists (the engine drops a finished one):
 * with the code its file holds, else `unknown`. It catches what polling missed. A missing list does nothing.
 * `rows` are those read before the hook's `next`: a shell tracked while it ran is missing from the list, not gone.
 * The stopping agent's (`agentId`) shells are ended at once. Another agent's only once started at least
 * RECONCILE_MARGIN_MS before the turn end (`at`): the session-wide list can predate that agent's new shell. So
 * another agent's shell gone at a turn end less than 30 s after it started is left to the poll or a later turn end;
 * if the poll can't read its file (polling off, the file missing or unreadable) and no turn end comes, only the
 * ceiling nudge catches it.
 */
async function reconcileShells($: $, tasks: unknown, rows: readonly AgentRow[] | undefined, agentId: string, at: number) {
  if (!rows) return
  try {
    const gone = goneShells(rows, tasks).filter(g => g.agentId === agentId || at - g.shell.startedAt >= RECONCILE_MARGIN_MS)
    for (const { shell } of gone) {
      await shellEnded($, shell.id, (await readExit($, shell.outputPath)) ?? 'unknown')
    }
  } catch (err) {
    $.ui.log(`orchestrator: shells not reconciled: ${String(err)}`)
  }
}

/**
 * The hook on both turn ends (`classic.Stop`, `classic.SubagentStop`): bookkeeping after `next`, never a send, and it
 * never changes the answer. The rows are read before `next`, as the list was taken: a shell tracked while the hooks
 * beneath ran is not in it, yet still running. The stopping agent is `agent_id`, absent on main's Stop.
 */
async function reconcileAtStop<E extends { background_tasks?: unknown; agent_id?: string }, R>(
  $: $,
  e: E,
  next: (e: E) => Promise<R>,
) {
  let before: AgentRow[] | undefined
  let at = 0
  try {
    at = await $.clock.now()
    before = await read($, agentsAtom)
  } catch {
    before = undefined // nothing to reconcile against
  }
  const res = await next(e)
  try {
    await reconcileShells($, e.background_tasks, before, e.agent_id ?? 'main', at)
  } catch {
    // see above
  }
  return res
}

// ---- delivery from timers ---------------------------------------------
//
// A run woken by `$.session.send` (or started by `$.agent.spawn`) from a `$.clock` callback runs
// without the mod's hooks: no tool.call, no turn.step, so no HANDOVER and no tracking. One woken from
// inside a hook registration runs without that registration alone. So timers never send, and the main
// turn.complete registration never sends or spawns: both queue, and a drain-only turn.complete
// registration (and /orch) deliver, so a woken run loses only a registration it never needs.

/** Queues a message for the next turn end (or /orch) to deliver, and writes it to state.json so a /clear keeps it. */
async function enqueue($: $, d: Omit<Delivery, 't' | 'id'>) {
  const t = await $.clock.now()
  const id = `${t}-${++deliverySeq}`
  await update($, outboxAtom, q => [...q, { ...d, t, id }])
  await persist($)
}

/**
 * Delivers every queued message from the hook that awaits it. It waits for one state update only:
 * the queue is taken and emptied at once (so two hooks never deliver one message twice), then every
 * send is started before it returns, still inside the hook, and none is awaited, so a send that never
 * answers holds up neither the hook nor a later drain. A failed send is warned and dropped. Never throws.
 */
async function drain($: $) {
  if (draining) return
  draining = true
  let taken: Delivery[] = []
  try {
    await update($, outboxAtom, q => {
      taken = q
      return []
    })
  } catch (err) {
    $.ui.log(`orchestrator: outbox not drained: ${String(err)}`)
  } finally {
    draining = false
  }
  if (taken.length === 0) return
  nudgedSinceDrain = false
  // Recorded as delivered before any send starts: a restore never brings one back.
  delivered.push(...taken.map(d => d.id))
  delivered.splice(0, Math.max(0, delivered.length - DELIVERED_MAX))
  // A respawn or a HANDOVER changes rows: those are awaited (in a turn.complete, not a handover path).
  const changes: Promise<unknown>[] = []
  // Read once, for live-only messages: one whose agent is no longer live is dropped (unread rows: dropped too).
  let rows: AgentRow[] = []
  if (taken.some(d => d.liveOnly)) rows = await read($, agentsAtom).catch(() => [])
  for (const d of taken) {
    if (d.liveOnly && (d.kind ?? 'send') === 'send') {
      const r = rows.find(a => a.id === d.agentId)
      if (!r || !LIVE.includes(r.status)) continue
    }
    if (d.kind === 'respawn') {
      changes.push(
        (d.row ? respawn($, d.row) : Promise.resolve()).catch(err => log($, `${d.what}: ${String(err)}`, 'warn')),
      )
      continue
    }
    if (d.kind === 'handover') {
      changes.push(
        deliverHandover($, d.agentId, 'ended before seeing it', d.text).catch(err =>
          log($, `${d.what}: ${String(err)}`, 'warn'),
        ),
      )
      continue
    }
    try {
      void sendOwn($, d.agentId, d.text)
        .then(
          sent => (sent.isDelivered ? undefined : log($, `${d.what} (${sent.reason})`, 'warn')),
          err => log($, `${d.what}: ${String(err)}`, 'warn'),
        )
        .catch(() => undefined)
    } catch (err) {
      void log($, `${d.what}: ${String(err)}`, 'warn').catch(() => undefined)
    }
  }
  if (changes.length > 0) {
    // Bounded: a spawn or send that never answers holds this turn's end no longer than DRAIN_TIMEOUT_MS.
    let timer: { cancel: () => void } | undefined
    const late = new Promise<'late'>(resolve => {
      timer = $.clock.after(DRAIN_TIMEOUT_MS, () => resolve('late'))
    })
    const settled = await Promise.race([Promise.all(changes).then(() => 'done' as const), late]).catch(() => 'done' as const)
    timer?.cancel()
    if (settled === 'late') {
      await log($, `outbox: a respawn or HANDOVER still running after ${DRAIN_TIMEOUT_MS / 1000} s; not waiting`, 'warn').catch(
        () => undefined,
      )
    }
    await persist($).catch(() => undefined)
  } else {
    // The emptied queue reaches state.json too, off the hook's path.
    void persist($).catch(() => undefined)
  }
}

/**
 * From sync: when messages have waited a whole sync with no turn end to deliver them, prompts main once
 * (marked as the mod's), whose turn end drains them. Not while main is mid-turn (that turn's end drains),
 * and not again until a drain has happened.
 */
async function nudgeIfStuck($: $) {
  if (mainBusy || nudgedSinceDrain || (await read($, outboxAtom)).length === 0) return
  nudgedSinceDrain = true
  await $.prompt.submit({
    text: '[orchestrator mod] queued messages are waiting for delivery to your agents; this turn delivers them. Nothing to do: reply "ok".',
  })
}

/** Sends each due check-in to whoever armed it, once: the deadline is cleared before the message goes. */
async function fireCheckins($: $, now: number) {
  for (const r of checkinDue(await read($, agentsAtom), now)) {
    await update($, agentsAtom, l => patch(l, r.id, DISARMED))
    await persist($)
    const shows = displayStatus(r, await read($, agentsAtom))
    const text =
      `[orchestrator mod] check-in: ${label(r)} (id ${r.id}) has not reported after ${r.checkinMins ?? '?'} min; ` +
      `status ${shows}, last active ${hhmm(r.lastActive)}. Check on it, or call checkin again to re-arm.`
    try {
      // An orchestrator that handed over since arming it is carried on by its replacement.
      const by = latest(await read($, agentsAtom), r.checkinBy ?? 'main')
      if (by === 'main') {
        // Submitted, as a replacement's report is: an appended message would not wake main.
        $.clock.after(0, () => void $.prompt.submit({ text }))
        $.ui.toast(`orchestrator: check-in: ${label(r)} has not reported after ${r.checkinMins ?? '?'} min`)
      } else {
        // From sync, a timer: queued for the next hook to deliver, so the woken parent keeps its hooks.
        await enqueue($, { agentId: by, text, what: `check-in for ${label(r)} not delivered` })
      }
    } catch (err) {
      await log($, `check-in for ${label(r)} not delivered: ${String(err)}`, 'warn')
    }
  }
}

/**
 * Nudges each agent idle with nothing running past `idleWatchdogMinutes`, once per idle stretch: the nudge
 * is recorded first, and queued, live only, for the next turn end to deliver.
 */
async function fireWatchdog($: $, now: number, engine: ReadonlyMap<string, string>) {
  for (const r of watchdogDue(await read($, agentsAtom), engine, now, cfg.idleWatchdogMinutes * 60_000)) {
    await update($, agentsAtom, l => patch(l, r.id, { watchdog: { t: now, ends: 0 } }))
    await enqueue($, {
      agentId: r.id,
      text: watchdogNudge(cfg.idleWatchdogMinutes),
      what: `idle nudge for ${label(r)} not delivered`,
      liveOnly: true,
    })
    await log($, `${label(r)}: idle ${cfg.idleWatchdogMinutes} min with nothing running: nudged`)
    await persist($)
  }
}

/**
 * Forwards a child's final answer to its parent agent when `forwardTarget` says so, which wakes or
 * resumes that parent. A failure is warned, never thrown.
 */
async function forwardAnswer($: $, r: AgentRow, answer: string, reason: string) {
  const to = forwardTarget(r, answer, reason, await read($, agentsAtom))
  if (to === 'skip') return
  const text =
    `[orchestrator mod] final report of ${label(r)} (id ${r.id}${r.replaces ? `, replacement for ${r.replaces}` : ''})` +
    `${to.mayDuplicate ? ' (may duplicate a message it sent you)' : ''}, auto-forwarded:\n\n${answer}`
  // Queued: sent from inside this turn.complete registration, the woken parent would run without it.
  try {
    await enqueue($, { agentId: to.agentId, text, what: `${label(r)}: final report not forwarded to ${to.agentId}` })
  } catch (err) {
    await log($, `${label(r)}: final report not forwarded to ${to.agentId}: ${String(err)}`, 'warn')
  }
}

async function onAgentEnd($: $, id: string, answer: string, reason = 'answer') {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r) return
  // Its run is over: its next run reports afresh. Its check-in is spent only when it truly ends below; a
  // handover keeps it, for the replacement to inherit (or for the note-writing run it is woken for).
  // A turn ended since the idle watchdog's nudge: one besides the nudge's own run re-arms it.
  await update($, agentsAtom, l =>
    patch(l, id, { report: undefined, ...watchdogTurnEnded(l.find(a => a.id === id)?.watchdog) }),
  )
  // A stalled handover is settled by its end like any other: by the note, if it wrote one late.
  if (r.status === 'handing-over' || r.status === 'stalled') {
    if (r.notePath && (await $.fs.exists(r.notePath))) {
      // Disarmed here too, so no check-in fires about it when nothing respawns it; respawn reads `r`, still armed.
      await update($, agentsAtom, l => patch(l, id, { status: 'replaced', ...DISARMED }))
      await log($, `${label(r)} handed over (${r.notePath})`)
      // Queued: started from inside this registration, the replacement's run would end unseen by it.
      if (cfg.autoRespawn) {
        await enqueue($, { kind: 'respawn', agentId: id, text: '', what: `${label(r)}: respawn failed`, row: { ...r, status: 'replaced' } })
      }
    } else if (r.status === 'handing-over' && r.handoverVia !== 'message') {
      // It finished before a tool result could carry the HANDOVER: the message wakes it to write the note.
      await sendHandover($, id, 'ended before seeing it', true)
      return
    } else {
      await update($, agentsAtom, l => patch(l, id, { status: 'done', ...DISARMED }))
      await log($, `${label(r)} ended without writing its handover note`, 'warn')
    }
  } else if (isActive(r)) {
    // A teammate ends a turn whenever it waits on its children: only its report or its end disarms its check-in.
    await update($, agentsAtom, l => patch(l, id, { status: 'idle', ...(r.isTeammate ? {} : DISARMED) }))
    if (r.isOurs && !r.isTeammate && r.parentId === 'main') {
      // The engine does not tell main of an agent the mod spawned: its replacement's report is submitted.
      const text = `[orchestrator mod] ${label(r)} (id ${id}, replacement for ${r.replaces}) reports:\n\n${answer}`
      $.clock.after(0, () => void $.prompt.submit({ text }))
    } else await forwardAnswer($, r, answer, reason)
  }
  await persist($)
}

/**
 * A resumed run not yet ended (its end sets idle) that stepped within STALL_MS: the engine may leave it
 * out of its list while it runs, so only its end, or that long a silence, settles it.
 */
const resumedRunning = (r: AgentRow, now: number) =>
  r.status === 'running' && r.resumedAt !== undefined && now - r.lastActive <= STALL_MS

/** Marks agents the engine no longer lists as done, and handovers that hang as stalled. */
async function sync($: $) {
  const listedAgents = await $.agent.list()
  const listed = new Set(listedAgents.map(a => a.id))
  const engineStatus = new Map(listedAgents.map(a => [a.id, String(a.status)]))
  const now = await $.clock.now()
  const rows = await read($, agentsAtom)
  let changed = false
  for (const r of rows) {
    if (r.id === 'main') continue
    if (r.status === 'handing-over' && r.handoverAt && now - r.handoverAt > STALL_MS) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'stalled' }))
      await log($, `${label(r)} has not handed over after ${Math.round(STALL_MS / 60_000)} min`, 'warn')
      void $.ui.notify(`${label(r)} has not handed over`, { title: 'orchestrator' }).catch(() => undefined)
      changed = true
    } else if (isActive(r) && !listed.has(r.id) && !resumedRunning(r, now)) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'done', ...DISARMED }))
      changed = true
    }
  }
  if (changed) await persist($)
  try {
    // Messages queued by an earlier sync and still undelivered get main to run a hooked turn.
    await nudgeIfStuck($)
  } catch (err) {
    $.ui.log(`orchestrator: outbox nudge failed: ${String(err)}`)
  }
  try {
    await fireCheckins($, now)
  } catch (err) {
    $.ui.log(`orchestrator: check-ins not fired: ${String(err)}`)
  }
  try {
    await fireWatchdog($, now, engineStatus)
  } catch (err) {
    $.ui.log(`orchestrator: idle watchdog not run: ${String(err)}`)
  }
  // The open transcript is read again now and then, so one left loading (a reload, a lost read) settles.
  const selected = liveSelection(await read($, agentsAtom), await read($, selectedAtom))
  if (selected) schedulePeek($, selected)
  await toolIfPending($)
}

// ---- background shells -----------------------------------------------

/** The biggest output file read whole: a bigger one's marker is read from its tail, so a poll never copies much. */
const FULL_READ_MAX = 64 * 1024
/** Each open shell's output file size at its last poll: an unchanged file is not read again. */
const shellSizes = new Map<string, number>()
/** A poll in flight: the next tick skips rather than overlap it. */
let shellTicking = false

/**
 * The exit marker in a file's last 256 bytes, through `tail`: for a file over FULL_READ_MAX. Undefined for no marker
 * yet; null when tail failed (it rejected, or exited non-zero), so the poll tries it again.
 */
async function tailExit($: $, path: string): Promise<number | 'killed' | undefined | null> {
  try {
    const res = await $.process.run(['tail', '-c', '256', path], { timeoutMs: 5000 })
    return res.exitCode === 0 ? shellExit(res.stdout) : null
  } catch {
    return null
  }
}

/** The exit marker at the end of an output file; none for no path, a file gone, or no marker yet. */
async function readExit($: $, path: string): Promise<number | 'killed' | undefined> {
  if (!path) return undefined
  try {
    if ((await $.fs.stat(path)).size > FULL_READ_MAX) return (await tailExit($, path)) ?? undefined
    return shellExit(await $.fs.read(path))
  } catch {
    return undefined
  }
}

/** Records how an open shell ended, wherever it is tracked. */
async function shellEnded($: $, shellId: string, exit: ShellExit) {
  const rows = await read($, agentsAtom)
  const r = rows.find(a => a.shells?.some(s => s.id === shellId && s.exit === undefined))
  const shell = r?.shells?.find(s => s.id === shellId)
  if (!r || !shell) return
  const t = await $.clock.now()
  await update($, agentsAtom, l => endShell(l, shellId, exit, t))
  shellSizes.delete(shellId)
  await log($, `${label(r)}: background command "${shellName(shell)}" (${shellId}) ${shellEndWords(exit)}`)
  await persist($)
}

/** Tracks a Bash call an agent (or main) sent to the background, and drops a shell a TaskStop stopped. */
async function noteShell($: $, agentId: string, tool: string, args: Record<string, unknown>, res: object) {
  // A call naming a finished shell's id or output path (Read, TaskOutput, cat) picked it up; a failed one did not.
  const own = (await read($, agentsAtom)).find(a => a.id === agentId)
  if (!(res as { isError?: unknown }).isError && own?.shells?.some(s => s.exit !== undefined)) {
    const mention = JSON.stringify(args)
    const kept = own.shells.length
    let left = kept
    await update($, agentsAtom, l => {
      const next = pickUpShells(l, agentId, mention)
      left = next.find(a => a.id === agentId)?.shells?.length ?? 0
      return next
    })
    if (left !== kept) await persist($)
  }
  if (tool === 'Bash') {
    const bg = backgroundedShell(res)
    if (!bg) return
    const r = (await read($, agentsAtom)).find(a => a.id === agentId)
    if (!r) return
    const shell = {
      ...bg,
      description: String(args.description ?? ''),
      command: String(args.command ?? ''),
      startedAt: await $.clock.now(),
    }
    await update($, agentsAtom, l => addShell(l, agentId, shell))
    await log($, `${label(r)}: background command "${shellName(shell)}" (${shell.id}) started`)
    await persist($)
  } else if (tool === 'TaskStop') {
    const done = res as { deny?: unknown; isError?: unknown }
    if (done.deny !== undefined || done.isError) return
    const id = args.task_id ?? args.shell_id
    if (typeof id !== 'string') return
    const r = (await read($, agentsAtom)).find(a => a.shells?.some(s => s.id === id))
    const shell = r?.shells?.find(s => s.id === id)
    if (!r || !shell) return
    await update($, agentsAtom, l => dropShell(l, id))
    shellSizes.delete(id)
    await log($, `${label(r)}: background command "${shellName(shell)}" (${id}) stopped (TaskStop)`)
    await persist($)
  }
}

/** Polls each open shell's output file for its exit marker, reading a file only when its size changed. */
async function shellTick($: $) {
  if (shellTicking) return
  shellTicking = true
  try {
    const rows = await read($, agentsAtom)
    if (cfg.shellPollSeconds > 0) {
      for (const shell of rows.flatMap(openShells)) {
        if (!shell.outputPath) continue
        try {
          const size = (await $.fs.stat(shell.outputPath)).size
          // Empty as it was backgrounded: an unseen file counts as 0 bytes.
          if (size === (shellSizes.get(shell.id) ?? 0)) continue
          // Over FULL_READ_MAX: its tail, again only once it grows. A read that rejects (it goes to the catch) or a
          // tail that fails (null) leaves the size unrecorded: the next tick retries it.
          const exit =
            size > FULL_READ_MAX ? await tailExit($, shell.outputPath) : shellExit(await $.fs.read(shell.outputPath))
          if (exit === null) continue
          shellSizes.set(shell.id, size)
          if (exit !== undefined) await shellEnded($, shell.id, exit)
        } catch {
          // A file gone or unreadable: reconciliation at a turn end, or the ceiling, settles the shell.
        }
      }
    }
    try {
      await shellDeadlines($, await $.clock.now())
    } catch (err) {
      $.ui.log(`orchestrator: background command nudges not checked: ${String(err)}`)
    }
  } catch (err) {
    try {
      $.ui.log(`orchestrator: background commands not polled: ${String(err)}`)
    } catch {
      // nothing more to do
    }
  } finally {
    shellTicking = false
  }
}

/**
 * From the poll: queues one nudge to an idle agent whose finished shells went unpicked for the grace (then counts
 * them picked up, so it is sent once), and one about each shell past the ceiling (main: a warning, never a prompt).
 * Every nudge is live-only and rides the outbox. Never throws.
 */
async function shellDeadlines($: $, now: number) {
  try {
    const rows = await read($, agentsAtom)
    const graceMs = cfg.shellGraceSeconds * 1000
    const minutes = cfg.shellCeilingMinutes
    // The engine's list only when something is due: a row the engine has finished gets no nudge.
    const graceAny = graceDue(rows, now, graceMs)
    const ceilingAny = ceilingDue(rows, now, minutes * 60_000)
    if (!graceAny.length && !ceilingAny.length) return
    // A list that fails leaves every row eligible: drain's live-only check still guards delivery.
    const engine = await $.agent.list().then(
      l => new Map(l.map(a => [a.id, String(a.status)])),
      () => undefined,
    )
    let changed = false
    // A row the engine lists as ended is settled unnudged, so no later tick asks the engine about it again.
    const ended = (id: string) => ['completed', 'failed', 'killed'].includes(engine?.get(id) ?? '')
    for (const r of graceAny.filter(r => ended(r.id))) {
      await update($, agentsAtom, l => pickUpShells(l, r.id))
      changed = true
    }
    for (const { shell } of ceilingAny.filter(d => ended(d.row.id))) {
      await update($, agentsAtom, l => markCeiling(l, shell.id))
      changed = true
    }
    for (const r of graceDue(rows, now, graceMs, engine)) {
      const finished = (r.shells ?? []).filter(s => s.exit !== undefined)
      await enqueue($, { agentId: r.id, text: shellNudge(finished), what: `shell nudge for ${label(r)} not delivered`, liveOnly: true })
      await update($, agentsAtom, l => pickUpShells(l, r.id))
      changed = true
      await log($, `${label(r)}: nudged about finished background command(s) ${finished.map(s => s.id).join(', ')}`)
    }
    for (const { row: r, shell } of ceilingDue(rows, now, minutes * 60_000, engine)) {
      await update($, agentsAtom, l => markCeiling(l, shell.id))
      changed = true
      const what = `${label(r)}: background command "${shellName(shell)}" (${shell.id}) still running after ${minutes} min`
      if (r.id === 'main') {
        await log($, what, 'warn')
      } else {
        await enqueue($, { agentId: r.id, text: ceilingNudge(shell, minutes), what: `ceiling nudge for ${label(r)} not delivered`, liveOnly: true })
        await log($, `${what}: nudged`)
      }
    }
    if (changed) await persist($)
  } catch (err) {
    try {
      $.ui.log(`orchestrator: background command nudges not checked: ${String(err)}`)
    } catch {
      // nothing more to do
    }
  }
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
  cfg.shellPollSeconds = numberSetting(options.shellPollSeconds, 15)
  cfg.shellGraceSeconds = numberSetting(options.shellGraceSeconds, 60)
  cfg.idleWatchdogMinutes = numberSetting(options.idleWatchdogMinutes, 5)
  cfg.shellCeilingMinutes = numberSetting(options.shellCeilingMinutes, 60)
  paneOffered = false
  teammatesWarned.clear()
  mainBusy = false
  mainHandoverQueued = false
  mainHandoverStarting = false
  transcriptReads.busy.clear()
  transcriptReads.again.clear()
  stamps.clear()
  toolReads.busy.clear()
  toolReads.again.clear()
  ownSends.length = 0
  checkMissLogged = false
  ownCalls.length = 0
  callMissLogged = false
  draining = false
  nudgedSinceDrain = false
  activity = undefined
  activityPath = ''
  activityPending.length = 0
  activityChain = Promise.resolve()
  handoverStarting.clear()
  shellSizes.clear()
  shellTicking = false

  // ---- events ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch',
      description: 'Orchestrator: open or close the agents pane, show the roster, or hand an agent (or main) over now',
      argumentHint: '[close | roster | handover [name|id]]',
    })
    await runDir($)
    await excludeFromGit($).catch(() => undefined)
    try {
      await $.tool.register({
        name: 'checkin',
        description:
          'Arm a one-shot check-in on an agent you spawned: if it has not reported to you (SendMessage) within `minutes`, ' +
          'the orchestrator mod messages you, which wakes you. Calling again re-arms; minutes 0 cancels.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'The agent you spawned: its name or id' },
            minutes: { type: 'number', description: 'Minutes from now; 0 cancels' },
          },
          required: ['agent', 'minutes'],
        },
        isDeferred: false,
      })
    } catch (err) {
      $.ui.log(`orchestrator: checkin tool not registered: ${String(err)}`)
    }
    // A (re)load starts with no handover queued: the state must not say otherwise.
    await update($, queuedAtom, () => false)
    $.clock.every(SYNC_MS, () => void sync($))
    // Runs even with polling off: the shell deadlines ride it too.
    $.clock.every((cfg.shellPollSeconds || 30) * 1000, () => void shellTick($))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(cfg.injectClause ? { ...e, prompt: e.prompt + HANDOVER_CLAUSE } : e)
    if (res.deny !== undefined || !res.agentId) return res
    const id = res.agentId
    lastSpawned = id
    const type = e.subagentType ?? (e as typeof e & { subagent_type?: string }).subagent_type ?? 'agent'
    const name = e.name
    // A teammate's address (`<name>@<team>`), which its SendMessage checks may name it by.
    const teammateId = res.teammateId
    const now = await $.clock.now()
    await update($, agentsAtom, l => [
      ...l.filter(a => a.id !== id),
      {
        ...newRow(id, now),
        name,
        description: e.description,
        type,
        parentId: e.parentAgentId ?? 'main',
        background: e.background,
        ...(e.isTeammate && { isTeammate: true }),
        ...(typeof teammateId === 'string' && { teammateId }),
        brief: {
          prompt: e.prompt,
          subagentType: type,
          description: e.description,
          model: e.model,
          name: e.name,
        },
      },
    ])
    await log($, `spawned ${name ?? e.description} (${id})`)
    const rows = await read($, agentsAtom)
    // The engine never delivers a SubagentHandback to a teammate: its children's reports rely on the forward.
    const spawner = rows.find(r => r.id === e.parentAgentId)
    if (spawner?.isTeammate && !teammatesWarned.has(spawner.id)) {
      teammatesWarned.add(spawner.id)
      await log(
        $,
        `${label(spawner)} is a teammate: SubagentHandback from its children cannot reach it (an engine limit); ` +
          'their final answers are auto-forwarded. Spawn an orchestrator without a name to avoid this.',
        'warn',
      )
    }
    // A parent's own replacement for a failed respawn names the old agent's note: link the two.
    // Only the agent told of the gap (the old parent's latest) links it: not by name, which the engine may suffix.
    const gap = rows.find(
      r =>
        r.status === 'respawn-failed' &&
        r.notePath &&
        e.prompt.includes(r.notePath) &&
        (e.parentAgentId ?? 'main') === latest(rows, r.parentId ?? 'main'),
    )
    if (gap) {
      await update($, agentsAtom, l =>
        adoptChildren(patch(patch(l, gap.id, { status: 'replaced', replacedBy: id }), id, { replaces: gap.id }), gap.id, id),
      )
      await log($, `${label(gap)}: ${name ?? id} (${id}) takes over from its note`)
      // Off the spawn's path, as the name lookup below: the Agent result never waits on the stop.
      void stopReplaced($, gap)
    }
    await persist($)
    // Off the spawn's path: the Agent result and the pane never wait on the engine's list.
    void registeredName($, id, e.name)
    if (!paneOffered) {
      paneOffered = true
      void $.ui.open({ id: PANE, title: 'Orchestrator' })
    }
    return res
 }).catch(($, e, next) => next(e)) // tracking failed: the spawn goes ahead either way

  on('turn.step', async function* ($, e, next) {
    // A shell that ends after this, during the step, had no notice in the prompt the step answers.
    const stepStart = await $.clock.now()
    const res = yield* next(e)
    if (!res.usage) return res
    try {
      await restore($)
      const id = e.agentId ?? 'main'
      const now = await $.clock.now()
      if (id !== 'main' && !(await read($, agentsAtom)).some(a => a.id === id)) {
        const info = (await $.agent.list()).find(a => a.id === id)
        if (!info) return res // an engine fork (compaction, memory): not an agent of the run
        // Adopted from the engine's list, which says nothing of background: `background` stays absent, and
        // `forwardTarget` treats absent as background on purpose (only a known foreground child is skipped).
        await update($, agentsAtom, l => [
          ...l,
          { ...newRow(id, now), name: info.name, description: info.description, type: info.type, parentId: info.parentId ?? 'main' },
        ])
      }
      const tokens = contextOf(res.usage)
      // The answering model wins over the requested one; an engine without effort leaves it out.
      const ran = { model: res.usage?.model ?? e.model, effort: e.effort === undefined ? undefined : String(e.effort) }
      const before = (await read($, agentsAtom)).find(a => a.id === id)
      // A new run (its first step since a turn end: a status recordStep revives; main at any step) has seen its
      // finished shells' notices. A stalled handover's step is the same run.
      const newRun = before !== undefined && (['idle', 'done', 'respawn-failed'] as AgentRow['status'][]).includes(before.status)
      const pickUp = (id === 'main' || newRun) && !!before?.shells?.some(s => s.exit !== undefined)
      await update($, agentsAtom, l => {
        const stepped = patch(recordStep(l, { id, tokens, t: now, tools: res.toolUses.length }), id, ran)
        return pickUp ? pickUpShells(stepped, id, undefined, newRun ? stepStart : undefined) : stepped
      })
      try {
        // When the step's visible text was seen, for the transcript; synchronous, and it can cost the step nothing.
        if (id !== 'main' && res.answer) stamp(id, textKey('assistant', res.answer), now, true)
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
    if (e.agentId !== undefined) await toolIfPending($, e.agentId)
    return res
  })

  on('tool.call', async ($, e, next) => {
    // The mod's own tool: answered here, never passed on (a call no hook answers fails).
    if (e.tool === CHECKIN_TOOL) {
      const answer = await checkin($, e.agentId, argsOf(e))
      // Still an action of the caller's run: a report before it was not its last.
      if (e.agentId !== undefined) await noteReport($, e.agentId, e.tool, {}, answer).catch(() => undefined)
      return answer as never
    }
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
    // A SendMessage naming a replaced agent goes to its newest replacement, and the sender is told the new name.
    let call = e
    let redirected: string | undefined
    if (e.tool === 'SendMessage') {
      try {
        const to = (e as { to?: unknown }).to
        const dest = redirectTarget(await read($, agentsAtom), to, e.agentId)
        if (dest && typeof to === 'string') {
          const addr = addressFor(dest, to)
          call = { ...e, to: addr } as typeof e
          redirected = `[orchestrator mod] ${to} was replaced by ${addr} (id ${dest.id}); this message went to ${addr}. Use that name from now on.`
          await log($, `SendMessage to ${to} from ${e.agentId ?? 'main'} redirected to ${addr} (${dest.id}): ${to} was replaced`)
        }
      } catch (err) {
        $.ui.log(`orchestrator: SendMessage not redirected: ${String(err)}`)
      }
    }
    const res = await next(call)
    if (res.deny !== undefined) {
      // A refused call is still an action: a report before it was not the run's last (a refused report is not ok).
      if (e.agentId !== undefined) await noteReport($, e.agentId, e.tool, argsOf(call), res).catch(() => undefined)
      return res
    }
    let out = redirected === undefined ? res : { ...res, context: [...(res.context ?? []), redirected] }
    try {
      await noteShell($, e.agentId ?? 'main', e.tool, argsOf(call), res)
    } catch (err) {
      $.ui.log(`orchestrator: shell not tracked: ${String(err)}`)
    }
    if (e.agentId === undefined) return out
    try {
      const r = (await read($, agentsAtom)).find(a => a.id === e.agentId)
      if (r?.status === 'handing-over' && !r.handoverVia && r.notePath) {
        await update($, agentsAtom, l => patch(l, r.id, { handoverVia: 'tool' }))
        await log($, `${label(r)}: HANDOVER delivered with a tool result`)
        await persist($)
        out = { ...out, context: [...(out.context ?? []), handoverMessage(r.notePath, cfg.autoRespawn)] }
      }
    } catch (err) {
      $.ui.log(`orchestrator: HANDOVER not attached: ${String(err)}`)
    }
    try {
      // After the HANDOVER is attached, and it never alters `out`: a report to the parent disarms the check-in.
      await noteReport($, e.agentId, e.tool, argsOf(call), res)
    } catch (err) {
      $.ui.log(`orchestrator: report not noted: ${String(err)}`)
    }
    // Last, after the HANDOVER is attached: the peek and the open detail's reread can cost it nothing.
    await peekIfSelected($, e.agentId)
    await toolIfOpen($, e.agentId, e.tool_use_id)
    return out
  })

  // The mod's own sends (Hand over, a forwarded report, a check-in) are SendMessage calls to the engine;
  // under auto mode the classifier refuses them, since no user request asked. Allow exactly those, while in flight.
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    try {
      const input = (e.input ?? {}) as { to?: unknown; message?: unknown }
      if (ownSends.length > 0) {
        const rows = await read($, agentsAtom)
        const mine = isOwnSend({
          origin: next.origin,
          agentId: e.agentId,
          to: input.to,
          message: input.message,
          inFlight: ownSends,
          rows,
        })
        if (mine) return { decision: 'allow', reason: 'orchestrator mod: its own message' }
      }
      if (ownSends.length > 0 && !checkMissLogged) {
        checkMissLogged = true
        // No message text: the debug log may be shared, and a message can carry anything.
        const length = typeof input.message === 'string' ? `${input.message.length} chars` : typeof input.message
        $.ui.log(`orchestrator: SendMessage check not matched: to=${debugValue(input.to)} message=${length}`, {
          to: 'debug',
        })
      }
    } catch {
      // fall through to the engine's verdict
    }
    return next(e)
  })

  // The mod's own respawn (Agent) and its stop of a replaced agent (TaskStop) are tool calls no request asked for;
  // under auto mode the classifier refuses them. Allow exactly those, while in flight.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => ownCallVerdict($, e.tool, e.input) ?? next(e))
  on('tool.check', { tool: 'TaskStop' }, async ($, e, next) => ownCallVerdict($, e.tool, e.input) ?? next(e))

  // A turn end lists the session's background work still running: a tracked shell missing from it has ended.
  on('classic.SubagentStop', reconcileAtStop).catch(($, e, next) => next(e))
  on('classic.Stop', reconcileAtStop).catch(($, e, next) => next(e))

  // Raised for main's turns alone: a subagent's run raises no turn.start.
  on('turn.start', ($, e, next) => {
    mainBusy = true
    return next(e)
  })

  // Drain-only: delivers what was queued. A run woken (or spawned) by a call made inside a hook
  // registration runs without that registration, so deliveries come from this one, which does nothing
  // else: a woken run keeps the turn.complete registration below, and with it its end's tracking.
  // (Registered first, so it wraps the one below and drains after it. A second registration of an event
  // needs a matcher; every turn end has a reason, so this matches all.)
  on('turn.complete', { reason: /./ }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      await drain($)
    }
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
      if (e.agentId !== undefined) await onAgentEnd($, e.agentId, e.answer, e.reason)
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
    try {
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
        const hit = resolveAgent(live, target)
        if (!hit) return { text: `No live agent named or with id "${target}".` }
        if ('ambiguous' in hit) {
          const list = hit.ambiguous.map(a => `${label(a)} (id ${a.id})`).join(', ')
          return { text: `"${target}" could mean ${list}; name one by id.` }
        }
        const r = hit.row
        const ok = await startHandover($, r.id, 'by /orch')
        return { text: ok ? `HANDOVER sent to ${label(r)} (${r.id}).` : `Could not hand ${label(r)} over.` }
      }
      return { text: 'Usage: /orch [close | roster | handover [name|id|main]]' }
    } finally {
      // Last: delivers what timers queued. A run woken from inside a hook runs without that hook kind, and
      // none needs turn.complete (or command.run) to be tracked, so only these two deliver.
      await drain($)
    }
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

  // A pane Hand over press is handled here, in hook context: a send from the button's own closure runs in
  // the plugin's environment like a timer's, and could wake the agent without the mod's hooks.
  on('ui.press', async ($, e, next) => {
    // Every press on the mod's surfaces goes to activity.log (not the pane): a lost press shows as a missing line.
    if (e.plugin === 'orchestrator') {
      try {
        await trace($, `press ${e.element} (${e.surface}, ${e.requestId})`)
      } catch {
        // A record only.
      }
    }
    const id = e.element.startsWith('handover:') ? e.element.slice('handover:'.length) : ''
    if (e.plugin !== 'orchestrator' || e.requestId !== PANE || id === '' || id === 'main') return next(e)
    try {
      await startHandover($, id, 'from the pane')
    } catch (err) {
      $.ui.log(`orchestrator: hand over from the pane failed: ${String(err)}`)
    }
    return { element: e.element }
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
        {toolBody($, ui, v, e.surface !== 'terminal')}
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
    // Collapsed rows hide their finished descendants from the tree and the chart; all else reads every row.
    const collapsed = await read($, collapsedAtom)
    const hidden = collapseHidden(rows, collapsed)
    const visible = rows.filter(r => !hidden.has(r.id))
    const doneMark = (id: string) => {
      const n = collapsed.includes(id) ? hiddenCount(rows, id, hidden) : 0
      return n > 0 ? `+${n} done` : ''
    }
    // The transcript the host has open beside the pane (read-only; absent on older hosts and kit mounts). Main is never marked.
    const viewed = liveSelection(visible, e.props.view?.agentId ?? '')
    // A row folds when it is collapsed or collapsing it would hide something; read from every row, as `hidden` is.
    const foldable = (id: string) => canFold(rows, id, collapsed)
    /** The header's `c` hotkey: folds the selected row, else main; drawn only when that row can fold. */
    const foldHotkey = (Button: ReturnType<typeof $.ui.resolve>['Button'], selected: string) => {
      const target = liveSelection(visible, selected) || 'main'
      const tRow = rows.find(r => r.id === target)
      if (!tRow || !foldable(target)) return undefined
      return (
        <Button
          key="fold-hotkey"
          plain
          hotkey="c"
          label={`${collapsed.includes(target) ? 'expand' : 'collapse'} ${label(tRow)}`}
          onPress={() => toggleCollapsed($, target)}
        />
      )
    }
    /**
     * A row's fold cell: its disclosure glyph when it can fold, else a space of the glyph's width.
     * The space sits in a keyed Box: a drawn Text keeps no key.
     */
    const foldCell = (ui: ReturnType<typeof $.ui.resolve>, id: string) =>
      foldable(id) ? (
        <ui.Button key={`fold:${id}`} plain onPress={() => toggleCollapsed($, id)}>
          {foldGlyph(collapsed.includes(id))}
        </ui.Button>
      ) : (
        <ui.Box key={`nofold:${id}`}>
          <ui.Text> </ui.Text>
        </ui.Box>
      )

    if (e.surface !== 'terminal') {
      // Desktop, VS Code, mobile: a vector chart, native buttons, activity that expands in flow.
      const { Box, Button, Text, Svg } = $.ui.resolve(e)
      const selected = liveSelection(visible, await read($, selectedAtom))
      // Colours and the time axis come from every row, so collapsing neither recolours nor rescales.
      const colors = seriesColors(rows)
      // A click selection wins; with none, the agent in view stands out.
      const hl = selected || viewed
      const chart = contextChart({
        rows: visible,
        t0: rows.reduce((m, r) => Math.min(m, r.startedAt), now),
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
                {toolBody($, ui, tv, true)}
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
                {copyButton($, ui, pin, it.full)}
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
            {foldHotkey(Button, selected)}
          </Box>
          {rows.length === 0 ? (
            <Text dimColor>No model requests yet.</Text>
          ) : (
            <Svg key="chart" isInteractive source={chart.source} alt={chart.alt} width={chart.width} height={chart.height} />
          )}
          <Box flexDirection="column">
            {orderRows(visible).flatMap(({ row, depth }) => {
              const ceiling = ceilingOf(row, cfg)
              const pct = Math.round((row.tokens / ceiling) * 100)
              const shows = displayStatus(row, rows)
              const model = modelLabel(row.model ?? row.brief?.model, row.effort)
              const folded = doneMark(row.id)
              return [
                <Box key={`row:${row.id}`} flexDirection="row" paddingLeft={depth * 2} gap={1}>
                  {foldCell(ui, row.id)}
                  <Button key={`agent:${row.id}`} plain onPress={() => toggleSelected($, row.id)}>
                    <Text color={colors.get(row.id)}>● </Text>
                    <Text bold={hl === row.id}>{label(row)} </Text>
                    {row.resumedAt !== undefined && <Text dimColor>↻ </Text>}
                    {folded !== '' && <Text dimColor>{folded} </Text>}
                    {model !== '' && <Text dimColor>{model} </Text>}
                    <Text color={tone[level(row.tokens, ceiling)]}>
                      {fmtTokens(row.tokens)}/{fmtTokens(ceiling)} {pct}%{' '}
                    </Text>
                    <Text>{statusEmoji(shows, row.id)} </Text>
                    <Text dimColor>{shows}</Text>
                    {viewed === row.id && <Text dimColor> · in view</Text>}
                  </Button>
                  {copyButton($, ui, `agent:${row.id}`, label(row) === row.id ? row.id : `${label(row)} (${row.id})`)}
                  {canHandOver(row) && (
                    <Button
                      key={`handover:${row.id}`}
                      variant="secondary"
                      label="Hand over"
                      // The send is made in the ui.press hook (real hook context); this closure only marks the press.
                      onPress={() => undefined}
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
                      {copyButton($, ui, id, l.text)}
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
    // The fold cell: the disclosure glyph (or a space) and a space.
    const FOLD = 2
    const width = Math.max(8, cols - NAME - 7 - 14 - MODEL)
    const t0 = rows.reduce((m, r) => Math.min(m, r.startedAt), now)
    const ordered = orderRows(visible)
    const glyph: Record<DisplayStatus, string> = {
      running: '●',
      waiting: '◐',
      idle: '○',
      'handing-over': '↻',
      replaced: '⤳',
      done: '✓',
      stalled: '!',
      'respawn-failed': '✗',
    }
    const selected = liveSelection(visible, await read($, selectedAtom))
    // Main is the main view already: only a subagent's transcript is shown, in a bordered box beneath its row.
    const peek =
      selected && selected !== 'main'
        ? transcriptView((await read($, transcriptsAtom))[selected], Math.max(10, cols - 4), TRANSCRIPT_TERMINAL)
        : undefined
    const peekRows = peek ? ('items' in peek ? peek.items.length : 1) + 2 : 0
    // A session that places no dialog (too narrow, or no surface places panes) shows the open call's detail in flow.
    const tv = await read($, toolViewAtom)
    const ui = $.ui.resolve(e)
    // Rows left for an open expansion and the activity; the activity gives up exactly the rows an expansion takes.
    // The header's button can wrap onto a row of its own.
    const base = terminalBase({ rows: e.viewport?.rows ?? 30, agents: ordered.length, peekRows, buttonRow: shown })
    // A pane too small for an expansion (cap 0) shows none: a press then only pins.
    const cap = expandCap(base)
    const fits = cols - 6
    // Inside the transcript box's border, the expansion's border, its padding spaces and slack.
    const textLines = (full: string) => capLines(wrapFill(full, Math.max(10, cols - 8)), cap)
    // Inside the expansion's border, its padding spaces and slack.
    const logLines = (text: string) => capLines(wrapFill(text, Math.max(10, cols - 6)), cap)
    const pinOf = (agentId: string, it: TranscriptLine) => it.id.replace(/^step-/, `step-${agentId}-`)
    const expRows = (() => {
      if (pinned === '' || cap === 0) return 0
      if (peek && 'items' in peek && selected) {
        const it = peek.items.find(it => it.kind !== 'tool' && it.full !== undefined && pinOf(selected, it) === pinned)
        if (it) return textLines(it.full!).length + 2
      }
      const l = entries.slice(-Math.max(3, base)).find(l => l.text.length > fits && logId(l) === pinned)
      return l ? logLines(l.text).length + 2 : 0
    })()
    // A pinned line that falls outside the shrunk room is not drawn; its rows still count, so the pane only shows fewer.
    const room = Math.max(3, base - expRows)
    /** One transcript row: a tool call opens its detail; a press on a cut text shows its full text beneath it, in flow. */
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
              {toolBody($, ui, tv, false)}
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
      const pin = pinOf(agentId, it)
      // A press shows the full text beneath it, in flow: it pushes the rows beneath down and never covers them.
      return (
        <Box key={it.id} flexDirection="column">
          <Button key={pin} plain onPress={() => togglePinned($, pin)}>
            {time}
            {who}
            <Text>{it.short}</Text>
          </Button>
          {pinned === pin && cap > 0 && (
            <Box key={`full:${pin}`} borderStyle="round" flexDirection="column" width={cols - 2}>
              {textLines(it.full).map((w, j) => (
                <Text key={`w${j}`} wrap="truncate">{` ${w}`}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }
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
          {foldHotkey(Button, selected)}
        </Box>
        {ordered.length === 0 && <Text dimColor>No model requests yet.</Text>}
        {ordered.flatMap(({ row, depth }) => {
          const ceiling = ceilingOf(row, cfg)
          const live = LIVE.includes(row.status)
          const shows = displayStatus(row, rows)
          const style = statusStyle(shows)
          // Indent, fold cell, status glyph and name together fill NAME columns. Deep rows stop indenting
          // rather than eat the name's minimum 4 columns.
          const indentW = Math.min(depth * 2, Math.max(0, NAME - FOLD - 2 - 4))
          const glyphCell = (
            <Text color={style.color} dimColor={style.dimColor} bold={style.bold} wrap="truncate">
              {`${glyph[shows]} `}
            </Text>
          )
          // A resumed agent's dim ↻ and a collapsed row's `+N done` sit inside the name cell, which keeps its width.
          const room = NAME - indentW - FOLD - 2
          const folded = doneMark(row.id)
          // The name keeps at least 4 columns (or its whole self); the marks shrink first: `+3 done` to `+3`, then the ↻ goes.
          const spare = room - Math.min(label(row).length, 4)
          const turn = row.resumedAt === undefined ? '' : ' ↻'
          const short = folded.replace(/ done$/, '')
          const mark =
            [`${turn}${folded ? ` ${folded}` : ''}`, `${turn}${short ? ` ${short}` : ''}`, short ? ` ${short}` : '', ''].find(
              m => m.length <= spare,
            ) ?? ''
          const name = label(row).slice(0, room - mark.length)
          const nameCell = (
            <Text dimColor={!live} inverse={viewed === row.id} bold={selected === row.id} wrap="truncate">
              {name}
              {mark !== '' && <Text dimColor>{mark}</Text>}
              {' '.repeat(room - name.length - mark.length)}
            </Text>
          )
          const model = modelLabel(row.model ?? row.brief?.model, row.effort)
          return [
            <Box key={row.id}>
              <Text>{' '.repeat(indentW)}</Text>
              {foldCell(ui, row.id)}
              <Text> </Text>
              {/* Main too is pressable: a press selects it, so `c` acts on it; it opens no transcript. */}
              <Button key={`agent:${row.id}`} plain onPress={() => toggleSelected($, row.id)}>
                {glyphCell}
                {nameCell}
              </Button>
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
          if (l.text.length <= fits) {
            return (
              <Text key={`l${i}`} color={color} wrap="truncate">
                <Text dimColor>{hhmm(l.t)} </Text>
                {l.text}
              </Text>
            )
          }
          // Too long: cut with an ellipsis; a press shows the full text beneath it, in flow, and a second press hides it.
          const id = logId(l)
          return (
            <Box key={`l${i}`} flexDirection="column">
              <Button key={id} plain onPress={() => togglePinned($, id)}>
                <Text dimColor>{hhmm(l.t)} </Text>
                <Text color={color}>{cut(l.text, fits)}</Text>
              </Button>
              {pinned === id && cap > 0 && (
                <Box key={`full:${id}`} borderStyle="round" flexDirection="column" width={cols}>
                  {logLines(l.text).map((w, j) => (
                    <Text key={`w${j}`} color={color} wrap="truncate">{` ${w}`}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
