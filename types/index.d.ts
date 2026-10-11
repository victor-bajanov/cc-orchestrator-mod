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

export type AgentStatus = 'running' | 'idle' | 'handing-over' | 'replaced' | 'done' | 'stalled'

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
  /** How many handovers this row has started; numbers its note paths. */
  handovers?: number
  /** A replacement that started too full for another handover to help: left to run. */
  noHandover?: boolean
  /** The model its last step ran on (the answering id, else the requested one). */
  model?: string
  /** Its last step's effort, as a string (`'medium'`, or a token budget such as `'32000'`). */
  effort?: string
}

export type LogEntry = { t: number; text: string; level: 'info' | 'warn' }

/**
 * An agent's transcript tail as the pane last read it, off the render: its lines
 * (cleaned, each capped), or `denied` when no read has given lines (refused,
 * failed or timed out).
 */
export type Peek = { lines: string[] } | { denied: true }

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

export type MainPhase = 'idle' | 'offered' | 'writing' | 'clearing' | 'cooldown'

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      agents: AgentRow[]
      log: LogEntry[]
      mainPhase: MainPhase
      runId: string
      pinnedLog: string
      /** The agent a click selected: its chart line highlighted, its transcript shown beneath its row ('' for none). */
      selectedAgent: string
      /** Each agent's transcript tail by id, read off the render; the pane draws the selected one's. */
      peeks: Record<string, Peek>
      /** A main handover asked for mid-turn, waiting for that turn to end. */
      mainQueued: boolean
    }
  }
}
