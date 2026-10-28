/** One reading of an agent's context: when, and how many tokens it held. */
export type Sample = { t: number; tokens: number }

/** What an agent was spawned with, kept so a replacement can be spawned alike. */
export type Brief = {
  prompt: string
  subagentType: string
  description: string
  model?: string
  name?: string
}

/** `respawn-failed`: handed over with its note written, but no replacement started to carry its work. */
export type AgentStatus = 'running' | 'idle' | 'handing-over' | 'replaced' | 'done' | 'stalled' | 'respawn-failed'

/** What the pane shows for a row: its status, or `waiting` for an idle row with live descendants. Never stored. */
export type DisplayStatus = AgentStatus | 'waiting'

/** How a background shell ended: its exit code, `killed` (TaskStop, or claude's graceful exit), or `unknown` (the engine stopped listing it and its file has no marker). */
export type ShellExit = number | 'killed' | 'unknown'

/** A Bash command an agent sent to the background, as the mod tracks it. */
export type Shell = {
  /** The result's backgroundTaskId. */
  id: string
  /** From the result's text; '' when it names none. */
  outputPath: string
  description: string
  command: string
  startedAt: number
  endedAt?: number
  exit?: ShellExit
  /** The one ceiling nudge (or main's warning) was given. */
  ceilingNudged?: true
}

/** One agent loop as the mod tracks it; the main thread is the row with id `main`. */
export type AgentRow = {
  id: string
  name?: string
  description: string
  type: string
  /** The loop that spawned it (for a replacement, its predecessor's parent). */
  parentId?: string
  status: AgentStatus
  tokens: number
  peak: number
  samples: Sample[]
  steps: number
  tools: number
  startedAt: number
  lastActive: number
  brief?: Brief
  notePath?: string
  handoverAt?: number
  /**
   * How the HANDOVER reached it: with a tool result while it ran, or as a message
   * once idle (which a teammate only reads between turns). Absent until it has.
   */
  handoverVia?: 'tool' | 'message'
  replaces?: string
  replacedBy?: string
  /** Spawned by this mod: its final answer is forwarded to `parentId`. */
  isOurs?: boolean
  /** A named teammate: the engine delivers its final reply to its parent, so the mod does not. */
  isTeammate?: boolean
  /** A teammate's address in its team, `<name>@<team>`, as the spawn result or the engine's list gave it. */
  teammateId?: string
  /** How many handovers this row has started; numbers its note paths. */
  handovers?: number
  /** A replacement that started too full for another handover to help: left to run. */
  noHandover?: boolean
  /** Spawned in the background (false: its answer is its parent's tool result). Absent when unknown. */
  background?: boolean
  /**
   * This run's report to its parent, as last seen: a `SendMessage` naming the parent, or a `SubagentHandback`
   * the engine delivered while the parent was live and no teammate. A handback refused or rerouted to main is
   * kept as never `ok`, only to flag a forward as a possible duplicate.
   * `ok` when it succeeded; `final` while it is still the run's last tool call.
   * Cleared when the run ends, so each run is judged on its own.
   */
  report?: { t: number; text: string; ok: boolean; final: boolean }
  /** A check-in deadline its parent armed through the `checkin` tool, its length, and who armed it. */
  checkinAt?: number
  checkinMins?: number
  checkinBy?: string
  /** The model its last step ran on (the answering id, else the requested one). */
  model?: string
  /** Its last step's effort, as a string (`'medium'`, or a token budget such as `'32000'`). */
  effort?: string
  /** When a step last revived it from done: it was resumed by a message after it ended. */
  resumedAt?: number
  /** Its open background shells, and finished ones not yet picked up. */
  shells?: Shell[]
  /** When its last open shell ended. */
  shellsDoneAt?: number
  /** The idle watchdog's nudge, and how many of its turns have ended since. */
  watchdog?: { t: number; ends: number }
}

export type LogEntry = { t: number; text: string; level: 'info' | 'warn' }

/**
 * One entry of an agent's transcript as the pane shows it: a message's text, or
 * one of its tool calls. `key` is stable across reads; `t` is when the mod saw it
 * (absent when it never did).
 */
export type TranscriptItem =
  | { kind: 'text'; key: string; t?: number; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; key: string; t?: number; toolUseId: string; tool: string; brief: string; isError?: true; isPending?: true }

/** An agent's transcript items as the pane last read them, off the render, or `denied`. */
export type Transcript = { items: TranscriptItem[] } | { denied: true }

/**
 * One part of a tool call's detail, as `hooks/detail.ts` builds it. Declared here too because this
 * contract must be self-contained; the two are structurally the same, so tsc checks they agree.
 */
export type DetailSection =
  | { kind: 'code'; label: string; source: string; language?: string; path?: string; startLine?: number; diff?: true }
  | { kind: 'markdown'; label: string; text: string }
  | { kind: 'text'; label: string; text: string }

/** A tool call laid out for the detail dialog (`toolDetail` in `hooks/detail.ts`). */
export type ToolDetail = { tool: string; time: string; isError: boolean; isPending: boolean; sections: DetailSection[] }

/**
 * The tool call the detail dialog shows: which call, whether it is drawn inline in the
 * main pane (no surface placed the dialog), and its detail once read, or `denied`.
 */
export type ToolView = { agentId: string; toolUseId: string; inline: boolean; detail?: ToolDetail; denied?: true }

/**
 * A message or spawn the mod could not safely make where it decided to. A run woken (or started) from
 * a timer runs without the mod's hooks, and one woken from inside a hook registration runs without that
 * registration; so such work is queued and a drain-only turn.complete registration (or /orch) does it.
 */
export type Delivery = {
  id: string
  /** A message (`send`, the default), a HANDOVER (its stall clock starts once sent), or a respawn of `agentId`. */
  kind?: 'send' | 'handover' | 'respawn'
  agentId: string
  text: string
  /** What the warning says if it fails, e.g. `check-in for impl-2 not delivered`. */
  what: string
  t: number
  /** For a respawn: the replaced row as it ended, check-in included, for the replacement to inherit. */
  row?: AgentRow
  /** A message only worth sending while its agent is live: dropped unsent once it is not, so it wakes no finished agent. */
  liveOnly?: true
}

export type MainPhase = 'idle' | 'offered' | 'writing' | 'clearing' | 'cooldown'

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      agents: AgentRow[]
      log: LogEntry[]
      mainPhase: MainPhase
      runId: string
      /** The one cut line shown whole: an activity line (`log-…`) or a transcript text (`step-<agentId>-…`); '' for none. */
      pinnedLog: string
      /** The agent a click selected: its chart line highlighted, its Timeline taking over the pane ('' for none). */
      selectedAgent: string
      /** Turns of the open timeline shown expanded, by turn key. */
      expandedTurns: string[]
      /** Why the last jump could not go ('' for none); drawn under the timeline's header. */
      jumpNote: string
      /** Each agent's last transcript items by id, read off the render; the pane draws the selected one's. */
      transcripts: Record<string, Transcript>
      /** Messages queued by timers, delivered by the next hook to run. */
      outbox: Delivery[]
      /** Rows collapsed by the fold glyph or `c`: their finished descendants are hidden from the pane (display only). */
      collapsed: string[]
      /** The tool call open in the detail dialog, or null. */
      toolView: ToolView | null
      /** A main handover asked for mid-turn, waiting for that turn to end. */
      mainQueued: boolean
    }
  }
}
