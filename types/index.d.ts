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
  /** How many handovers this row has started; numbers its note paths. */
  handovers?: number
  /** A replacement that started too full for another handover to help: left to run. */
  noHandover?: boolean
}

export type LogEntry = { t: number; text: string; level: 'info' | 'warn' }

export type MainPhase = 'idle' | 'offered' | 'writing' | 'clearing' | 'cooldown'

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      agents: AgentRow[]
      log: LogEntry[]
      mainPhase: MainPhase
      runId: string
    }
  }
}
