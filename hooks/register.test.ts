import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow } from '../types'
import { PEEK_TIMEOUT_MS, isOwnCall, isOwnOrigin, isOwnSend, liveSelection } from './register'
import { expandCap, hhmm, terminalBase } from './view'
import { ACTIVITY_MAX, HANDOVER_CLAUSE, nameNotice, replacementPrompt } from './core'
import { PEEK_DENIED as DENIED, runnerFor } from './view'

const RUN_DIR = '/repo/.orchestrator/S1'
const STATE = `${RUN_DIR}/state.json`

/** The world beneath the plugin: everything it calls on `$`, answered from memory and recorded. */
const world = (on: On) => {
  const w = {
    clock: mock.clock(on, { now: 1_000_000 }),
    tokens: new Map<string, number>(),
    sent: [] as { to: string; text: string }[],
    prompts: [] as string[],
    commands: [] as string[],
    spawns: [] as { prompt: string; name?: string; subagentType: string; description: string; model?: string }[],
    files: new Map<string, string>(),
    toasts: [] as string[],
    opened: [] as string[],
    /** Each `ui.open` as asked. */
    openArgs: [] as Record<string, unknown>[],
    /** Runs while /clear is in flight, as a turn the person starts before the restart finishes. */
    duringClear: undefined as (() => Promise<unknown>) | undefined,
    /** What `$.agent.list()` answers. */
    agents: [] as { id: string; name?: string; teammateId?: string; status?: string }[],
    /** The `teammateId` the next `agent.spawn` answers with, once (the list need not give it). */
    nextTeammateId: undefined as string | undefined,
    closed: [] as string[],
    /** The status line as last set. */
    status: undefined as string | undefined,
    /** Makes the next main turn end fail beneath the plugin, once. */
    failMainEnd: false,
    /** The model each step's usage reports as answering. */
    usageModel: 'claude-opus-5-5',
    /** The visible text each step answers with. */
    answer: '',
    /** Whether the surfaces place the tool-detail dialog (false: an older desktop). */
    placesTool: true,
    /** Each tool the plugin registered. */
    tools: [] as { name: string; isDeferred?: unknown; inputSchema?: unknown }[],
    /** Answers a tool call beneath the plugin; undefined gives `{ result: 'ok' }`. */
    toolAnswer: undefined as ((e: Record<string, unknown>) => unknown) | undefined,
    /** How `session.send` fails: not at all, by throwing, or undelivered. */
    sendFails: '' as '' | 'throw' | 'undelivered',
    /** The next `session.send` is recorded, then never answers. */
    hangNext: false,
    /** The next `agent.spawn` is recorded, then never answers. */
    hangSpawn: false,
    /** Set while a test moves the clock: a send seen then came from a timer callback. */
    inTimer: false,
    /** Sends made while `inTimer`. */
    timerSends: [] as string[],
    /** Every state.json the plugin wrote, in order. */
    writes: [] as string[],
    /** While set, the engine's turn.step and tool.call beneath the plugin wait on it. */
    holdNext: undefined as Promise<void> | undefined,
    /** While set, `$.agent.list()` answers only once it settles: a slow engine list. */
    holdList: undefined as Promise<void> | undefined,
    /** Each `$.ui.log` line. */
    logs: [] as string[],
    /** Each `$.ui.log` line with the sink it asked for (`undefined`: the transcript). */
    logSinks: [] as { text: string; to?: string }[],
    /** `ui.log` throws while set. */
    logFails: false,
    /** Each `ui.copy` as asked. */
    copies: [] as { text: string; surface?: string }[],
    /** How `ui.copy` answers: copied, a refusal reason, or a throw. */
    copyFails: '' as '' | 'no-clipboard' | 'throw',
    /** Auto mode: each session.send first asks tool.check for SendMessage, and a verdict other than allow refuses it. */
    checkSends: false,
    /** The test's own engine, for checks from inside a hook: a hook's `$` may call only what the plugin's module calls. */
    engine: undefined as Engine | undefined,
    /** The verdict each checked send got, in order. */
    checks: [] as string[],
    /** Runs inside each session.send, after its own check: `check` asks tool.check about any SendMessage. */
    duringSend: undefined as
      | ((check: (input: { to: unknown; message: unknown }) => Promise<string>, e: { to: string; text: string }) => Promise<unknown>)
      | undefined,
    /** The verdict of each mod spawn's Agent check (auto mode), in order. */
    spawnChecks: [] as string[],
    /** Runs inside the mod's spawn, after its check: `check` asks tool.check about any Agent input. */
    duringSpawn: undefined as ((check: (input: Record<string, unknown>) => Promise<string>) => Promise<unknown>) | undefined,
    /** The next spawn is refused with this reason ('' none); 'throw' makes it throw. Refused spawns are not recorded. */
    spawnDeny: '' as string,
    /** `ui.notify` refuses with this reason while set ('' none). */
    notifyDeny: '' as string,
    /** Each agent a TaskStop stopped, in order. */
    stops: [] as string[],
    /** The verdict of each TaskStop check (auto mode), in order. */
    stopChecks: [] as string[],
    /** While set, a write of activity.log never answers. */
    activityHang: false,
    /** The next mod spawn waits on this before it is recorded (and numbered), once. */
    spawnHoldNext: undefined as Promise<void> | undefined,
    /** How TaskStop fails: not at all, by throwing, never answering ('hang'), or refused with this reason. */
    stopFails: '' as '' | 'throw' | 'hang' | string,
    /** What `session.id` answers: a /clear changes it. */
    sessionId: 'S1',
    /** `fs.write` to this path throws ('' none). */
    fsFails: '' as string,
    /** The next `fs.read` throws, once. */
    readFailsOnce: false,
    /** Each path `fs.read` was asked for, in order. */
    reads: [] as string[],
  }
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: '/repo' }))
  on('agent.list', async () => {
    if (w.holdList) await w.holdList
    return { value: w.agents as never }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.send', async ($, e) => {
    if (w.checkSends) {
      const check = async (input: { to: unknown; message: unknown }) =>
        (await w.engine!.tool.check({ tool: 'SendMessage', input } as never)).decision
      const verdict = await check({ to: e.to, message: e.text })
      w.checks.push(verdict)
      await w.duringSend?.(check, { to: e.to, text: e.text })
      if (verdict !== 'allow')
        return { isDelivered: false, reason: 'The server-side auto mode classifier gave no verdict for SendMessage' } as never
    }
    if (w.inTimer) w.timerSends.push(e.text)
    if (w.hangNext) {
      w.hangNext = false
      w.sent.push({ to: e.to, text: e.text })
      return new Promise(() => {}) as never
    }
    if (w.sendFails === 'throw') throw new Error('send broke')
    if (w.sendFails === 'undelivered') return { isDelivered: false, reason: 'gone' } as never
    w.sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('tool.register', ($, e) => {
    w.tools.push(e as never)
    return { value: { tool: `mcp__orchestrator__${e.name}` } }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('command.run', async ($, e) => {
    w.commands.push(e.command)
    if (e.command === 'clear') await w.duringClear?.()
    return { text: '' }
  })
  on('agent.spawn', async ($, e) => {
    // Auto mode judges a spawn with no Agent tool call behind it (the mod's own; the model's carry a tool_use_id).
    if (w.checkSends && !e.tool_use_id) {
      const check = async (input: Record<string, unknown>) =>
        (await w.engine!.tool.check({ tool: 'Agent', input } as never)).decision
      const verdict = await check({
        prompt: e.prompt,
        description: e.description,
        subagent_type: e.subagentType,
        name: e.name,
        model: e.model,
      })
      w.spawnChecks.push(verdict)
      await w.duringSpawn?.(check)
      if (verdict !== 'allow') return { deny: 'The server-side auto mode classifier gave no verdict for Agent' } as never
    }
    if (w.spawnDeny === 'throw') {
      w.spawnDeny = ''
      throw new Error('spawn broke')
    }
    if (w.spawnDeny) {
      const deny = w.spawnDeny
      w.spawnDeny = ''
      return { deny } as never
    }
    if (w.spawnHoldNext && !e.tool_use_id) {
      const hold = w.spawnHoldNext
      w.spawnHoldNext = undefined
      await hold
    }
    const raw = e as typeof e & { subagent_type?: string }
    w.spawns.push({ ...e, subagentType: e.subagentType ?? raw.subagent_type ?? '' })
    if (w.hangSpawn) {
      w.hangSpawn = false
      return new Promise(() => {}) as never
    }
    const agentId = `agent${w.spawns.length}`
    const teammateId = w.nextTeammateId
    w.nextTeammateId = undefined
    return { model: 'opus', agentId, ...(teammateId && { teammateId }) }
  })
  on('fs.write', ($, e) => {
    if (w.activityHang && e.path.endsWith('activity.log')) return new Promise(() => {}) as never
    if (w.fsFails && e.path === w.fsFails) throw new Error('disk full')
    if (e.path === STATE) w.writes.push(e.text)
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    if (w.readFailsOnce) {
      w.readFailsOnce = false
      throw new Error('EIO: read failed')
    }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('ui.log', ($, e) => {
    if (w.logFails) throw new Error('log broke')
    w.logs.push(e.text)
    w.logSinks.push({ text: e.text, to: (e as { to?: string }).to })
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    if (w.copyFails === 'throw') throw new Error('clipboard broke')
    w.copies.push({ text: e.text, surface: e.surface })
    return { value: w.copyFails ? { isCopied: false, reason: w.copyFails } : { isCopied: true } } as never
  })
  on('ui.status', ($, e) => {
    w.status = e.text
    return { value: undefined }
  })
  on('ui.notify', () => (w.notifyDeny ? ({ deny: w.notifyDeny } as never) : { value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    w.openArgs.push(e as unknown as Record<string, unknown>)
    if (e.id === 'orchestrator-tool' && !w.placesTool) return { value: { isPlaced: false, reason: 'older desktop' } as never }
    return { value: { isPlaced: true } }
  })
  on('turn.step', async function* ($, e) {
    if (w.holdNext) await w.holdNext
    const tokens = w.tokens.get(e.agentId ?? 'main') ?? 1000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: w.answer,
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokens - 10,
        output_tokens: 50,
        model: w.usageModel,
      },
    }
  })
  on('turn.complete', ($, e) => {
    if (w.failMainEnd && e.agentId === undefined) {
      w.failMainEnd = false
      throw new Error('engine failed')
    }
    return { text: e.answer }
  })
  on('tool.call', async ($, e) => {
    if (e.tool === 'TaskStop') {
      const id = String((e as { task_id?: unknown }).task_id)
      if (w.checkSends) {
        const verdict = (await w.engine!.tool.check({ tool: 'TaskStop', input: { task_id: id } } as never)).decision
        w.stopChecks.push(verdict)
        if (verdict !== 'allow') return { deny: 'The server-side auto mode classifier gave no verdict for TaskStop' } as never
      }
      if (w.stopFails === 'throw') throw new Error('stop broke')
      if (w.stopFails === 'hang') return new Promise(() => {}) as never
      if (w.stopFails) return { deny: w.stopFails } as never
      w.stops.push(id)
      return { result: { message: 'stopped', task_id: id, task_type: 'local_agent' } } as never
    }
    if (w.holdNext) await w.holdNext
    return (w.toolAnswer?.(e as never) ?? { result: 'ok' }) as never
  })
  return Object.assign(w, { session })
}

import type { Engine } from 'claude-code/testing'

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const spawn = (
  $: Engine,
  o: { prompt: string; name?: string; parentAgentId?: string; model?: string; background?: boolean; isTeammate?: boolean },
) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: o.prompt,
    description: 'implement task',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    name: o.name,
    model: o.model,
    parentAgentId: o.parentAgentId,
    background: o.background ?? true,
    ...(o.isTeammate && { isTeammate: true }),
    fork: false,
  } as never)

const step = async ($: Engine, agentId?: string, o: { model?: string; effort?: string } = {}) => {
  const s = $.turn.step({ turnId: 'T', index: 0, model: o.model ?? 'claude-opus-5-5', effort: o.effort, messageCount: 3, agentId } as never)
  for await (const _ of s) void _
  return s.result
}

/** One tool call in an agent's loop; `context` is what the model reads after the result. */
const tool = async ($: Engine, agentId: string) =>
  (await $.tool.call({ tool: 'Read', file_path: '/x', tool_use_id: 'tu', agentId } as never)) as { context?: readonly string[] }

const complete = ($: Engine, agentId: string | undefined, answer = 'done') =>
  $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 'T', agentId, reason: 'answer' })

type World = ReturnType<typeof world>

/** Auto mode: the engine's own verdict for a SendMessage is `ask` (the classifier), beneath the plugin. */
const autoMode = ($: Engine, on: On, w: World) => {
  w.checkSends = true
  w.engine = $
  on('tool.check', () => ({ decision: 'ask' }))
}
const snapshot = (w: World): { agents: AgentRow[]; mainPhase: string } =>
  JSON.parse(w.files.get(STATE) ?? '{"agents":[],"mainPhase":"idle"}')
const row = (w: World, id: string) => snapshot(w).agents.find(r => r.id === id)
const phase = (w: World) => snapshot(w).mainPhase

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', bodyColumns = 100) =>
  $.ui.mount({ plugin: 'orchestrator', surface, component: 'Pane', requestId: 'orchestrator', props: { bodyColumns } as never })

/** One live agent at 300k; main stays at its default 1,000 tokens, below every threshold. */
const running = async ($: Engine, w: World) => {
  await start($)
  await spawn($, { prompt: 'P', name: 'impl-1' })
  w.tokens.set('agent1', 300_000)
  await step($, 'agent1')
}

describe('subagents', () => {
  test('adds the HANDOVER clause to a brief and records the agent', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Implement task 1.', name: 'impl-1' })
    expect(w.spawns[0]!.prompt.startsWith('Implement task 1.')).toBe(true)
    expect(w.spawns[0]!.prompt).toContain('HANDOVER')
    const r = row(w, 'agent1')
    expect(r).toEqual(expect.objectContaining({ name: 'impl-1', parentId: 'main', status: 'running' }))
    expect(r!.brief!.prompt).toBe('Implement task 1.')
  })

  test('leaves the brief alone when the clause is off', { options: { injectClause: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Implement task 1.' })
    expect(w.spawns[0]!.prompt).toBe('Implement task 1.')
  })

  test('records each step and hands HANDOVER to a running agent with its next tool result', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 200_000)
    await step($, 'agent1')
    expect(row(w, 'agent1')!.tokens).toBe(200_000)
    expect((await tool($, 'agent1')).context).toBeUndefined()

    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await step($, 'agent1')
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    // a message would sit in a busy teammate's inbox until its turn ends: none is sent
    expect(w.sent).toHaveLength(0)

    const seen = (await tool($, 'agent1')).context ?? []
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('HANDOVER')
    expect(seen[0]).toContain(`${RUN_DIR}/handover/impl-1-agent1-1.md`)
    // once only, and never in another agent's loop
    expect((await tool($, 'agent1')).context).toBeUndefined()
    expect((await tool($, 'other')).context).toBeUndefined()
  })

  test('sends HANDOVER to an agent that ended its turn before seeing it, then respawns once it writes the note', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'probe' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await complete($, 'agent1', 'my 16 lines')
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.to).toContain('agent1')
    expect(w.sent[0]!.text).toContain('HANDOVER')
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    expect(w.spawns).toHaveLength(1)

    // the message wakes it; it writes the note and ends again
    w.files.set(`${RUN_DIR}/handover/probe-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    expect(w.spawns).toHaveLength(2)
    expect(row(w, 'agent1')!.status).toBe('replaced')
  })

  test('a replaced agent that ends again stays replaced', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1')
    await complete($, 'agent1', 'woke on a late message')
    expect(row(w, 'agent1')!.status).toBe('replaced')
    expect(w.spawns).toHaveLength(2)
  })

  test('respawns from the note once the agent ends having written it', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Implement task 1.', name: 'impl-1', parentAgentId: 'orch' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    const note = `${RUN_DIR}/handover/impl-1-agent1-1.md`
    w.files.set(note, 'state of things')
    await complete($, 'agent1', `HANDED OVER: note at ${note}`)

    expect(w.spawns).toHaveLength(2)
    const again = w.spawns[1]!
    expect(again.prompt.startsWith('Implement task 1.')).toBe(true)
    expect(again.prompt).toContain(note)
    expect(again).toEqual(expect.objectContaining({ name: 'impl-1', subagentType: 'general-purpose' }))

    const old = row(w, 'agent1')
    const fresh = row(w, 'agent2')
    expect(old).toEqual(expect.objectContaining({ status: 'replaced', replacedBy: 'agent2', notePath: note }))
    expect(fresh).toEqual(expect.objectContaining({ replaces: 'agent1', parentId: 'orch', isOurs: true }))
    expect(fresh!.brief!.prompt).toBe('Implement task 1.')
    // the parent agent is told who replaced whom
    expect(w.sent.some(m => m.to.includes('orch') && m.text.includes('agent2'))).toBe(true)
  })

  test('never hands over a replacement that starts above half the threshold', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1')
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await step($, 'agent2')
    expect((await tool($, 'agent2')).context).toBeUndefined()
    expect(row(w, 'agent2')!.status).toBe('running')
    expect(w.toasts.some(t => t.includes('starts at'))).toBe(true)
    expect(w.toasts.filter(t => t.includes('starts at'))).toHaveLength(1)
  })

  test('does not respawn when autoRespawn is off', { options: { autoRespawn: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    expect((await tool($, 'agent1')).context![0]).toContain('spawn a replacement')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1')
    expect(w.spawns).toHaveLength(1)
    expect(row(w, 'agent1')!.status).toBe('replaced')
  })

  test('marks an agent done, not replaced, when it ended twice without writing the note', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await complete($, 'agent1')
    await complete($, 'agent1')
    expect(w.spawns).toHaveLength(1)
    expect(row(w, 'agent1')!.status).toBe('done')
  })

  test("forwards a replacement's final report to the main thread that spawned the original", async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Orchestrate.', name: 'orchestrator' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/orchestrator-agent1-1.md`, 'x')
    await complete($, 'agent1')
    expect(w.session.appended().some(r => JSON.stringify(r).includes('agent2')), JSON.stringify([w.session.appended(), w.toasts, w.files.get(STATE)])).toBe(true)

    await complete($, 'agent2', 'FINAL REPORT')
    await w.clock.advance(10)
    expect(w.prompts.some(p => p.includes('FINAL REPORT'))).toBe(true)
  })

  test('a teammate replacement: the parent learns the name the engine gave it, and its report is not forwarded twice', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Read files.', name: 'probe' })
    // the original still holds "probe", so the engine suffixes the replacement's name
    w.agents = [
      { id: 'agent1', name: 'probe', teammateId: 'probe@s' },
      { id: 'agent2', name: 'probe-2', teammateId: 'probe-2@s' },
    ]
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/probe-agent1-1.md`, 'x')
    await complete($, 'agent1')
    const told = JSON.stringify(w.session.appended())
    expect(told).toContain('probe-2')
    expect(told).not.toContain('same name')
    expect(row(w, 'agent2')!.name).toBe('probe-2')

    // the engine already delivers a teammate's final reply to its parent
    await complete($, 'agent2', 'FINAL REPORT')
    await w.clock.advance(10)
    expect(w.prompts.some(p => p.includes('FINAL REPORT'))).toBe(false)
  })

  test('keeps the run folder in the project, excluded from git', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/.git/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n')
    await start($)
    expect(w.files.get('/repo/.git/info/exclude')).toContain('\n.orchestrator/\n')
    await start($)
    expect(w.files.get('/repo/.git/info/exclude')!.match(/\.orchestrator\//g)).toHaveLength(1)
  })

  test('puts the run folder under runRoot when given', { options: { runRoot: '/notes' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    expect(w.files.has('/notes/S1/roster.md')).toBe(true)
  })

  test('the status line counts one agent in the singular', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    await step($, 'agent1')
    expect(w.status).toMatch(/^1 agent,/)
    await spawn($, { prompt: 'P', name: 'impl-2' })
    await step($, 'agent2')
    expect(w.status).toMatch(/^2 agents,/)
  })

  test('writes the roster file as agents change', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    expect(w.files.get(`${RUN_DIR}/roster.md`)).toContain('impl-1')
  })
})

describe('main thread', () => {
  const AUTO = { options: { mainHandover: 'auto', mainThreshold: 100_000 } }

  test('writes a note, clears and resumes from it when past the threshold', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens.set('main', 150_000)
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(1)
    const note = `${RUN_DIR}/handover/main-1.md`
    expect(w.prompts[0]).toContain(note)
    expect(phase(w)).toBe('writing')

    w.files.set(note, 'THE MAIN NOTE')
    await complete($, undefined, note)
    await w.clock.advance(10)
    expect(w.commands).toContain('clear')
    expect(w.prompts).toHaveLength(2)
    expect(w.prompts[1]).toContain('THE MAIN NOTE')
    expect(phase(w)).toBe('cooldown')

    // still past the threshold before the fresh context reports: no second round
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(2)

    // once it reads below the threshold it is armed again
    w.tokens.set('main', 20_000)
    await step($)
    expect(phase(w)).toBe('idle')
  })

  test('a main step below the threshold leaves a clearing phase the restart never finished', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens.set('main', 150_000)
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    w.files.set(`${RUN_DIR}/handover/main-1.md`, 'THE MAIN NOTE')
    let seen: string[] = []
    w.duringClear = async () => {
      seen.push(phase(w))
      w.tokens.set('main', 20_000)
      await step($) // the person types into the fresh context
      seen.push(phase(w))
    }
    await complete($, undefined)
    await w.clock.advance(10)
    expect(seen).toEqual(['clearing', 'idle'])
  })

  test('does not clear when the note was not written', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens.set('main', 150_000)
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    await complete($, undefined, 'I could not')
    await w.clock.advance(10)
    expect(w.commands).not.toContain('clear')
    expect(phase(w)).toBe('idle')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`in ask mode offers a button above the prompt instead of acting (${surface})`, { options: { mainThreshold: 100_000 } }, async ($, on) => {
      const w = world(on)
      await start($)
      w.tokens.set('main', 150_000)
      await step($)
      await complete($, undefined)
      await w.clock.advance(10)
      expect(w.prompts).toHaveLength(0)
      expect(phase(w)).toBe('offered')

      const ui = await $.ui.mount({ plugin: 'orchestrator', surface, component: 'AbovePrompt', props: {} as never })
      await ui.press({ key: 'handover' })
      await w.clock.advance(10)
      expect(w.prompts).toHaveLength(1)
      expect(w.prompts[0]).toContain('main-1.md')
    })
  }

  test('off mode never offers', { options: { mainHandover: 'off', mainThreshold: 100_000 } }, async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens.set('main', 150_000)
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(phase(w)).toBe('idle')
  })
})

describe('pane', () => {
  test('/orch opens the pane and the pane charts each agent', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'orch', args: '' } as never)
    expect(w.opened).toContain('orchestrator')
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 300_000)
    await step($, 'agent1')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'orchestrator',
        surface,
        component: 'Pane',
        requestId: 'orchestrator',
        props: { bodyColumns: 100 } as never,
      })
      expect(await ui.find({ text: /impl-1/ })).toBeDefined()
      expect(await ui.find({ text: /300k/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('terminal: a truncated activity line expands in flow beneath it on a press; no card covers other lines', async ($, on) => {
    world(on)
    await start($)
    const name = 'a-rather-long-agent-name-that-will-not-fit-in-a-narrow-pane'
    // Eight agent rows on 25 rows: base = 25 - 8 - 8 - 1 = 8 rows, as many as the eight spawn lines.
    // The names differ in length: lines logged at one time are told apart by their length.
    for (let i = 1; i <= 8; i++) await spawn($, { prompt: 'P', name: `${name}-${'x'.repeat(i)}` })
    const ui = await $.ui.mount({
      plugin: 'orchestrator',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'orchestrator',
      props: { bodyColumns: 40 } as never,
      viewport: { columns: 40, rows: 25 },
    })
    const agents = (await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('agent:')).length
    expect(agents).toBe(8)
    const base = terminalBase({ rows: 25, agents, peekRows: 0, buttonRow: true })
    const line = (await ui.findAll({ type: 'Button' })).filter(b => b.text.includes('spawned')).at(-1)!
    expect(line).toBeDefined()
    expect(line.text).toContain('…')
    expect(line.text).not.toContain(name)

    type Drawn = { type: string; key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Drawn[] =>
      n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
    const isActivity = (c: unknown) =>
      (c as Drawn)?.type === 'Text' && ((c as Drawn).children ?? []).some(t => t === 'Activity')
    /** The activity lines drawn: the pane's children after the `Activity` header. */
    const activity = async () => {
      const pane = walk(await ui.drawn()).find(b => (b.children ?? []).some(isActivity))!
      const kids = (pane.children ?? []).filter(c => c && typeof c === 'object')
      return kids.slice(kids.findIndex(isActivity) + 1)
    }
    const noCards = async () => {
      const all = walk(await ui.drawn())
      expect(all.some(b => b.props?.position === 'absolute')).toBe(false)
      expect(all.some(b => 'hover' in b || (b.props !== undefined && 'hover' in b.props))).toBe(false)
    }
    await noCards()
    expect(await ui.find({ key: `full:${line.key}` })).toBeUndefined()
    const before = (await activity()).length
    expect(before).toBe(base)

    await ui.press({ key: line.key! })
    await noCards()
    const full = (await ui.find({ key: `full:${line.key}` }))!
    expect(full).toBeDefined()
    // The expansion wraps at its width (read it with the line breaks taken out), capped to the rows the pane has.
    expect(full.text.replace(/\s+/g, '')).toContain('spawneda-rather-long-agent-name-that-will')
    const keyOf = (c: unknown) => (c as Drawn)?.props?.key ?? (c as Drawn)?.key
    const column = walk(await ui.drawn()).find(b => (b.children ?? []).some(c => keyOf(c) === line.key))!
    expect(column.props?.flexDirection).toBe('column')
    const at = column.children!.findIndex(c => keyOf(c) === line.key)
    expect(keyOf(column.children![at + 1])).toBe(`full:${line.key}`)
    const fullNode = column.children![at + 1] as Drawn
    const fullLines = (fullNode.children ?? []).filter(c => (c as Drawn)?.type === 'Text').length
    expect(fullLines).toBe(expandCap(base))
    expect((await activity()).length).toBe(Math.max(3, before - (fullLines + 2)))
    expect((await activity()).length).toBeLessThan(before)

    await ui.press({ key: line.key! })
    expect(await ui.find({ key: `full:${line.key}` })).toBeUndefined()
    expect((await activity()).length).toBe(before)
    await ui.unmount()
  })

  test('/orch close closes the pane', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'orch', args: '' } as never)
    await $.command.run({ command: 'orch', args: 'close' } as never)
    expect(w.closed).toEqual(['orchestrator'])
  })

  test('/orch handover <name> hands that agent over now', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    await step($, 'agent1')
    await $.command.run({ command: 'orch', args: 'handover impl-1' } as never)
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    expect(w.sent).toHaveLength(0)
    expect((await tool($, 'agent1')).context![0]).toContain('HANDOVER')
  })

  test('/orch handover of an idle agent sends HANDOVER, which wakes it', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    await step($, 'agent1')
    await complete($, 'agent1')
    await $.command.run({ command: 'orch', args: 'handover impl-1' } as never)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('HANDOVER')
    expect(row(w, 'agent1')!.status).toBe('handing-over')
  })
})

describe('main handover control', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`in ask mode below the threshold the pane offers Hand over main (${surface})`, async ($, on) => {
      const w = world(on)
      await running($, w)
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Hand over main')
      await ui.press({ key: 'handover:main' })
      await w.clock.advance(10)
      expect(w.prompts[0]).toContain('main-1.md')
      await ui.unmount()
    })

    test(`auto mode shows no Hand over main (${surface})`, { options: { mainHandover: 'auto' } }, async ($, on) => {
      const w = world(on)
      await running($, w)
      const ui = await mountPane($, surface)
      expect(await ui.findAll({ key: 'handover:main' })).toHaveLength(0)
      await ui.unmount()
    })

    test(`off mode shows no Hand over main (${surface})`, { options: { mainHandover: 'off' } }, async ($, on) => {
      const w = world(on)
      await running($, w)
      const ui = await mountPane($, surface)
      expect(await ui.findAll({ key: 'handover:main' })).toHaveLength(0)
      await ui.unmount()
    })

    test(`Hand over main is hidden while main hands over (${surface})`, async ($, on) => {
      const w = world(on)
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'handover:main' })
      expect(await ui.find({ key: 'handover:main' })).toBeUndefined()
      await w.clock.advance(10)
      await ui.unmount()
    })

    test(`Hand over main pressed mid-turn says queued and starts once (${surface})`, async ($, on) => {
      const w = world(on)
      on('turn.start', ($, e) => ({ turnId: e.turnId }))
      await running($, w)
      await $.turn.start({ text: 'go', turnId: 'T' })
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Hand over main')
      await ui.press({ key: 'handover:main' })
      expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Handover queued')
      await ui.press({ key: 'handover:main' })
      await w.clock.advance(10)
      expect(w.prompts).toHaveLength(0)
      await complete($, undefined)
      await w.clock.advance(10)
      expect(w.prompts.filter(p => p.includes('main-1.md'))).toHaveLength(1)
      await ui.unmount()
    })

    test(`the band stays threshold-only (${surface})`, async ($, on) => {
      const w = world(on)
      // The host's own above-prompt row, which the plugin passes through to when it has nothing to offer.
      on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
      await running($, w)
      const band = await $.ui.mount({ plugin: 'orchestrator', surface, component: 'AbovePrompt', props: {} as never })
      expect(await band.find({ key: 'handover' })).toBeUndefined()
      await band.unmount()
    })
  }
})

describe('desktop pane', () => {
  test('the desktop draws an interactive chart; the terminal draws none', async ($, on) => {
    const w = world(on)
    await running($, w)
    const desk = await mountPane($, 'desktop')
    const svg = await desk.find({ type: 'Svg' })
    expect(svg).toBeDefined()
    expect(String(svg!.props.alt)).toContain('impl-1')
    expect(String(svg!.props.alt)).toContain('300k')
    expect(svg!.props.isInteractive).toBe(true)
    await desk.unmount()
    const term = await mountPane($, 'terminal')
    expect(await term.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(await term.findAll({ key: 'handover:agent1' })).toHaveLength(0)
    await term.unmount()
  })

  test('pressing an agent selects its line; pressing again clears it', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    expect(String((await ui.find({ type: 'Svg' }))!.props.source)).toContain('stroke-width="3"')
    await ui.press({ key: 'agent:agent1' })
    expect(String((await ui.find({ type: 'Svg' }))!.props.source)).not.toContain('stroke-width="3"')
    await ui.unmount()
  })

  // The kit cannot plant a stale selection (plugin state never crosses its hooks), so the guard is checked directly.
  test('a selection naming an agent no longer listed selects nothing', async () => {
    const rows = [{ id: 'agent1' }, { id: 'main' }] as AgentRow[]
    expect(liveSelection(rows, 'ghost')).toBe('')
    expect(liveSelection(rows, '')).toBe('')
    expect(liveSelection(rows, 'agent1')).toBe('agent1')
  })

  test('Hand over main is hidden while the main handover is under way', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:main' })
    expect(await ui.find({ key: 'handover:main' })).toBeUndefined()
    await w.clock.advance(10)
    await ui.unmount()
  })

  test('Hand over main pressed mid-turn waits for that turn to end', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await running($, w)
    await $.turn.start({ text: 'go', turnId: 'T' })
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:main' })
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(0)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.toasts.some(t => t.includes('did not write'))).toBe(false)
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('main-1.md')
    expect(phase(w)).toBe('writing')
    await ui.unmount()
  })

  test('a queued main handover shows on the desktop button, which then does nothing', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await running($, w)
    await $.turn.start({ text: 'go', turnId: 'T' })
    const ui = await mountPane($, 'desktop')
    expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Hand over main')
    await ui.press({ key: 'handover:main' })
    expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Handover queued')
    await ui.press({ key: 'handover:main' })
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(0)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(1)
    expect(row(w, 'main')!.handovers).toBe(1)
    await ui.unmount()
  })

  test('the terminal band queues a handover pressed mid-turn and says so', { options: { mainThreshold: 100_000 } }, async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await start($)
    await $.turn.start({ text: 'go', turnId: 'T' })
    w.tokens.set('main', 150_000)
    await step($)
    expect(phase(w)).toBe('offered')
    const band = await $.ui.mount({ plugin: 'orchestrator', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
    expect((await band.find({ key: 'handover' }))!.props.label).toBe('Hand over & restart')
    await band.press({ key: 'handover' })
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(0)
    expect((await band.find({ key: 'handover' }))!.props.label).toBe('Handover queued')
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.toasts.some(t => t.includes('did not write'))).toBe(false)
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('main-1.md')
    await band.unmount()
  })

  test('a main turn end that fails beneath still leaves main free to hand over', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await running($, w)
    await $.turn.start({ text: 'go', turnId: 'T' })
    w.failMainEnd = true
    await complete($, undefined).catch(() => undefined)
    expect(w.failMainEnd).toBe(false)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:main' })
    expect(w.prompts).toHaveLength(1)
    await ui.unmount()
  })

  test('a queued main handover still starts, and stops saying queued, when the turn end fails beneath', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await running($, w)
    await $.turn.start({ text: 'go', turnId: 'T' })
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:main' })
    expect((await ui.find({ key: 'handover:main' }))!.props.label).toBe('Handover queued')
    w.failMainEnd = true
    await complete($, undefined).catch(() => undefined)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('main-1.md')
    expect((await ui.find({ key: 'handover:main' }))?.props.label).not.toBe('Handover queued')
    await ui.unmount()
  })

  test('two quick presses of Hand over main start one handover', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await Promise.all([ui.press({ key: 'handover:main' }), ui.press({ key: 'handover:main' })])
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(1)
    expect(row(w, 'main')!.handovers).toBe(1)
    await ui.unmount()
  })

  test('a live agent has a Hand over button that hands it over; a done one has none', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ key: 'handover:agent1' })).toBeDefined()
    await ui.press({ key: 'handover:agent1' })
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    await complete($, 'agent1')
    await complete($, 'agent1')
    expect(row(w, 'agent1')!.status).toBe('done')
    expect(await ui.find({ key: 'handover:agent1' })).toBeUndefined()
    await ui.unmount()
  })

  test('Hand over main starts the main handover', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:main' })
    await w.clock.advance(10)
    expect(w.prompts[0]).toContain('main-1.md')
    await ui.unmount()
  })

  test('a long activity line expands in flow when pressed', async ($, on) => {
    world(on)
    await start($)
    const name = 'a-rather-long-agent-name-that-will-not-fit-in-a-narrow-pane'
    await spawn($, { prompt: 'P', name })
    const ui = await mountPane($, 'desktop', 40)
    const line = (await ui.findAll({ type: 'Button' })).find(b => b.text.includes('spawned'))!
    expect(line).toBeDefined()
    expect(line.text).toContain('…')
    expect(await ui.find({ key: `full:${line.key}` })).toBeUndefined()
    await ui.press({ key: line.key! })
    expect((await ui.find({ key: `full:${line.key}` }))!.text).toContain(name)
    await ui.press({ key: line.key! })
    expect(await ui.find({ key: `full:${line.key}` })).toBeUndefined()

    type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Drawn[] =>
      n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
    expect(walk(await ui.drawn()).some(b => b.type === 'Box' && b.props?.position === 'absolute')).toBe(false)
    await ui.unmount()
  })

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`the pane draws on ${surface} with a chart`, async ($, on) => {
      const w = world(on)
      await running($, w)
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('agent in view', () => {
  /** The pane as the host draws it with `view` set beside it: the agent opened from the tasks list, or main. */
  const mountViewed = ($: Engine, surface: 'terminal' | 'desktop', view?: { agentId?: string }) =>
    $.ui.mount({ plugin: 'orchestrator', surface, component: 'Pane', requestId: 'orchestrator', props: { bodyColumns: 100, view } as never })
  const source = async (ui: Awaited<ReturnType<typeof mountViewed>>) => String((await ui.find({ type: 'Svg' }))!.props.source)
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  /** Each terminal row's name Text (a Text keeps no key, so it is found after the glyph Text that opens the row's Box). */
  const names = async (ui: Awaited<ReturnType<typeof mountViewed>>) =>
    new Map(
      walk(await ui.drawn())
        .filter(b => b.type === 'Box' && typeof b.props?.key === 'string' && /^(main|agent\d+)$/.test(b.props.key as string))
        .map(b => {
          // A subagent's glyph and name sit inside its pressable Button; main's are bare Texts.
          // The row's indent and fold cell come before it.
          const button = (b.children as Drawn[]).find(c => c.type === 'Button' && String(c.props?.key).startsWith('agent:'))
          const cell = button ? (button.children![1] as Drawn) : (b.children![1] as Drawn)
          return [b.props!.key as string, cell.props ?? {}]
        }),
    )

  test('desktop: the agent in view is marked and its line highlighted', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountViewed($, 'desktop', { agentId: 'agent1' })
    expect(await source(ui)).toContain('stroke-width="3"')
    expect(await ui.find({ text: /in view/ })).toBeDefined()
    expect((await ui.find({ key: 'agent:agent1' }))!.text).toContain('in view')
    await ui.unmount()
  })

  test('desktop: a click selection wins the highlight; the in-view mark stays put', async ($, on) => {
    const w = world(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2' })
    await step($, 'agent2')
    const ui = await mountViewed($, 'desktop', { agentId: 'agent1' })
    await ui.press({ key: 'agent:agent2' })
    const src = await source(ui)
    expect(src.match(/stroke-width="3"/g)).toHaveLength(1)
    expect(src).toContain('stroke="#E69F00" stroke-width="3"')
    expect(src).toContain('stroke="#0072B2" stroke-width="1.5" opacity="0.3"')
    expect((await ui.find({ key: 'agent:agent1' }))!.text).toContain('in view')
    expect((await ui.find({ key: 'agent:agent2' }))!.text).not.toContain('in view')
    await ui.unmount()
  })

  test('desktop: with no click, the agent in view has its label bold', async ($, on) => {
    const w = world(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2' })
    await step($, 'agent2')
    const ui = await mountViewed($, 'desktop', { agentId: 'agent1' })
    const labelOf = async (id: string) => {
      const button = walk(await ui.drawn()).find(b => b.type === 'Button' && b.props?.key === `agent:${id}`)!
      return (button.children!.filter(c => (c as Drawn).type === 'Text')[1] as Drawn).props ?? {}
    }
    expect((await labelOf('agent1')).bold).toBe(true)
    expect((await labelOf('agent2')).bold).toBeFalsy()
    await ui.unmount()
  })

  test('terminal: the agent in view has its name inverted; main does not', async ($, on) => {
    const w = world(on)
    await running($, w)
    await step($)
    const ui = await mountViewed($, 'terminal', { agentId: 'agent1' })
    const cells = await names(ui)
    expect(cells.get('agent1')!.inverse).toBe(true)
    expect(cells.get('main')!.inverse).toBeFalsy()
    await ui.unmount()
  })

  const unmarked: [string, { agentId?: string } | undefined][] = [
    ['no view', undefined],
    ['a view naming an unknown agent', { agentId: 'ghost' }],
    ['the main conversation in view', {}],
  ]
  for (const [what, view] of unmarked) {
    for (const surface of ['terminal', 'desktop'] as const) {
      test(`${what} marks nothing (${surface})`, async ($, on) => {
        const w = world(on)
        await running($, w)
        await step($)
        const ui = await mountViewed($, surface, view)
        expect(await ui.find({ text: /in view/ })).toBeUndefined()
        if (surface === 'desktop') expect(await source(ui)).not.toContain('stroke-width="3"')
        else {
          const cells = [...(await names(ui)).values()]
          expect(cells).toHaveLength(2)
          expect(cells.some(c => c.inverse)).toBe(false)
        }
        await ui.unmount()
      })
    }
  }
})

describe('agent transcript', () => {
  const transcript = [
    { role: 'user', text: 'Implement task 1', toolUses: [] },
    {
      role: 'assistant',
      text: 'Reading the plan',
      toolUses: [
        { tool_use_id: 'a', tool: 'Read', input: {} },
        { tool_use_id: 'b', tool: 'Bash', input: {} },
        { tool_use_id: 'c', tool: 'Bash', input: {} },
      ],
    },
    { role: 'assistant', text: 'Tests are red, as expected', toolUses: [] },
  ]

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`pressing an agent opens its transcript beneath it; pressing again closes it (${surface})`, async ($, on) => {
      const w = world(on)
      const asked: (string | undefined)[] = []
      on('session.messages', ($, e) => {
        asked.push(e.agentId)
        return { value: transcript as never }
      })
      await running($, w)
      const ui = await mountPane($, surface)
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      const peek = (await ui.find({ key: 'transcript:agent1' }))!
      expect(peek).toBeDefined()
      expect(peek.text).toContain('Tests are red, as expected')
      // One item per message text and per tool call, no summary line.
      expect(peek.text).toContain('Reading the plan')
      expect(peek.text).toContain('⚙ Read')
      expect(peek.text.match(/⚙ Bash/g)).toHaveLength(2)
      expect(peek.text).not.toContain('Bash×2')
      expect(asked).toContain('agent1')
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      await ui.unmount()
    })

    test(`a transcript the session cannot read says so (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: { deny: 'agent1 runs in another process' } }))
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain(DENIED)
      await ui.unmount()
    })

    test(`an empty transcript says there is nothing yet (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain('no messages yet')
      await ui.unmount()
    })

    test(`a read that fails reads as not readable and the pane still draws (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => {
        throw new Error('no such op')
      })
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain(DENIED)
      expect(await ui.find({ text: /impl-1/ })).toBeDefined()
      await ui.unmount()
    })
  }

  // The room arithmetic counts each dim line as one row: in a narrow pane they must truncate, not wrap.
  for (const [what, value] of [
    ['not readable', { deny: 'agent1 runs in another process' }],
    ['empty', []],
  ] as const) {
    test(`terminal: the ${what} line keeps to one row in a narrow pane`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: value as never }))
      await running($, w)
      const ui = await mountPane($, 'terminal', 40)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
      const walk = (n: unknown): Drawn[] =>
        n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
      const box = walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.key === 'transcript:agent1')!
      const lines = walk(box).filter(b => b.type === 'Text')
      expect(lines).toHaveLength(1)
      expect(lines[0]!.props?.wrap).toBe('truncate')
      await ui.unmount()
    })
  }

  test('terminal: main is pressable (to collapse it) but opens no transcript', async ($, on) => {
    const w = world(on)
    let asked = 0
    on('session.messages', () => {
      asked++
      return { value: transcript as never }
    })
    await running($, w)
    await step($)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'agent:agent1' })).toBeDefined()
    await ui.press({ key: 'agent:main' })
    await w.clock.settle()
    expect(await ui.find({ key: 'transcript:main' })).toBeUndefined()
    expect(asked).toBe(0)
    await ui.unmount()
  })

  test('desktop: pressing main highlights it but opens no transcript', async ($, on) => {
    const w = world(on)
    let asked = 0
    on('session.messages', () => {
      asked++
      return { value: transcript as never }
    })
    await running($, w)
    await step($)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:main' })
    expect(await ui.find({ key: 'transcript:main' })).toBeUndefined()
    expect(asked).toBe(0)
    await ui.unmount()
  })

  test('terminal: an open transcript takes its rows from the activity', async ($, on) => {
    const w = world(on)
    // Three items: the brief, then a text and its one tool call.
    const three = [transcript[0], { role: 'assistant', text: 'Reading the plan', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }] }]
    on('session.messages', () => ({ value: three as never }))
    await start($)
    for (let i = 1; i <= 12; i++) await spawn($, { prompt: 'P', name: `impl-${i}` })
    const ui = await mountPane($, 'terminal', 80)
    type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Drawn[] =>
      n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
    const activity = async () =>
      walk(await ui.drawn()).filter(
        b => b.type === 'Text' && b.props?.wrap === 'truncate' && (b.children ?? []).some(c => typeof c === 'string' && c.includes('spawned')),
      ).length
    const ROOM = 30 - 12 - 8 - 1 // the Hand over main button's row, as in 'terminal pane header'
    expect(await activity()).toBe(ROOM)
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle() // the read runs off the render
    expect(await activity()).toBe(ROOM - (3 + 2)) // three transcript items inside a border
    await ui.unmount()
  })
})

describe('transcript read off the render', () => {
  const LINES = [{ role: 'assistant', text: 'Tests are red, as expected', toolUses: [] }]
  /** A `session.messages` answer the test releases by hand; `calls` counts the reads. */
  const held = (on: Parameters<typeof world>[0]) => {
    const h = { calls: 0, release: () => {} }
    on('session.messages', () => {
      h.calls++
      return new Promise(resolve => {
        h.release = () => resolve({ value: LINES as never })
      })
    })
    return h
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a read that never answers blocks neither the pane nor its Hand over buttons (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => new Promise(() => {}))
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      expect(await ui.find({ text: /impl-1/ })).toBeDefined()
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain('loading…')
      if (surface === 'desktop') {
        await ui.press({ key: 'handover:agent1' })
        expect(row(w, 'agent1')!.status).toBe('handing-over')
      }
      await ui.press({ key: 'handover:main' })
      await w.clock.advance(10)
      expect(w.prompts.some(p => p.includes('main-1.md'))).toBe(true)
      await ui.unmount()
    })

    test(`the transcript shows loading… until the read answers, then its lines (${surface})`, async ($, on) => {
      const w = world(on)
      const h = held(on)
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle()
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain('loading…')
      h.release()
      await w.clock.settle()
      const peek = (await ui.find({ key: 'transcript:agent1' }))!.text
      expect(peek).toContain('Tests are red, as expected')
      expect(peek).not.toContain('loading…')
      await ui.unmount()
    })

    test(`a read that outlasts the timeout reads as not readable (${surface})`, async ($, on) => {
      const w = world(on)
      held(on)
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.advance(PEEK_TIMEOUT_MS + 10)
      expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain(DENIED)
      await ui.unmount()
    })
  }

  test('a read still hung after the timeout keeps later triggers from piling up reads', async ($, on) => {
    const w = world(on)
    const h = held(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.advance(PEEK_TIMEOUT_MS + 10)
    expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain(DENIED)
    await step($, 'agent1')
    await w.clock.settle()
    expect(h.calls).toBe(1)
    await ui.unmount()
  })

  test('a very long message is stored cut, not whole', async ($, on) => {
    const w = world(on)
    on('session.messages', () => ({ value: [{ role: 'assistant', text: 'y'.repeat(5000), toolUses: [] }] as never }))
    await running($, w)
    // So wide that the render's own cut does not apply: what shows is what was stored.
    const ui = await mountPane($, 'desktop', 4000)
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    const text = (await ui.find({ key: 'transcript:agent1' }))!.text
    expect(text).toContain('yyy')
    // Kept whole up to STEP_CHARS (2000) so it can be expanded, and cut there.
    expect(text).toContain('…')
    expect(text.match(/y+/)![0].length).toBeLessThan(2000)
    expect(text.match(/y+/)![0].length).toBeGreaterThan(500)
    await ui.unmount()
  })

  test('triggers for an agent whose read is in flight start no second read', async ($, on) => {
    const w = world(on)
    const h = held(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    await step($, 'agent1')
    await tool($, 'agent1')
    await w.clock.settle()
    expect(h.calls).toBe(1)
    h.release()
    await w.clock.settle()
    // Settled: the selected agent's next step reads its transcript afresh.
    await step($, 'agent1')
    await w.clock.settle()
    expect(h.calls).toBe(2)
    await ui.unmount()
  })
})

describe('transcript reads under load', () => {
  const said = (text: string) => ({ value: [{ role: 'assistant', text, toolUses: [] }] as never })
  /** Every read waits until the test answers it, in order. */
  const queued = (on: Parameters<typeof world>[0]) => {
    const q: ((v: unknown) => void)[] = []
    on('session.messages', () => new Promise(resolve => q.push(resolve as (v: unknown) => void)))
    return q
  }

  test('a failing transcript read never costs a handover its HANDOVER or a step its record', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said('first'))
    let trap = false
    on('state.get', ($, e, next) => {
      // A hook that throws is skipped; a deny makes the plugin's read reject.
      if (trap && e.key === 'selectedAgent') return { deny: 'peek path failed' } as never
      return next(e)
    })
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    await ui.unmount()
    await $.command.run({ command: 'orch', args: 'handover impl-1' } as never)
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    const steps = row(w, 'agent1')!.steps
    trap = true
    expect((await tool($, 'agent1')).context?.[0]).toContain('HANDOVER')
    await step($, 'agent1')
    expect(row(w, 'agent1')!.steps).toBe(steps + 1)
  })

  test('a trigger during a read rereads once it settles, so the box shows the newer read', async ($, on) => {
    const w = world(on)
    const q = queued(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    await step($, 'agent1')
    await w.clock.settle()
    expect(q).toHaveLength(1)
    q[0]!(said('first'))
    await w.clock.settle()
    expect(q).toHaveLength(2)
    q[1]!(said('second'))
    await w.clock.settle()
    expect((await ui.find({ key: 'transcript:agent1' }))!.text).toContain('second')
    await ui.unmount()
  })

  test('a later read that times out keeps the lines already shown', async ($, on) => {
    const w = world(on)
    const q = queued(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    q[0]!(said('first'))
    await w.clock.settle()
    await step($, 'agent1')
    await w.clock.advance(PEEK_TIMEOUT_MS + 10)
    const text = (await ui.find({ key: 'transcript:agent1' }))!.text
    expect(text).toContain('first')
    expect(text).not.toContain(DENIED)
    await ui.unmount()
  })

  test('a finished agent whose transcript is then refused keeps its last lines', async ($, on) => {
    const w = world(on)
    let calls = 0
    on('session.messages', () => (calls++ === 0 ? said('last words') : { value: { deny: 'agent1 finished' } }))
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    await complete($, 'agent1')
    await w.clock.advance(30_000)
    await w.clock.settle()
    expect(calls).toBeGreaterThan(1)
    const text = (await ui.find({ key: 'transcript:agent1' }))!.text
    expect(text).toContain('last words')
    expect(text).not.toContain(DENIED)
    await ui.unmount()
  })
})

describe('terminal pane header', () => {
  /** Twelve agents, each logging its spawn: more activity than the terminal pane has room for. */
  const crowded = async ($: Engine) => {
    await start($)
    for (let i = 1; i <= 12; i++) await spawn($, { prompt: 'P', name: `impl-${i}` })
    const ui = await mountPane($, 'terminal', 80)
    type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Drawn[] =>
      n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
    const lines = walk(await ui.drawn()).filter(
      b => b.type === 'Text' && b.props?.wrap === 'truncate' && (b.children ?? []).some(c => typeof c === 'string' && c.includes('spawned')),
    )
    await ui.unmount()
    return lines.length
  }
  // Options are per test, so each world is mounted in its own test against the same room:
  // 30 rows (no viewport given) less 12 agent rows less 8 for the frame.
  const ROOM = 30 - 12 - 8
  test('with mainHandover off, the activity fills the room left', { options: { mainHandover: 'off' } }, async ($, on) => {
    world(on)
    expect(await crowded($)).toBe(ROOM)
  })
  test('the Hand over main button costs the activity one line', async ($, on) => {
    world(on)
    expect(await crowded($)).toBe(ROOM - 1)
  })
})

describe('model and status', () => {
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  const own = (n: Drawn): string => (n.children ?? []).filter(c => typeof c === 'string').join('')
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** The terminal row Box keyed by the agent's id. */
  const termRow = async (ui: Ui, id: string) =>
    walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.key === id)!
  /** The row text: the desktop's `agent:<id>` Button, the terminal's row Box. */
  const rowText = async (ui: Ui, surface: 'terminal' | 'desktop', id: string) =>
    surface === 'desktop' ? (await ui.find({ key: `agent:${id}` }))!.text : textOf(await termRow(ui, id))
  const glyphOf = async (ui: Ui, id: string) => walk(await termRow(ui, id)).find(b => b.type === 'Text' && /[●○✓◐]/.test(own(b)))!
  const wordOf = async (ui: Ui, id: string, word: string) =>
    walk(await termRow(ui, id)).find(b => b.type === 'Text' && own(b).trim() === word)!
  const styleOf = (n: Drawn) => ({ color: n.props?.color, dimColor: n.props?.dimColor, bold: n.props?.bold })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a step's model and effort show on the row and persist (${surface})`, async ($, on) => {
      const w = world(on)
      w.usageModel = 'claude-sonnet-5-5'
      await start($)
      await spawn($, { prompt: 'P', name: 'impl-1' })
      await step($, 'agent1', { model: 'claude-sonnet-5-5', effort: 'medium' })
      const ui = await mountPane($, surface)
      expect(await rowText(ui, surface, 'agent1')).toContain('Sonnet 5.5 med')
      expect(row(w, 'agent1')!.model).toBe('claude-sonnet-5-5')
      expect(row(w, 'agent1')!.effort).toBe('medium')
      await ui.unmount()
    })

    test(`with no effort the row shows the answering model alone (${surface})`, async ($, on) => {
      const w = world(on)
      await start($)
      await spawn($, { prompt: 'P', name: 'impl-1' })
      await step($, 'agent1', { model: 'claude-sonnet-5-5' })
      const ui = await mountPane($, surface)
      const text = await rowText(ui, surface, 'agent1')
      expect(text).toContain('Opus 5.5')
      expect(text).not.toContain('Sonnet')
      expect(text).not.toMatch(/Opus 5\.5 (low|med|high|xhigh|max)/)
      await ui.unmount()
    })

    test(`before any step the spawn's model shows (${surface})`, async ($, on) => {
      world(on)
      await start($)
      await spawn($, { prompt: 'P', name: 'impl-1', model: 'haiku' })
      const ui = await mountPane($, surface)
      expect(await rowText(ui, surface, 'agent1')).toContain('Haiku')
      await ui.unmount()
    })

    test(`an idle agent with a running child draws waiting (${surface})`, async ($, on) => {
      const w = world(on)
      await running($, w)
      await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
      await step($, 'agent2')
      await complete($, 'agent1')
      expect(row(w, 'agent1')!.status).toBe('idle')
      const ui = await mountPane($, surface)
      if (surface === 'desktop') {
        const text = await rowText(ui, surface, 'agent1')
        expect(text).toContain('⏳')
        expect(text).toContain('waiting')
      } else {
        const glyph = await glyphOf(ui, 'agent1')
        expect(own(glyph)).toContain('◐')
        expect(glyph.props?.color).toBe('planMode')
        expect(glyph.props?.dimColor).toBeFalsy()
        expect((await wordOf(ui, 'agent1', 'waiting')).props?.color).toBe('planMode')
      }
      await ui.unmount()
    })

    test(`a waiting agent still gets its HANDOVER as a message (${surface})`, async ($, on) => {
      const w = world(on)
      await running($, w)
      await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
      await step($, 'agent2')
      await complete($, 'agent1')
      const ui = await mountPane($, surface)
      expect(await rowText(ui, surface, 'agent1')).toContain('waiting')
      if (surface === 'desktop') {
        expect(await ui.find({ key: 'handover:agent1' })).toBeDefined()
        await ui.press({ key: 'handover:agent1' })
      } else {
        await $.command.run({ command: 'orch', args: 'handover impl-1' } as never)
      }
      expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('HANDOVER'))).toBe(true)
      expect(row(w, 'agent1')!.handoverVia).toBe('message')
      await ui.unmount()
    })
  }

  test('terminal: the glyph and status word take the status colours', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'terminal')
    expect(styleOf(await glyphOf(ui, 'agent1'))).toEqual({ color: 'success', dimColor: undefined, bold: true })
    expect(own(await glyphOf(ui, 'agent1'))).toContain('●')
    expect(styleOf(await wordOf(ui, 'agent1', 'running'))).toEqual({ color: 'success', dimColor: undefined, bold: true })
    await complete($, 'agent1')
    expect(own(await glyphOf(ui, 'agent1'))).toContain('○')
    expect(styleOf(await glyphOf(ui, 'agent1'))).toEqual({ color: 'warning', dimColor: true, bold: undefined })
    expect(styleOf(await wordOf(ui, 'agent1', 'idle'))).toEqual({ color: 'warning', dimColor: true, bold: undefined })
    await w.clock.advance(30_000)
    expect(row(w, 'agent1')!.status).toBe('done')
    expect(styleOf(await glyphOf(ui, 'agent1'))).toEqual({ color: 'success', dimColor: true, bold: undefined })
    expect(styleOf(await wordOf(ui, 'agent1', 'done'))).toEqual({ color: 'success', dimColor: true, bold: undefined })
    await ui.unmount()
  })

  test('desktop: the status emoji is the agent own runner, then sleep, then done', async ($, on) => {
    const w = world(on)
    await running($, w)
    let ui = await mountPane($, 'desktop')
    const runner = runnerFor('agent1')
    expect(await rowText(ui, 'desktop', 'agent1')).toContain(runner)
    await ui.unmount()
    ui = await mountPane($, 'desktop')
    expect(await rowText(ui, 'desktop', 'agent1')).toContain(runner)
    await complete($, 'agent1')
    expect(await rowText(ui, 'desktop', 'agent1')).toContain('😴')
    await w.clock.advance(30_000)
    expect(await rowText(ui, 'desktop', 'agent1')).toContain('✅')
    await ui.unmount()
  })

  test('terminal: the model cell narrows the timeline by 17 columns', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'terminal', 100)
    const NAME = Math.min(24, Math.max(12, Math.floor(100 * 0.25)))
    const kids = (await termRow(ui, 'agent1')).children as Drawn[]
    const timeline = kids[kids.length - 2]!
    expect(own(timeline)).toHaveLength(Math.max(8, 100 - NAME - 7 - 14 - 17))
    await ui.unmount()
  })
})

describe('timestamped transcript', () => {
  type Drawn = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  const T0 = 1_000_000 // the world clock's start: agent1's startedAt in `running`
  const brief = { role: 'user', text: 'Implement task 1', toolUses: [] }
  const LONG = `Long thoughts: ${'the plan has many parts and each needs care. '.repeat(12)}END`
  /** One Bash call from agent1's loop, as the engine raises it. */
  const bash = ($: Engine, id: string) =>
    $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: id, agentId: 'agent1' } as never)
  const open = async ($: Engine, w: World, surface: 'terminal' | 'desktop', cols = 100) => {
    const ui = await mountPane($, surface, cols)
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    return ui
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a tool call shows the time the mod saw it (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({
        value: [brief, { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }] }] as never,
      }))
      await running($, w)
      await w.clock.advance(7 * 60_000)
      const t = w.clock.now()
      await bash($, 'b')
      await w.clock.advance(5 * 60_000)
      const ui = await open($, w, surface)
      const item = (await ui.find({ key: 'tool:agent1:b' }))!
      expect(item).toBeDefined()
      expect(item.text.startsWith(hhmm(t))).toBe(true)
      expect(item.text).toContain('⚙ Bash npm test')
      await ui.unmount()
    })

    test(`an answer shows the time its step was seen (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [brief, { role: 'assistant', text: 'Tests are red', toolUses: [] }] as never }))
      await running($, w)
      await w.clock.advance(9 * 60_000)
      const t2 = w.clock.now()
      w.answer = 'Tests are red'
      await step($, 'agent1')
      await w.clock.advance(5 * 60_000)
      const ui = await open($, w, surface)
      const text = (await ui.find({ key: 'transcript:agent1' }))!.text
      expect(text).toContain(`${hhmm(t2)} Tests are red`)
      await ui.unmount()
    })

    test(`the brief shows the agent's start; an unseen message shows --:-- (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [brief, { role: 'assistant', text: 'Never stamped', toolUses: [] }] as never }))
      await running($, w)
      await w.clock.advance(9 * 60_000)
      const ui = await open($, w, surface)
      const text = (await ui.find({ key: 'transcript:agent1' }))!.text
      expect(text).toContain(`${hhmm(T0)} » Implement task 1`)
      expect(text).toContain('--:-- Never stamped')
      await ui.unmount()
    })

    test(`a failed call draws ✗ and a call in flight draws (running) (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({
        value: [
          brief,
          {
            role: 'assistant',
            text: '',
            toolUses: [
              { tool_use_id: 'x', tool: 'Bash', input: { command: 'false' }, text: 'exit 1', isError: true },
              { tool_use_id: 'y', tool: 'Bash', input: { command: 'sleep 9' } },
            ],
          },
        ] as never,
      }))
      await running($, w)
      const ui = await open($, w, surface)
      const failed = (await ui.find({ key: 'tool:agent1:x' }))!.text
      expect(failed).toContain('✗')
      expect(failed).not.toContain('(running)')
      const pending = (await ui.find({ key: 'tool:agent1:y' }))!.text
      expect(pending).toContain('(running)')
      expect(pending).not.toContain('✗')
      // The cross is drawn in the error colour.
      const cross = walk(await ui.drawn()).find(b => b.type === 'Text' && (b.children ?? []).some(c => typeof c === 'string' && c.includes('✗')))!
      expect(cross.props?.color).toBe('error')
      await ui.unmount()
    })

    test(`pressing a tool item touches no handover or state it should not (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({
        value: [brief, { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }] }] as never,
      }))
      await running($, w)
      const ui = await open($, w, surface)
      await ui.press({ key: 'tool:agent1:b' })
      await w.clock.settle()
      expect(await ui.find({ key: 'transcript:agent1' })).toBeDefined()
      expect(row(w, 'agent1')!.status).toBe('running')
      await ui.unmount()
    })
  }

  const longStub = (on: Parameters<typeof world>[0]) =>
    on('session.messages', () => ({ value: [brief, { role: 'assistant', text: LONG, toolUses: [] }] as never }))
  const stepButton = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
    (await ui.findAll({ type: 'Button' })).find(b => (b.key ?? '').startsWith('step-agent1-'))!

  /** Rows a drawn node takes: a Text or Button one, a column its children's sum, a row its tallest (a wrapping row two), a border two more. */
  const height = (n: Drawn): number => {
    if (n.type === 'Text' || n.type === 'Button') return 1
    const kids = (n.children ?? []).filter(c => c && typeof c === 'object') as Drawn[]
    const hs = kids.map(height)
    const inner =
      n.props?.flexDirection === 'column'
        ? hs.reduce((a, b) => a + b, 0)
        : n.props?.flexWrap === 'wrap' && kids.length > 1
          ? Math.max(0, ...hs) + 1
          : Math.max(0, ...hs)
    return inner + (n.props?.borderStyle ? 2 : 0)
  }
  const noCards = async (ui: Awaited<ReturnType<typeof mountPane>>) => {
    const all = walk(await ui.drawn())
    expect(all.some(b => b.props?.position === 'absolute')).toBe(false)
    expect(all.some(b => 'hover' in b || (b.props !== undefined && 'hover' in b.props))).toBe(false)
  }

  test('terminal: a long transcript text expands in flow on a press, and no card covers the rows beneath', async ($, on) => {
    const w = world(on)
    longStub(on)
    await running($, w)
    const ui = await open($, w, 'terminal', 80)
    const button = await stepButton(ui)
    expect(button).toBeDefined()
    expect(button.text).toContain('…')
    expect(button.text).not.toContain('END')
    await noCards(ui)
    expect(await ui.find({ key: `full:${button.key}` })).toBeUndefined()
    await ui.press({ key: button.key! })
    const full = (await ui.find({ key: `full:${button.key}` }))!
    expect(full).toBeDefined()
    expect(full.text).toContain('END')
    await noCards(ui)
    await ui.press({ key: button.key! })
    expect(await ui.find({ key: `full:${button.key}` })).toBeUndefined()
    await ui.unmount()
  })

  test('terminal: an expansion never outgrows the pane', async ($, on) => {
    const w = world(on)
    const HUGE = `${'word '.repeat(390)}END`
    on('session.messages', () => ({ value: [brief, { role: 'assistant', text: HUGE, toolUses: [] }] as never }))
    await running($, w)
    const ui = await open($, w, 'terminal', 40)
    const button = await stepButton(ui)
    await ui.press({ key: button.key! })
    const drawn = walk(await ui.drawn())
    const box = drawn.find(b => b.props?.key === 'transcript:agent1')!
    const peekRows = (box.children ?? []).filter(c => c && typeof c === 'object').length + 2
    const full = drawn.find(b => b.props?.key === `full:${button.key}`)!
    expect(full).toBeDefined()
    const lines = (full.children as Drawn[]).filter(c => c.type === 'Text')
    const agents = (await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('agent:')).length
    expect(lines.length).toBeLessThanOrEqual(expandCap(terminalBase({ rows: 30, agents, peekRows, buttonRow: true })))
    expect(JSON.stringify(lines[lines.length - 1]!.children)).toContain('…')
    expect(JSON.stringify(full.children)).not.toContain('END')
    // The frame's budget reserves 5 rows of slack: the pane draws at most the viewport less those.
    expect(height(walk(await ui.drawn())[0]!)).toBeLessThanOrEqual(30 - 5)
    await ui.unmount()
  })

  test('terminal: a pane too small for an expansion shows none, and stays inside the pane', async ($, on) => {
    const w = world(on)
    longStub(on)
    await running($, w)
    // agent1's row, the button row and the transcript box (brief and text: 2 items + border) on 18 rows: base 4.
    const ROWS = 18
    const ui = await $.ui.mount({
      plugin: 'orchestrator',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'orchestrator',
      props: { bodyColumns: 40 } as never,
      viewport: { columns: 40, rows: ROWS },
    })
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    const box = walk(await ui.drawn()).find(b => b.props?.key === 'transcript:agent1')!
    const peekRows = (box.children ?? []).filter(c => c && typeof c === 'object').length + 2
    const agents = (await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('agent:')).length
    expect(terminalBase({ rows: ROWS, agents, peekRows, buttonRow: true })).toBe(4)
    const button = (await ui.findAll({ type: 'Button' })).find(b => (b.key ?? '').startsWith('step-agent1-'))!
    await ui.press({ key: button.key! })
    expect(await ui.find({ key: `full:${button.key}` })).toBeUndefined()
    expect(height(walk(await ui.drawn())[0]!)).toBeLessThanOrEqual(ROWS - 5)
    await ui.unmount()
  })

  test('terminal: with a text expanded, the tool call beneath it still presses to its detail', async ($, on) => {
    const w = world(on)
    on('session.messages', () => ({
      value: [
        brief,
        { role: 'assistant', text: LONG, toolUses: [] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'PASS' }] },
      ] as never,
    }))
    await running($, w)
    const ui = await open($, w, 'terminal', 80)
    const button = await stepButton(ui)
    await ui.press({ key: button.key! })
    expect(await ui.find({ key: `full:${button.key}` })).toBeDefined()
    await ui.press({ key: 'tool:agent1:b' })
    expect(w.opened).toContain('orchestrator-tool')
    expect(await ui.find({ key: `full:${button.key}` })).toBeDefined()
    await ui.unmount()
  })

  test('desktop: a long text is cut, and a press shows its full text in flow', async ($, on) => {
    const w = world(on)
    longStub(on)
    await running($, w)
    const ui = await open($, w, 'desktop', 80)
    const button = await stepButton(ui)
    expect(button.text).toContain('…')
    expect(button.text).not.toContain('END')
    expect(await ui.find({ key: `full:${button.key}` })).toBeUndefined()
    await ui.press({ key: button.key! })
    const full = (await ui.find({ key: `full:${button.key}` }))!
    expect(full.text).toContain('END')
    expect(full.text).toContain('Long thoughts:')
    expect(walk(await ui.drawn()).some(b => b.type === 'Box' && b.props?.position === 'absolute')).toBe(false)
    await ui.press({ key: button.key! })
    expect(await ui.find({ key: `full:${button.key}` })).toBeUndefined()
    await ui.unmount()
  })

  test('the terminal shows the last 6 items, the desktop the last 12', async ($, on) => {
    const w = world(on)
    const many = Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: `item ${i}`, toolUses: [] }))
    on('session.messages', () => ({ value: [brief, ...many] as never }))
    await running($, w)
    for (const [surface, n] of [['terminal', 6], ['desktop', 12]] as const) {
      const ui = await open($, w, surface)
      const text = (await ui.find({ key: 'transcript:agent1' }))!.text
      expect(text).toContain('item 19')
      expect(text).toContain(`item ${20 - n}`)
      expect(text).not.toContain(`item ${19 - n}`)
      await ui.press({ key: 'agent:agent1' })
      await ui.unmount()
    }
  })
})

describe('tool detail', () => {
  const TOOL = 'orchestrator-tool'
  const brief = { role: 'user', text: 'Implement task 1', toolUses: [] }
  const uses = {
    b: { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'PASS 3 tests' },
    e: { tool_use_id: 'e', tool: 'Edit', input: { file_path: '/x.ts', old_string: 'a\nb', new_string: 'a\nc' }, text: 'ok' },
    r: { tool_use_id: 'r', tool: 'Read', input: { file_path: '/x.ts', offset: 10, limit: 2 }, text: '    10→line ten\n    11→line eleven' },
    g: { tool_use_id: 'g', tool: 'Grep', input: { pattern: 'TODO', path: 'src' }, text: 'src/a.ts' },
  }
  const said = (...toolUses: unknown[]) => ({ value: [brief, { role: 'assistant', text: '', toolUses }] as never })
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const mountTool = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'desktop') =>
    $.ui.mount({ plugin: 'orchestrator', surface, component: 'Pane', requestId: TOOL, props: { bodyColumns: 100 } as never })
  /** agent1 running, its transcript open in the main pane. */
  const opened = async ($: Engine, w: World, surface: 'terminal' | 'desktop') => {
    await running($, w)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    return ui
  }
  const codes = async (ui: Ui) => (await ui.findAll({ type: 'Code' })).map(c => c.props as Record<string, unknown>)

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`pressing a tool call opens the dialog without waiting on the read (${surface})`, async ($, on) => {
      const w = world(on)
      let calls = 0
      on('session.messages', () => (calls++ === 0 ? said(uses.b) : new Promise(() => {})))
      const ui = await opened($, w, surface)
      await ui.press({ key: 'tool:agent1:b' })
      expect(w.opened).toContain(TOOL)
      if (surface === 'desktop') {
        await ui.press({ key: 'handover:agent1' })
        expect(row(w, 'agent1')!.status).toBe('handing-over')
      }
      await ui.press({ key: 'handover:main' })
      await w.clock.advance(10)
      expect(w.prompts.some(p => p.includes('main-1.md'))).toBe(true)
      await ui.unmount()
    })

    test(`the dialog draws a Bash call's command and output (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => said(uses.b))
      const ui = await opened($, w, surface)
      await ui.press({ key: 'tool:agent1:b' })
      await w.clock.settle()
      const tool = await mountTool($, surface)
      const cs = await codes(tool)
      expect(cs.find(c => c.language === 'bash')?.source).toBe('npm test')
      expect(cs.some(c => String(c.source).includes('PASS 3 tests'))).toBe(true)
      expect(await tool.find({ key: 'close' })).toBeDefined()
      await tool.unmount()
      await ui.unmount()
    })

    test(`Edit draws a diff, Read a path and start line, Grep its pattern (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => said(uses.e, uses.r, uses.g))
      const ui = await opened($, w, surface)
      await ui.press({ key: 'tool:agent1:e' })
      await w.clock.settle()
      let tool = await mountTool($, surface)
      expect((await codes(tool)).some(c => c.format === 'diff')).toBe(true)
      await tool.unmount()
      await ui.press({ key: 'tool:agent1:r' })
      await w.clock.settle()
      tool = await mountTool($, surface)
      expect((await codes(tool)).find(c => c.path === '/x.ts')?.startLine).toBe(10)
      await tool.unmount()
      await ui.press({ key: 'tool:agent1:g' })
      await w.clock.settle()
      tool = await mountTool($, surface)
      expect(await tool.find({ text: /TODO/ })).toBeDefined()
      await tool.unmount()
      await ui.unmount()
    })
  }

  test('loading… before the read settles; not readable when the call is gone', async ($, on) => {
    const w = world(on)
    let calls = 0
    let release = () => {}
    on('session.messages', () => {
      calls++
      if (calls === 1) return said(uses.b)
      if (calls === 2) return new Promise(resolve => (release = () => resolve(said(uses.g))))
      return said(uses.g)
    })
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    let tool = await mountTool($)
    expect(await tool.find({ text: /loading…/ })).toBeDefined()
    await tool.unmount()
    release()
    await w.clock.settle()
    tool = await mountTool($)
    expect(await tool.find({ text: /tool call not readable/ })).toBeDefined()
    await tool.unmount()
    await ui.unmount()
  })

  test('a call in flight shows running…, then its output once the call settles', async ($, on) => {
    const w = world(on)
    let done = false
    on('session.messages', () => said(done ? uses.b : { ...uses.b, text: undefined }))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    let tool = await mountTool($)
    expect(await tool.find({ text: /running…/ })).toBeDefined()
    await tool.unmount()
    done = true
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b', agentId: 'agent1' } as never)
    await w.clock.settle()
    tool = await mountTool($)
    expect((await codes(tool)).some(c => String(c.source).includes('PASS 3 tests'))).toBe(true)
    await tool.unmount()
    await ui.unmount()
  })

  test('Close closes the dialog and clears it', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    let tool = await mountTool($)
    const close = (await tool.find({ key: 'close' }))!
    expect(close.props.role).toBe('dismiss')
    await tool.press({ key: 'close' })
    expect(w.closed).toContain(TOOL)
    await tool.unmount()
    tool = await mountTool($)
    expect(await tool.find({ text: /No tool call selected\./ })).toBeDefined()
    await tool.unmount()
    await ui.unmount()
  })

  // The test engine has no `ui.close` to raise, so the person's own close cannot be driven from here:
  // the dialog is asked to close on Escape, and closing the Orchestrator pane is checked to leave it alone.
  test('the dialog closes on Escape and holds toasts; closing the Orchestrator pane leaves it open', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    expect(w.openArgs.find(a => a.id === TOOL)).toMatchObject({ focus: true, closeOnEscape: true, holdToasts: true, title: 'impl-1 · Bash' })
    await $.command.run({ command: 'orch', args: 'close' } as never)
    expect(w.closed).toEqual(['orchestrator'])
    const tool = await mountTool($)
    expect((await codes(tool)).length).toBeGreaterThan(0)
    await tool.unmount()
    await ui.unmount()
  })

  test('pressing the same tool call again closes the dialog', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    expect(w.closed).toContain(TOOL)
    const tool = await mountTool($)
    expect(await tool.find({ text: /No tool call selected\./ })).toBeDefined()
    await tool.unmount()
    await ui.unmount()
  })

  for (const how of ['step', 'sync'] as const) {
    test(`an open call in flight is read again on each ${how} until it settles`, async ($, on) => {
      const w = world(on)
      let done = false
      on('session.messages', () => said(done ? uses.b : { ...uses.b, text: undefined }))
      const ui = await opened($, w, 'desktop')
      await ui.press({ key: 'tool:agent1:b' })
      await w.clock.settle()
      done = true
      if (how === 'step') await step($, 'agent1')
      else {
        w.agents = [{ id: 'agent1', name: 'impl-1' }]
        await w.clock.advance(30_000)
      }
      await w.clock.settle()
      const tool = await mountTool($)
      expect((await codes(tool)).some(c => String(c.source).includes('PASS 3 tests'))).toBe(true)
      await tool.unmount()
      await ui.unmount()
    })
  }

  test('terminal: a session that places no dialog gets the detail inline beneath the call', async ($, on) => {
    const w = world(on)
    w.placesTool = false
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'terminal')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    const inline = (await ui.find({ key: 'tooldetail:b' }))!
    expect(inline).toBeDefined()
    expect(inline.text).toContain('npm test')
    await ui.unmount()
  })

  test('desktop: a surface that places no dialog gets the detail inline beneath the call', async ($, on) => {
    const w = world(on)
    w.placesTool = false
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    const inline = (await ui.find({ key: 'tooldetail:b' }))!
    expect(inline).toBeDefined()
    expect(inline.text).toContain('npm test')
    expect((await ui.findAll({ type: 'Code' })).length).toBeGreaterThan(0)
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    expect(await ui.find({ key: 'tooldetail:b' })).toBeUndefined()
    await ui.unmount()
  })

  test('the dialog mounts on vscode and mobile', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said(uses.b))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    for (const surface of ['vscode', 'mobile'] as const) {
      const tool = await mountTool($, surface)
      expect(await tool.find({ key: 'close' })).toBeDefined()
      await tool.unmount()
    }
    await ui.unmount()
  })

  test('a huge output stays within the Code limit', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said({ ...uses.b, text: 'z'.repeat(200_000) }))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    const tool = await mountTool($)
    const total = (await codes(tool)).reduce((n, c) => n + String(c.source).length, 0)
    expect(total).toBeGreaterThan(1000)
    expect(total).toBeLessThanOrEqual(100_000)
    await tool.unmount()
    await ui.unmount()
  })
})

describe('stalled handovers and resumed agents', () => {
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  const own = (n: Drawn): string => (n.children ?? []).filter(c => typeof c === 'string').join('')
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''
  const STALL = 20 * 60_000 + 30_000

  /** impl-1 past the threshold, its HANDOVER carried by a tool result, then left past the stall time. */
  const stalled = async ($: Engine, w: World) => {
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    await w.clock.advance(STALL)
    expect(row(w, 'agent1')!.status).toBe('stalled')
  }

  test('a stalled agent that ends having written its note is replaced and respawned', async ($, on) => {
    const w = world(on)
    await stalled($, w)
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    expect(row(w, 'agent1')!.status).toBe('replaced')
    expect(w.spawns).toHaveLength(2)
  })

  test('a stalled agent that ends without a note is done, and is sent nothing more', async ($, on) => {
    const w = world(on)
    await stalled($, w)
    const sent = w.sent.length
    await complete($, 'agent1', 'gave up')
    expect(row(w, 'agent1')!.status).toBe('done')
    expect(w.sent).toHaveLength(sent)
    expect(w.spawns).toHaveLength(1)
  })

  /** A replacement (agent2, ours, reporting to main) that ran once, ended and was settled done by sync. */
  const finishedReplacement = async ($: Engine, w: World) => {
    await start($)
    await spawn($, { prompt: 'Orchestrate.', name: 'orchestrator' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/orchestrator-agent1-1.md`, 'x')
    await complete($, 'agent1')
    await step($, 'agent2')
    await complete($, 'agent2', 'FIRST REPORT')
    await w.clock.advance(30_000)
    expect(w.prompts.some(p => p.includes('FIRST REPORT'))).toBe(true)
    expect(row(w, 'agent2')!.status).toBe('done')
  }

  test('an agent resumed after it ended runs again, reports again, and ends done', async ($, on) => {
    const w = world(on)
    await finishedReplacement($, w)
    const now = await w.clock.now()
    await step($, 'agent2')
    expect(row(w, 'agent2')).toEqual(expect.objectContaining({ status: 'running', resumedAt: now }))
    // the engine may leave a resumed agent out of its list while it runs: sync must not settle it mid-run
    await w.clock.advance(30_000)
    expect(row(w, 'agent2')!.status).toBe('running')
    await complete($, 'agent2', 'SECOND REPORT')
    expect(row(w, 'agent2')!.status).toBe('idle')
    await w.clock.advance(30_000)
    expect(w.prompts.some(p => p.includes('SECOND REPORT'))).toBe(true)
    expect(row(w, 'agent2')!.status).toBe('done')
  })

  test('a resumed agent silent past the stall time is settled done by sync', async ($, on) => {
    const w = world(on)
    await finishedReplacement($, w)
    await step($, 'agent2')
    await w.clock.advance(STALL)
    expect(row(w, 'agent2')!.status).toBe('done')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a resumed agent shows a dim ↻ after its label (${surface})`, async ($, on) => {
      const w = world(on)
      await running($, w)
      await complete($, 'agent1')
      await w.clock.advance(30_000)
      const ui = await mountPane($, surface, 100)
      const marks = async () => walk(await ui.drawn()).filter(b => b.type === 'Text' && own(b).includes('↻'))
      expect(await marks()).toHaveLength(0)
      await step($, 'agent1')
      const found = await marks()
      expect(found).toHaveLength(1)
      expect(own(found[0]!).trim()).toBe('↻')
      expect(found[0]!.props?.dimColor).toBe(true)
      if (surface === 'desktop') {
        expect((await ui.find({ key: 'agent:agent1' }))!.text).toMatch(/impl-1\s*↻/)
      } else {
        // indent, fold cell, glyph and name, mark included, still fill exactly the NAME columns
        const NAME = Math.min(24, Math.max(12, Math.floor(100 * 0.25)))
        const all = walk(await ui.drawn())
        const button = all.find(b => b.props?.key === 'agent:agent1')!
        const box = all.find(b => b.type === 'Box' && b.props?.key === 'agent1')!
        const cells = (box.children as Drawn[]).slice(0, (box.children as Drawn[]).indexOf(button) + 1)
        expect(cells.map(c => textOf(c) || String(c.props?.label ?? '')).join('')).toHaveLength(NAME)
        expect(textOf(button)).toMatch(/impl-1\s*↻/)
      }
      await ui.unmount()
    })
  }
})

/** A tool call from an agent's loop with the tool's own arguments beside the envelope, as the engine raises it. */
const call = ($: Engine, agentId: string | undefined, tool: string, args: Record<string, unknown>) =>
  $.tool.call({ tool, tool_use_id: `tu-${tool}-${Math.random()}`, ...(agentId && { agentId }), ...args } as never) as Promise<{
    result?: unknown
    deny?: string
  }>

/** agent1 (impl-1) under main, with agent2 (impl-2) its background child; both listed by the engine. */
const family = async ($: Engine, w: World) => {
  await running($, w)
  await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
  await step($, 'agent2')
  w.agents = [{ id: 'agent1', name: 'impl-1' }, { id: 'agent2', name: 'impl-2' }]
}

/** Where the engine writes background commands' output in these tests. */
const TASKS = '/private/tmp/claude-501/-repo/S1/tasks'

/**
 * An agent's (or main's) Bash call sent to the background, as the engine answers it: an empty output file, its id,
 * and the text naming the file; `auto` when the engine moved it there at its timeout.
 */
const bgBash = async (
  $: Engine,
  w: World,
  agentId: string | undefined,
  id: string,
  o: { description?: string; command?: string; auto?: boolean; endsWithFinal?: boolean; isError?: boolean } = {},
) => {
  const path = `${TASKS}/${id}.output`
  w.files.set(path, '')
  const text = o.auto
    ? `Command did not complete within its 3s timeout and was moved to the background with ID: ${id}. Output is being written to: ${path}. You will be notified when it completes.`
    : `Command running in background with ID: ${id}. Output is being written to: ${path}. You will be notified when it completes.`
  const before = w.toolAnswer
  w.toolAnswer = e =>
    e.tool === 'Bash'
      ? {
          result: {
            stdout: '',
            stderr: '',
            interrupted: false,
            backgroundTaskId: id,
            ...(o.auto && { timedOutAfterMs: 3000 }),
            ...(o.endsWithFinal && { backgroundEndsWithFinalResponse: true }),
          },
          text,
          ...(o.isError && { isError: true }),
        }
      : before?.(e)
  try {
    return await call($, agentId, 'Bash', {
      command: o.command ?? 'npm test',
      description: o.description ?? 'run the tests',
      ...(!o.auto && { run_in_background: true }),
    })
  } finally {
    w.toolAnswer = before
  }
}

/** The engine appends a background command's exit marker to its output file. */
const endOutput = (w: World, id: string, code: number | 'killed') => {
  const path = `${TASKS}/${id}.output`
  w.files.set(path, (w.files.get(path) ?? '') + (code === 'killed' ? '\n[killed]\n' : `\n[exited with code ${code}]\n`))
}

describe('check-in', () => {
  const MIN = 60_000
  const CHECKIN = 'mcp__orchestrator__checkin'
  /** Time passes, then a turn ends (main's), which delivers what the timers queued. */
  const later = async ($: Engine, w: World, ms: number) => {
    await w.clock.advance(ms)
    await complete($, undefined)
    await w.clock.settle()
  }
  const checkins = (w: World, to = 'agent1') => w.sent.filter(m => m.to.includes(to) && m.text.includes('check-in'))

  test('session.start registers the checkin tool, not deferred', async ($, on) => {
    const w = world(on)
    await start($)
    const t = w.tools.find(t => t.name === 'checkin')
    expect(t).toBeDefined()
    expect(t!.isDeferred).toBe(false)
    expect(JSON.stringify(t!.inputSchema)).toContain('minutes')
  })

  test('a parent arms a check-in on its child: stored, and fired once after the deadline', async ($, on) => {
    const w = world(on)
    await family($, w)
    const now = w.clock.now()
    const res = await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    expect(String(res.result)).toContain('impl-2')
    expect(row(w, 'agent2')).toEqual(expect.objectContaining({ checkinAt: now + 30 * MIN, checkinMins: 30, checkinBy: 'agent1' }))
    await later($, w, 29 * MIN)
    expect(checkins(w)).toHaveLength(0)
    await later($, w, MIN + 30_000)
    expect(checkins(w)).toHaveLength(1)
    expect(checkins(w)[0]!.text).toContain('impl-2')
    expect(checkins(w)[0]!.text).toContain('30 min')
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    await later($, w, 30_000)
    expect(checkins(w)).toHaveLength(1)
  })

  for (const to of ['agent1', 'impl-1']) {
    test(`the child's SendMessage to its parent (${to}) disarms it and records the report`, async ($, on) => {
      const w = world(on)
      await family($, w)
      await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
      await call($, 'agent2', 'SendMessage', { to, message: 'done: all green' })
      expect(row(w, 'agent2')!.report).toEqual(expect.objectContaining({ text: 'done: all green', ok: true, final: true }))
      await later($, w, 31 * MIN)
      expect(checkins(w)).toHaveLength(0)
    })
  }

  test('a handback alone does not disarm it', async ($, on) => {
    const w = world(on)
    w.toolAnswer = e => (e.tool === 'SubagentHandback' ? { result: { success: true } } : undefined)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await call($, 'agent2', 'SubagentHandback', { message: 'Report' })
    expect(row(w, 'agent2')!.checkinAt).toBeDefined()
    await later($, w, 31 * MIN)
    expect(checkins(w)).toHaveLength(1)
  })

  test("a SendMessage to someone else leaves it armed", async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await call($, 'agent2', 'SendMessage', { to: 'impl-9', message: 'hi' })
    expect(row(w, 'agent2')!.report).toBeUndefined()
    await later($, w, 31 * MIN)
    expect(checkins(w)).toHaveLength(1)
  })

  test("the child's turn ending disarms it", async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await complete($, 'agent2', 'R')
    await later($, w, 31 * MIN)
    expect(checkins(w)).toHaveLength(0)
  })

  test('calling again re-arms; minutes 0 cancels; an unknown agent is refused and changes nothing', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 10 })
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 40 })
    await later($, w, 11 * MIN)
    expect(checkins(w)).toHaveLength(0)
    await later($, w, 30 * MIN)
    expect(checkins(w)).toHaveLength(1)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    const cancel = await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 0 })
    expect(String(cancel.result)).toContain('cancel')
    await later($, w, 6 * MIN)
    expect(checkins(w)).toHaveLength(1)
    const before = w.files.get(STATE)
    const bad = await call($, 'agent1', CHECKIN, { agent: 'nobody', minutes: 5 })
    expect(bad.deny).toBeUndefined()
    expect(String(bad.result)).toMatch(/^checkin: .*nobody/)
    expect(w.files.get(STATE)).toBe(before)
  })

  test("only the child's own parent can arm it", async ($, on) => {
    const w = world(on)
    await family($, w)
    const res = await call($, undefined, CHECKIN, { agent: 'impl-2', minutes: 5 })
    expect(res.deny).toBeUndefined()
    expect(String(res.result)).toMatch(/^checkin: no agent/)
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    const bad = await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 'soon' })
    expect(bad.deny).toBeUndefined()
    expect(String(bad.result)).toMatch(/^checkin: minutes/)
  })

  test('a check-in armed by main is submitted as a prompt, which wakes main, and toasts', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, undefined, CHECKIN, { agent: 'impl-1', minutes: 5 })
    expect(row(w, 'agent1')!.checkinBy).toBe('main')
    await later($, w, 6 * MIN)
    expect(w.sent.filter(m => m.text.includes('check-in'))).toHaveLength(0)
    expect(w.prompts.filter(p => p.includes('check-in') && p.includes('impl-1'))).toHaveLength(1)
    expect(w.toasts.some(t => t.includes('check-in'))).toBe(true)
  })

  test('with autoRespawn off, a child that hands over is not checked in on', { options: { autoRespawn: false } }, async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    expect(row(w, 'agent2')!.status).toBe('replaced')
    expect(w.spawns).toHaveLength(2)
    await later($, w, 31 * 60_000)
    expect(w.sent.filter(m => m.text.includes('check-in'))).toHaveLength(0)
  })

  test('a check-in survives a handover that needed a second end to write its note', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    // It ends before any tool result carried the HANDOVER: the message wakes it to write the note.
    await complete($, 'agent2', 'stopped')
    expect(w.sent.some(m => m.to.includes('agent2') && m.text.includes('HANDOVER'))).toBe(true)
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    expect(row(w, 'agent3')).toEqual(expect.objectContaining({ replaces: 'agent2', checkinBy: 'agent1', checkinMins: 30 }))
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
  })

  test('a replacement inherits its predecessor check-in, and it still fires', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    expect(row(w, 'agent3')).toEqual(expect.objectContaining({ replaces: 'agent2', checkinBy: 'agent1', checkinMins: 30 }))
    w.agents.push({ id: 'agent3', name: 'impl-2' })
    await later($, w, 31 * MIN)
    expect(checkins(w)).toHaveLength(1)
    expect(checkins(w)[0]!.text).toContain('agent3')
  })

  test('a replacement orchestrator can check in on its predecessor children, and the check-in reaches it', async ($, on) => {
    const w = world(on)
    await family($, w)
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    expect(row(w, 'agent3')!.replaces).toBe('agent1')
    w.agents.push({ id: 'agent3', name: 'impl-1' })
    const res = await call($, 'agent3', CHECKIN, { agent: 'impl-2', minutes: 5 })
    expect(String(res.result)).toContain('armed')
    expect(row(w, 'agent2')!.checkinBy).toBe('agent3')
    await later($, w, 6 * MIN)
    expect(checkins(w, 'agent3')).toHaveLength(1)
  })

  test('a check-in armed by an orchestrator that was then replaced goes to its replacement', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    w.agents.push({ id: 'agent3', name: 'impl-1' })
    await later($, w, 31 * MIN)
    expect(checkins(w, 'agent1')).toHaveLength(0)
    expect(checkins(w, 'agent3')).toHaveLength(1)
  })

  test('the check-in tool never touches a handover under way', async ($, on) => {
    const w = world(on)
    await family($, w)
    await $.command.run({ command: 'orch', args: 'handover impl-2' } as never)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 30 })
    expect((await tool($, 'agent2')).context?.[0]).toContain('HANDOVER')
  })
})

describe('auto-forward', () => {
  const end = ($: Engine, agentId: string, answer: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
    $.turn.complete({ answer, durationMs: 5, isAborted: reason === 'aborted', turnId: 'T', agentId, reason })
  const forwards = (w: World, to = 'agent1') => w.sent.filter(m => m.to.includes(to) && m.text.includes('auto-forwarded'))
  /** agent1 (impl-1) under main, with agent2 (impl-2) its child, spawned as asked. */
  const kin = async ($: Engine, w: World, o: { background?: boolean; isTeammate?: boolean } = {}) => {
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1', ...o })
    await step($, 'agent2')
  }

  test("a child's final answer goes to its parent agent", async ($, on) => {
    const w = world(on)
    await kin($, w)
    await end($, 'agent2', 'R: all green')
    expect(forwards(w)).toHaveLength(1)
    expect(forwards(w)[0]!.text).toContain('R: all green')
    expect(forwards(w)[0]!.text).toContain('impl-2')
    expect(forwards(w)[0]!.text).not.toContain('may duplicate')
  })

  test('a delivered SendMessage to the parent as the run last act is not forwarded again', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'Report: done' })
    await end($, 'agent2', 'Sent my report.')
    expect(forwards(w)).toHaveLength(0)
  })

  test('a SendMessage early, then a different final answer, is still forwarded, flagged', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'starting now' })
    await tool($, 'agent2')
    await end($, 'agent2', 'FINAL: tests pass')
    expect(forwards(w)).toHaveLength(1)
    expect(forwards(w)[0]!.text).toContain('FINAL: tests pass')
    expect(forwards(w)[0]!.text).toContain('may duplicate a message it sent you')
  })

  test('an early SendMessage saying the same as the final answer is enough', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'FINAL: tests pass' })
    await tool($, 'agent2')
    await end($, 'agent2', 'FINAL:  tests pass')
    expect(forwards(w)).toHaveLength(0)
  })

  test('a SendMessage that failed does not count as a report', async ($, on) => {
    const w = world(on)
    w.toolAnswer = e => (e.tool === 'SendMessage' ? { result: { success: false }, isError: true } : undefined)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'Report' })
    await end($, 'agent2', 'Report')
    expect(forwards(w)).toHaveLength(1)
  })

  // A handback goes to the main session, not to the parent agent: it is no report to the parent.
  test('a child that hands back, then ends with an answer, is still forwarded to its parent', async ($, on) => {
    const w = world(on)
    w.toolAnswer = e => (e.tool === 'SubagentHandback' ? { result: { success: true } } : undefined)
    await kin($, w)
    await call($, 'agent2', 'SubagentHandback', { message: 'Report' })
    await end($, 'agent2', 'Report')
    expect(forwards(w)).toHaveLength(1)
    expect(forwards(w)[0]!.text).toContain('Report')
    // It may have reached main already: flagged as a possible duplicate.
    expect(forwards(w)[0]!.text).toContain('may duplicate a message it sent you')
  })

  test('each run is judged on its own: a resumed child that does not report is forwarded', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'first report' })
    await end($, 'agent2', 'first report')
    expect(forwards(w)).toHaveLength(0)
    await call($, 'agent1', 'SendMessage', { to: 'impl-2', message: 'one more thing' })
    await step($, 'agent2')
    await end($, 'agent2', 'second answer')
    expect(forwards(w)).toHaveLength(1)
    expect(forwards(w)[0]!.text).toContain('second answer')
  })

  test('nothing is forwarded to main, nor for a teammate or a foreground child', async ($, on) => {
    const w = world(on)
    await running($, w)
    const prompts = w.prompts.length
    await end($, 'agent1', 'R')
    expect(w.sent).toHaveLength(0)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(prompts)
    await spawn($, { prompt: 'T', name: 'mate', parentAgentId: 'agent1', isTeammate: true })
    await end($, 'agent2', 'R')
    await spawn($, { prompt: 'F', name: 'fg', parentAgentId: 'agent1', background: false })
    await end($, 'agent3', 'R')
    expect(forwards(w)).toHaveLength(0)
    expect(row(w, 'agent2')!.isTeammate).toBe(true)
    expect(row(w, 'agent3')!.background).toBe(false)
  })

  test('an empty, aborted or failed end is not forwarded', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await end($, 'agent2', '   ')
    await step($, 'agent2')
    await end($, 'agent2', 'partial', 'aborted')
    await step($, 'agent2')
    await end($, 'agent2', 'partial', 'error')
    expect(forwards(w)).toHaveLength(0)
  })

  test('a child handing over is not forwarded; the handover goes on as before', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await $.command.run({ command: 'orch', args: 'handover impl-2' } as never)
    await end($, 'agent2', 'ended early')
    expect(forwards(w)).toHaveLength(0)
    expect(w.sent.some(m => m.to.includes('agent2') && m.text.includes('HANDOVER'))).toBe(true)
  })

  test('a replacement under a subagent is forwarded exactly once', async ($, on) => {
    const w = world(on)
    await kin($, w)
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await end($, 'agent2', 'HANDED OVER: note at x')
    expect(forwards(w)).toHaveLength(0)
    w.tokens.set('agent3', 1000)
    await step($, 'agent3')
    await end($, 'agent3', 'REPLACEMENT DONE')
    expect(w.sent.filter(m => m.to.includes('agent1') && m.text.includes('REPLACEMENT DONE'))).toHaveLength(1)
  })

  test("a child's final answer goes to its parent's replacement, not the handed-over parent", async ($, on) => {
    const w = world(on)
    await kin($, w)
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await end($, 'agent1', 'HANDED OVER')
    expect(row(w, 'agent3')!.replaces).toBe('agent1')
    await end($, 'agent2', 'R: all green')
    expect(forwards(w, 'agent1')).toHaveLength(0)
    expect(forwards(w, 'agent3')).toHaveLength(1)
  })

  test("a foreground child's replacement has its answer forwarded to the parent agent", async ($, on) => {
    const w = world(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1', background: false })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await end($, 'agent2', 'HANDED OVER')
    expect(row(w, 'agent3')!.replaces).toBe('agent2')
    w.tokens.set('agent3', 1000)
    await step($, 'agent3')
    await end($, 'agent3', 'REAL RESULT')
    expect(w.sent.filter(m => m.to.includes('agent1') && m.text.includes('REAL RESULT'))).toHaveLength(1)
  })

  test('a report followed by a refused call is no longer the last act', async ($, on) => {
    const w = world(on)
    w.toolAnswer = e => (e.tool === 'Bash' ? { deny: 'not allowed' } : undefined)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'early' })
    await call($, 'agent2', 'Bash', { command: 'rm -rf x' })
    expect(row(w, 'agent2')!.report?.final).toBe(false)
    await end($, 'agent2', 'FINAL different')
    expect(forwards(w)).toHaveLength(1)
  })

  test('a report followed by a checkin call is no longer the last act', async ($, on) => {
    const w = world(on)
    await kin($, w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'early' })
    await call($, 'agent2', 'mcp__orchestrator__checkin', { agent: 'nobody', minutes: 5 })
    expect(row(w, 'agent2')!.report?.final).toBe(false)
  })

  for (const fails of ['throw', 'undelivered'] as const) {
    test(`a forward that fails (${fails}) is warned, never thrown`, async ($, on) => {
      const w = world(on)
      await kin($, w)
      w.sendFails = fails
      await end($, 'agent2', 'R')
      // the forward goes out from the turn end's drain, unawaited: its warning lands once it settles
      await w.clock.settle()
      expect(w.toasts.some(t => t.includes('not forwarded'))).toBe(true)
      expect(row(w, 'agent2')!.status).toBe('idle')
    })
  }
})

describe('collapse', () => {
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** agent1 orchestrating under main (which has its own row): agent2 and agent3 done, agent4 running. */
  const crew = async ($: Engine, w: World) => {
    await running($, w)
    await step($)
    for (const n of [2, 3, 4]) {
      await spawn($, { prompt: `P${n}`, name: `impl-${n}`, parentAgentId: 'agent1' })
      await step($, `agent${n}`)
    }
    await complete($, 'agent2', 'R2')
    await complete($, 'agent3', 'R3')
    w.agents = [{ id: 'agent1', name: 'impl-1' }, { id: 'agent4', name: 'impl-4' }]
    await w.clock.advance(30_000)
    expect([2, 3].map(n => row(w, `agent${n}`)!.status)).toEqual(['done', 'done'])
  }
  /** Whether a row is drawn: the desktop's row Button, the terminal's row Box. */
  const drawn = async (ui: Ui, surface: 'terminal' | 'desktop', id: string) =>
    surface === 'desktop'
      ? (await ui.find({ key: `agent:${id}` })) !== undefined
      : walk(await ui.drawn()).some(b => b.type === 'Box' && b.props?.key === id)
  const rowText = async (ui: Ui, surface: 'terminal' | 'desktop', id: string) =>
    surface === 'desktop'
      ? (await ui.find({ key: `agent:${id}` }))!.text
      : textOf(walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.key === id))
  const fold = (ui: Ui, id: string) => ui.press({ key: `fold:${id}` })
  /** A drawn element's own text: its children, else its label. */
  const cellText = (n: Drawn) => textOf(n) || String(n.props?.label ?? '')
  const glyph = async (ui: Ui, id: string) => (await ui.find({ key: `fold:${id}` }))!.text
  const hotkey = async (ui: Ui) => await ui.find({ key: 'fold-hotkey' })
  /** The selection, as the c hotkey sees it: none targets main. */
  const selectedOf = async (ui: Ui) => ((await hotkey(ui))?.props.label === 'collapse main thread' ? '' : 'something')

  test('a fold whose state write fails never rejects, by the glyph or the c hotkey', async ($, on) => {
    const w = world(on)
    let failCollapsed = false
    on('state.set', async ($, e, next) => {
      // a thrown hook is skipped by the kit: a malformed answer is what fails the write
      if (failCollapsed && (e as unknown as { key: string }).key === 'collapsed') return { value: null } as never
      return next(e)
    })
    await crew($, w)
    const ui = await mountPane($, 'desktop')
    failCollapsed = true
    const errors: unknown[] = []
    await fold(ui, 'agent1').catch(err => errors.push(err))
    await ui.press({ key: 'fold-hotkey' }).catch(err => errors.push(err))
    await w.clock.settle()
    expect(errors).toEqual([])
    expect(await glyph(ui, 'agent1')).toBe('▾')
    await ui.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the fold glyph collapses finished descendants, and again expands them (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      expect(await glyph(ui, 'agent1')).toBe('▾')
      await fold(ui, 'agent1')
      await w.clock.settle()
      expect(await glyph(ui, 'agent1')).toBe('▸')
      expect(await drawn(ui, surface, 'agent2')).toBe(false)
      expect(await drawn(ui, surface, 'agent3')).toBe(false)
      expect(await drawn(ui, surface, 'agent4')).toBe(true)
      expect(await rowText(ui, surface, 'agent1')).toContain('+2 done')
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      expect(await selectedOf(ui)).toBe('')
      if (surface === 'desktop') {
        const src = String((await ui.find({ type: 'Svg' }))!.props.source)
        expect(src).not.toContain('stroke="#E69F00"')
        expect(src).not.toContain('stroke="#009E73"')
        expect(src).toContain('stroke="#CC79A7"')
      }
      await fold(ui, 'agent1')
      expect(await glyph(ui, 'agent1')).toBe('▾')
      expect(await drawn(ui, surface, 'agent2')).toBe(true)
      expect(await drawn(ui, surface, 'agent3')).toBe(true)
      expect(await rowText(ui, surface, 'agent1')).not.toContain('+2 done')
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      expect(await selectedOf(ui)).toBe('')
      await ui.unmount()
    })

    test(`a row press only opens and closes the transcript; it never collapses (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      expect(await ui.find({ key: 'transcript:agent1' })).toBeDefined()
      await ui.press({ key: 'agent:agent1' })
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      expect(await drawn(ui, surface, 'agent2')).toBe(true)
      expect(await drawn(ui, surface, 'agent3')).toBe(true)
      await ui.unmount()
    })

    test(`only rows that can fold have a fold glyph; others reserve its cell (${surface})`, async ($, on) => {
      const w = world(on)
      await crew($, w)
      const ui = await mountPane($, surface)
      expect(await ui.find({ key: 'fold:agent1' })).toBeDefined()
      expect(await ui.find({ key: 'fold:main' })).toBeDefined()
      for (const n of [2, 3, 4]) expect(await ui.find({ key: `fold:agent${n}` })).toBeUndefined()
      expect(await ui.find({ key: 'nofold:agent2' })).toBeDefined()
      expect(await ui.find({ key: 'nofold:agent4' })).toBeDefined()
      await fold(ui, 'agent1')
      expect(await ui.find({ key: 'fold:agent1' })).toBeDefined()
      await ui.unmount()
    })

    test(`folding keeps the open transcript (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent4' })
      await fold(ui, 'agent1')
      await w.clock.settle()
      expect(await drawn(ui, surface, 'agent2')).toBe(false)
      expect(await ui.find({ key: 'transcript:agent4' })).toBeDefined()
      await ui.unmount()
    })

    test(`main folds its finished top-level agents and keeps a running one (${surface})`, async ($, on) => {
      const w = world(on)
      await crew($, w)
      await step($)
      await complete($, 'agent4', 'R4')
      await complete($, 'agent1', 'R1')
      await spawn($, { prompt: 'P5', name: 'impl-5' })
      await step($, 'agent5')
      w.agents = [{ id: 'agent5', name: 'impl-5' }]
      await w.clock.advance(30_000)
      const ui = await mountPane($, surface)
      expect(await ui.find({ key: 'agent:main' })).toBeDefined()
      await fold(ui, 'main')
      for (const n of [1, 2, 3, 4]) expect(await drawn(ui, surface, `agent${n}`)).toBe(false)
      expect(await drawn(ui, surface, 'agent5')).toBe(true)
      expect(await rowText(ui, surface, 'main')).toContain('+4 done')
      await ui.unmount()
    })

    test(`a collapsed row counts a child that finishes later (${surface})`, async ($, on) => {
      const w = world(on)
      await crew($, w)
      const ui = await mountPane($, surface)
      await fold(ui, 'agent1')
      await complete($, 'agent4', 'R4')
      w.agents = [{ id: 'agent1', name: 'impl-1' }]
      await w.clock.advance(30_000)
      expect(await rowText(ui, surface, 'agent1')).toContain('+3 done')
      expect(await drawn(ui, surface, 'agent4')).toBe(false)
      await ui.unmount()
    })

    test(`the c hotkey folds the selected row, else main (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      let key = (await hotkey(ui))!
      expect(key.props.hotkey).toBe('c')
      expect(key.props.plain).toBe(true)
      expect(key.props.label).toBe('collapse main thread')
      await ui.press({ key: 'agent:agent1' })
      expect((await hotkey(ui))!.props.label).toBe('collapse impl-1')
      await ui.press({ key: 'fold-hotkey' })
      expect(await drawn(ui, surface, 'agent2')).toBe(false)
      key = (await hotkey(ui))!
      expect(key.props.label).toBe('expand impl-1')
      await ui.press({ key: 'fold-hotkey' })
      expect(await drawn(ui, surface, 'agent2')).toBe(true)
      await ui.press({ key: 'agent:agent4' })
      expect(await hotkey(ui)).toBeUndefined()
      await ui.unmount()
    })
  }

  test('terminal: a narrow, nested, resumed, collapsed row keeps its name visible', async ($, on) => {
    const w = world(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
    await spawn($, { prompt: 'P3', name: 'impl-3', parentAgentId: 'agent2' })
    await spawn($, { prompt: 'P4', name: 'impl-4', parentAgentId: 'agent3' })
    for (const n of [2, 3, 4]) await step($, `agent${n}`)
    await complete($, 'agent4', 'R4')
    await complete($, 'agent3', 'R3')
    w.agents = [{ id: 'agent1', name: 'impl-1' }, { id: 'agent2', name: 'impl-2' }]
    await w.clock.advance(30_000)
    await step($, 'agent3') // resumed: running again, with its ↻
    expect(row(w, 'agent3')!.resumedAt).toBeDefined()
    const ui = await mountPane($, 'terminal', 40)
    await fold(ui, 'agent3')
    expect(await drawn(ui, 'terminal', 'agent4')).toBe(false)
    const all = walk(await ui.drawn())
    const button = all.find(b => b.props?.key === 'agent:agent3')!
    expect(textOf(button)).toContain('impl')
    // indent, fold glyph, its space and the agent Button still fill exactly the NAME columns
    const box = all.find(b => b.type === 'Box' && b.props?.key === 'agent3')!
    const cells = (box.children as Drawn[]).slice(0, (box.children as Drawn[]).indexOf(button) + 1)
    expect(cells.reduce((n, c) => n + cellText(c).length, 0)).toBe(12)
    expect(await glyph(ui, 'agent3')).toBe('▸')
    await ui.unmount()
  })

  test('collapse is display only and persists across a remount', async ($, on) => {
    const w = world(on)
    await crew($, w)
    let ui = await mountPane($, 'desktop')
    const header = (await ui.findAll({ type: 'Text' })).find(t => t.text.includes('live'))!.text
    await fold(ui, 'agent1')
    expect((await ui.findAll({ type: 'Text' })).find(t => t.text.includes('live'))!.text).toBe(header)
    const roster = w.files.get(`${RUN_DIR}/roster.md`) ?? ''
    expect(roster).toContain('agent2')
    expect(snapshot(w).agents.map(a => a.id)).toEqual(expect.arrayContaining(['agent2', 'agent3']))
    await ui.unmount()
    ui = await mountPane($, 'desktop')
    expect(await ui.find({ key: 'agent:agent2' })).toBeUndefined()
    await ui.press({ key: 'handover:agent4' })
    expect(row(w, 'agent4')!.status).toBe('handing-over')
    await ui.unmount()
  })
})

describe('repeated answers', () => {
  test('two identical answers show the times each was seen', async ($, on) => {
    const w = world(on)
    const said = { role: 'assistant', text: 'Still working', toolUses: [] }
    on('session.messages', () => ({ value: [{ role: 'user', text: 'go', toolUses: [] }, said, said] as never }))
    await running($, w)
    w.answer = 'Still working'
    await w.clock.advance(5 * 60_000)
    const t1 = w.clock.now()
    await step($, 'agent1')
    await w.clock.advance(5 * 60_000)
    const t2 = w.clock.now()
    await step($, 'agent1')
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    const text = (await ui.find({ key: 'transcript:agent1' }))!.text
    expect(text).toContain(`${hhmm(t1)} Still working`)
    expect(text).toContain(`${hhmm(t2)} Still working`)
    await ui.unmount()
  })
})

describe('delivery from timers', () => {
  const MIN = 60_000
  const CHECKIN = 'mcp__orchestrator__checkin'
  const checkins = (w: World) => w.sent.filter(m => m.to.includes('agent1') && m.text.includes('check-in'))
  const nudges = (w: World) => w.prompts.filter(p => p.startsWith('[orchestrator mod]') && p.includes('queued'))

  test('a check-in fired by sync is queued, not sent, until a turn ends', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(6 * MIN)
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    expect(checkins(w)).toHaveLength(0)
    // a step or a tool call does not deliver: a run woken from inside one would lose that hook
    await tool($, 'agent2')
    await step($, 'agent2')
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(0)
    await complete($, 'agent2', 'R')
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
  })

  test('with no hook to deliver it, the next sync submits one marked prompt to main, and only once', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    // the sync at exactly 5 min fires it: queued, nothing submitted yet
    await w.clock.advance(5 * MIN)
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    expect(nudges(w)).toHaveLength(0)
    await w.clock.advance(30_000)
    expect(nudges(w)).toHaveLength(1)
    await w.clock.advance(90_000)
    expect(nudges(w)).toHaveLength(1)
    expect(checkins(w)).toHaveLength(0)
    // main's hooked turn delivers it as it ends
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
    await w.clock.advance(90_000)
    expect(nudges(w)).toHaveLength(1)
  })

  test('hooks running together deliver a queued message once', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(6 * MIN)
    await Promise.all([complete($, undefined), complete($, undefined), step($, 'agent1')])
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
  })

  test('a delivery that fails is warned, not retried forever, and never thrown into the hook', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(6 * MIN)
    w.sendFails = 'throw'
    await complete($, undefined)
    await w.clock.settle()
    expect(w.toasts.some(t => t.includes('check-in') && t.includes('not delivered'))).toBe(true)
    w.sendFails = ''
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(0)
  })
})

describe('delivery from timers: hardening', () => {
  const MIN = 60_000
  const CHECKIN = 'mcp__orchestrator__checkin'
  const checkins = (w: World, to = 'agent1') => w.sent.filter(m => m.to.includes(to) && m.text.includes('check-in'))
  /** Moves the clock with the spy on: any send meanwhile came from a timer callback. */
  const tick = async (w: World, ms: number) => {
    w.inTimer = true
    try {
      await w.clock.advance(ms)
    } finally {
      w.inTimer = false
    }
  }

  test('the pane Hand over press sends from the ui.press hook, not the button closure', async ($, on) => {
    const w = world(on)
    // Beneath the plugin, this answers every press: a button's own closure never runs.
    on('ui.press', ($, e) => ({ element: e.element }) as never)
    await running($, w)
    await complete($, 'agent1')
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('HANDOVER'))).toBe(true)
    await ui.unmount()
  })

  test('no send is ever made from a timer callback', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await tick(w, 6 * MIN)
    await complete($, undefined)
    await tick(w, 30_000)
    await complete($, undefined)
    await tick(w, 2 * MIN)
    expect(checkins(w)).toHaveLength(1)
    expect(w.timerSends).toEqual([])
  })

  test('no nudge while main is mid-turn', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await $.turn.start({ text: 'go', turnId: 'T' })
    await w.clock.advance(7 * MIN)
    expect(w.prompts.filter(p => p.includes('queued messages'))).toHaveLength(0)
  })

  test('a send that never answers does not stop later deliveries', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * MIN)
    w.hangNext = true
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * MIN)
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(2)
  })

  /**
   * Stands in for /clear's wipe of the session's state, which the kit does not do: once `wipe()` is
   * called, every orchestrator key reads as unset until the plugin writes it again.
   */
  const wipeable = (on: Parameters<typeof world>[0]) => {
    let wiped: Set<string> | undefined
    on('state.get', async ($, e, next) => {
      const res = (await next(e)) as { value?: { value: unknown; version: number } }
      const k = (e as unknown as { key: string }).key
      if (!wiped?.has(k) || !res.value) return res as never
      return { value: { value: undefined, version: res.value.version } } as never
    })
    on('state.set', async ($, e, next) => {
      const res = await next(e)
      wiped?.delete((e as unknown as { key: string }).key)
      return res
    })
    return () => {
      wiped = new Set(['agents', 'log', 'mainPhase', 'runId', 'outbox', 'selectedAgent', 'transcripts', 'collapsed', 'toolView', 'pinnedLog', 'mainQueued'])
    }
  }

  test('a queued message survives a /clear: restore brings it back and it is delivered exactly once', async ($, on) => {
    const w = world(on)
    const wipe = wipeable(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * MIN)
    expect(checkins(w)).toHaveLength(0)
    wipe()
    await step($) // restores from state.json
    await complete($, undefined)
    await w.clock.settle()
    expect(row(w, 'agent2')).toBeDefined()
    expect(checkins(w)).toHaveLength(1)
  })

  test('a delivered message is not delivered again by a restore that finds it in an older state.json', async ($, on) => {
    const w = world(on)
    const wipe = wipeable(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * MIN)
    const stale = w.files.get(STATE)!
    expect(stale).toContain('check-in')
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
    // a persist that read the queue before the drain lands last
    w.files.set(STATE, stale)
    wipe()
    await step($)
    await complete($, undefined)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
  })

  test('the outbox is written to state.json, so a restore after /clear keeps it', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * MIN)
    const saved = JSON.parse(w.files.get(STATE)!) as { outbox?: { agentId: string; text: string }[] }
    expect(saved.outbox).toHaveLength(1)
    expect(saved.outbox![0]!.agentId).toBe('agent1')
    await complete($, undefined)
    await w.clock.settle()
    expect((JSON.parse(w.files.get(STATE)!) as { outbox?: unknown[] }).outbox ?? []).toHaveLength(0)
  })

  for (const [what, change, sends] of [
    ['is sent while the row still waits for it', {}, 1],
    ['is not sent once a tool result carried it', { handoverVia: 'tool' }, 0],
    ['is not sent once the agent was replaced', { status: 'replaced' }, 0],
  ] as const) {
    test(`a queued HANDOVER ${what}`, async ($, on) => {
      const w = world(on)
      const wipe = wipeable(on)
      await start($)
      await spawn($, { prompt: 'P', name: 'impl-1' })
      w.tokens.set('agent1', 460_000)
      await step($, 'agent1')
      const saved = JSON.parse(w.files.get(STATE)!) as { agents: AgentRow[]; outbox?: unknown[] }
      expect(saved.agents.find(a => a.id === 'agent1')).toEqual(expect.objectContaining({ status: 'handing-over' }))
      saved.agents = saved.agents.map(a => (a.id === 'agent1' ? { ...a, ...change } : a))
      saved.outbox = [{ kind: 'handover', agentId: 'agent1', text: 'HANDOVER queued', what: 'impl-1: HANDOVER not delivered', t: 1, id: 'q-1' }]
      w.files.set(STATE, JSON.stringify(saved))
      wipe()
      await step($) // restores from state.json
      await complete($, undefined)
      await w.clock.settle()
      expect(w.sent.filter(m => m.text === 'HANDOVER queued')).toHaveLength(sends)
      if (sends === 0 && 'handoverVia' in change) {
        // A routine skip: recorded in activity.log, not drawn in the pane's activity.
        const ui = await mountPane($, 'desktop')
        const strip = (n: unknown): string =>
          typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(strip).join('') : ''
        const drawn = (await ui.findAll({ type: 'Text' })).map(strip).join('\n')
        expect(drawn).toContain('impl-1')
        expect(drawn).not.toContain('HANDOVER not sent')
        await ui.unmount()
        expect(w.files.get(`${RUN_DIR}/activity.log`)).toContain('HANDOVER not sent')
      }
    })
  }
})

describe('delivery waits for the engine', () => {
  const CHECKIN = 'mcp__orchestrator__checkin'
  const checkins = (w: World) => w.sent.filter(m => m.to.includes('agent1') && m.text.includes('check-in'))

  for (const hook of ['turn.step', 'tool.call'] as const) {
    test(`${hook} never delivers; the next turn end does`, async ($, on) => {
      const w = world(on)
      await family($, w)
      await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
      await w.clock.advance(5 * 60_000)
      if (hook === 'turn.step') await step($, 'agent2')
      else await tool($, 'agent2')
      await w.clock.settle()
      expect(checkins(w)).toHaveLength(0)
      await complete($, undefined)
      await w.clock.settle()
      expect(checkins(w)).toHaveLength(1)
    })
  }

  test('/orch delivers what is queued', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * 60_000)
    await $.command.run({ command: 'orch', args: 'roster' } as never)
    await w.clock.settle()
    expect(checkins(w)).toHaveLength(1)
  })
})

describe('deliveries from a turn end go through the outbox', () => {
  /** The outboxes state.json held over time, flattened. */
  const queued = (w: World) =>
    w.writes.flatMap(t => ((JSON.parse(t) as { outbox?: Record<string, unknown>[] }).outbox ?? []) as Record<string, unknown>[])

  test("a child's final answer is queued, then delivered once by the same turn end", async ($, on) => {
    const w = world(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
    await step($, 'agent2')
    await complete($, 'agent2', 'R: green')
    await w.clock.settle()
    expect(queued(w).some(d => String(d.text).includes('R: green'))).toBe(true)
    expect(w.sent.filter(m => m.text.includes('R: green'))).toHaveLength(1)
  })

  test('a respawn is queued, then spawned once by the same turn end', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    await w.clock.settle()
    expect(queued(w).some(d => d.kind === 'respawn' && d.agentId === 'agent1')).toBe(true)
    expect(w.spawns).toHaveLength(2)
    expect(row(w, 'agent2')!.replaces).toBe('agent1')
  })

  test('a respawn from the drain carries the check-in over and tells the parent', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', 'mcp__orchestrator__checkin', { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    await w.clock.settle()
    expect(queued(w).some(d => d.kind === 'respawn' && d.agentId === 'agent2')).toBe(true)
    expect(row(w, 'agent3')).toEqual(expect.objectContaining({ replaces: 'agent2', checkinBy: 'agent1', checkinMins: 30 }))
    expect(row(w, 'agent3')!.checkinAt).toBeDefined()
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('agent3') && m.text.includes('handed over'))).toBe(true)
  })

  test('a respawn that never answers does not hold the turn end past the timeout', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    w.hangSpawn = true
    let done = false
    const end = complete($, 'agent1', 'HANDED OVER').then(() => {
      done = true
    })
    await w.clock.advance(9_000)
    expect(done).toBe(false)
    await w.clock.advance(2_000)
    await end
    expect(done).toBe(true)
    expect(w.spawns).toHaveLength(2)
    expect(w.toasts.some(t => t.includes('outbox') && t.includes('still running'))).toBe(true)
  })

  test('a HANDOVER sent after the run ended is queued, and its stall clock starts at delivery', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1') // handing over; it ends before any tool result carries it
    await w.clock.advance(10 * 60_000)
    const ended = w.clock.now()
    await complete($, 'agent1', 'stopped')
    await w.clock.settle()
    const write = w.writes.find(t => ((JSON.parse(t) as { outbox?: { kind?: string }[] }).outbox ?? []).some(d => d.kind === 'handover'))
    expect(write).toBeDefined()
    // while queued, no stall clock runs
    expect((JSON.parse(write!) as { agents: AgentRow[] }).agents.find(a => a.id === 'agent1')!.handoverAt).toBeUndefined()
    expect(w.sent.filter(m => m.to.includes('agent1') && m.text.includes('HANDOVER'))).toHaveLength(1)
    expect(row(w, 'agent1')).toEqual(expect.objectContaining({ handoverVia: 'message', handoverAt: ended }))
  })
})

describe("auto mode: the mod's own sends", () => {
  /** agent1 (impl-1) idle, so a Hand over sends its HANDOVER as a message. */
  const idle = async ($: Engine, w: World) => {
    await running($, w)
    await complete($, 'agent1')
  }
  const undelivered = (w: World) =>
    w.toasts.some(t => t.includes('could not be delivered')) || (w.files.get(STATE) ?? '').includes('could not be delivered')

  test('Hand over on an idle agent is allowed and delivered (desktop)', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(w.checks).toEqual(['allow'])
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('HANDOVER'))).toBe(true)
    expect(row(w, 'agent1')).toEqual(expect.objectContaining({ status: 'handing-over', handoverVia: 'message' }))
    expect(undelivered(w)).toBe(false)
    await ui.unmount()
  })

  test('the same message checked outside a send is ask', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(w.checks).toEqual(['allow'])
    const after = await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: w.sent.at(-1)!.text } } as never)
    expect(after.decision).toBe('ask')
    await ui.unmount()
  })

  test('a different recipient during the mod\'s send is ask', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2' })
    await step($, 'agent2')
    await complete($, 'agent1')
    const probes: string[] = []
    w.duringSend = async (check, e) => probes.push(await check({ to: 'agent2', message: e.text }))
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(probes).toEqual(['ask'])
    expect(w.checks).toEqual(['allow'])
    await ui.unmount()
  })

  test("the agent's name and a different text", async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    const probes: string[] = []
    w.duringSend = async (check, e) => {
      probes.push(await check({ to: 'impl-1', message: e.text }))
      probes.push(await check({ to: 'agent1', message: `${e.text} ` }))
      probes.push(await check({ to: 'agent1', message: { type: 'shutdown_request' } }))
      probes.push(await check({ to: { agentId: 'agent1' }, message: e.text }))
    }
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(probes).toEqual(['allow', 'ask', 'ask', 'allow'])
    await ui.unmount()
  })

  test('a forwarded report and a queued check-in are allowed too', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
    await step($, 'agent2')
    await complete($, 'agent2', 'R: green')
    await w.clock.settle()
    expect(w.sent.filter(m => m.text.includes('R: green'))).toHaveLength(1)
    expect(w.checks.length).toBeGreaterThan(0)
    expect(w.checks.every(c => c === 'allow')).toBe(true)
  })

  test('a respawn tells the parent through an allowed send', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await family($, w)
    await call($, 'agent1', 'mcp__orchestrator__checkin', { agent: 'impl-2', minutes: 30 })
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    await w.clock.settle()
    expect(w.spawnChecks).toEqual(['allow'])
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('agent3') && m.text.includes('handed over'))).toBe(true)
    expect(w.checks.length).toBeGreaterThan(0)
    expect(w.checks.every(c => c === 'allow')).toBe(true)
  })

  test('a send that throws still clears its mark', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    w.sendFails = 'throw'
    let text = ''
    w.duringSend = async (_check, e) => {
      text = e.text
    }
    await $.command.run({ command: 'orch', args: 'handover impl-1' } as never).catch(() => undefined)
    expect(w.checks).toEqual(['allow'])
    expect(text).toContain('HANDOVER')
    const after = await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: text } } as never)
    expect(after.decision).toBe('ask')
  })

  test('a send that never answers stops being allowed after the drain timeout', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    w.hangNext = true
    let text = ''
    w.duringSend = async (_check, e) => {
      text = e.text
    }
    void $.command.run({ command: 'orch', args: 'handover impl-1' } as never).catch(() => undefined)
    while (!text) await w.clock.advance(1)
    expect(text).toContain('HANDOVER')
    const during = await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: text } } as never)
    expect(during.decision).toBe('allow')
    await w.clock.advance(10_001)
    const after = await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: text } } as never)
    expect(after.decision).toBe('ask')
  })

  test("a HANDOVER to a teammate checked as `<name>@<team>` is allowed (address from the spawn result)", async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await start($)
    w.nextTeammateId = 'impl-1@s'
    await spawn($, { prompt: 'P', name: 'impl-1', isTeammate: true })
    expect(row(w, 'agent1')!.teammateId).toBe('impl-1@s')
    await step($, 'agent1')
    await complete($, 'agent1')
    const probes: string[] = []
    w.duringSend = async (check, e) => {
      if (!e.text.startsWith('HANDOVER')) return
      probes.push(await check({ to: 'impl-1@s', message: e.text }))
      probes.push(await check({ to: 'impl-1@other', message: e.text }))
    }
    await $.command.run({ command: 'orch', args: 'handover impl-1' } as never)
    expect(probes).toEqual(['allow', 'ask'])
  })

  test("a teammate's address from the engine's list is recorded too", async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'impl-1', teammateId: 'impl-1@s' }]
    await spawn($, { prompt: 'P', name: 'impl-1', isTeammate: true })
    await w.clock.settle()
    expect(row(w, 'agent1')!.teammateId).toBe('impl-1@s')
  })

  // The test kit raises every check with origin { plugin: 'engine' }: the plugin's own origin is tested on the predicate.
  test("isOwnOrigin: this plugin's origin only, read defensively", () => {
    expect(isOwnOrigin({ plugin: 'orchestrator', tier: 'append' })).toBe(true)
    expect(isOwnOrigin({ plugin: 'other', tier: 'append' })).toBe(false)
    expect(isOwnOrigin({ plugin: 'engine', tier: 'core' })).toBe(false)
    expect(isOwnOrigin(undefined)).toBe(false)
    expect(isOwnOrigin(null)).toBe(false)
    expect(isOwnOrigin('orchestrator')).toBe(false)
    expect(isOwnOrigin({ plugin: 42 })).toBe(false)
  })

  // The check hook's decision, as a pure function: the kit stamps every hook-level check `engine`, and the
  // plugin module runs in a realm of its own, so its own origin can be tried only here.
  describe('isOwnSend', () => {
    const OWN = { plugin: 'orchestrator', tier: 'append' }
    const ENGINE = { plugin: 'engine', tier: 'core' }
    const rows = [
      { id: 'agent1', name: 'impl-1' },
      { id: 'agent2', name: 'impl-2', teammateId: 'impl-2@s' },
    ] as AgentRow[]
    const inFlight = [{ agentId: 'agent1', text: 'HANDOVER x' }]

    test('own origin with a send to that recipient in flight: allowed, whatever the text', () => {
      expect(isOwnSend({ origin: OWN, to: 'impl-1', message: 'another text', inFlight, rows })).toBe(true)
      expect(isOwnSend({ origin: OWN, to: { agentId: 'agent1' }, message: { type: 'x' }, inFlight, rows })).toBe(true)
    })

    test('own origin with no send in flight: not allowed', () => {
      expect(isOwnSend({ origin: OWN, to: 'impl-1', message: 'HANDOVER x', inFlight: [], rows })).toBe(false)
    })

    test('own origin with a send in flight to another recipient: not allowed', () => {
      expect(isOwnSend({ origin: OWN, to: 'impl-2', message: 'HANDOVER x', inFlight, rows })).toBe(false)
      expect(isOwnSend({ origin: OWN, to: { agentId: 'agent2' }, message: 'HANDOVER x', inFlight, rows })).toBe(false)
    })

    test('another origin needs the exact text to that recipient', () => {
      expect(isOwnSend({ origin: ENGINE, to: 'impl-1', message: 'HANDOVER x', inFlight, rows })).toBe(true)
      expect(isOwnSend({ origin: ENGINE, to: 'impl-1', message: 'another text', inFlight, rows })).toBe(false)
      expect(isOwnSend({ origin: undefined, to: 'impl-2', message: 'HANDOVER x', inFlight, rows })).toBe(false)
    })

    test("a check from an agent's loop (agentId set) trusts no origin: only the exact text", () => {
      // an agent the mod respawned is credited with the mod's origin; the mod's own send runs in no loop
      expect(isOwnSend({ origin: OWN, agentId: 'agent3', to: 'impl-1', message: 'another text', inFlight, rows })).toBe(false)
      expect(isOwnSend({ origin: OWN, agentId: 'agent3', to: 'impl-1', message: 'HANDOVER x', inFlight, rows })).toBe(true)
      expect(isOwnSend({ origin: OWN, agentId: undefined, to: 'impl-1', message: 'another text', inFlight, rows })).toBe(true)
    })

    test('a teammate address names the recipient', () => {
      const toTeammate = [{ agentId: 'agent2', text: 't' }]
      expect(isOwnSend({ origin: ENGINE, to: 'impl-2@s', message: 't', inFlight: toTeammate, rows })).toBe(true)
      expect(isOwnSend({ origin: OWN, to: 'impl-2@s', message: 'other', inFlight: toTeammate, rows })).toBe(true)
    })
  })

  test("a check with no send in flight gets the engine's verdict", async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    expect((await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: 'x' } } as never)).decision).toBe('ask')
  })

  test("a check from another origin with no send in flight gets the engine's verdict", async ($, on) => {
    const w = world(on)
    // the engine's own verdict beneath the plugin, recording the origin it was raised with
    const seen: unknown[] = []
    on('tool.check', ($, e, next) => {
      seen.push(next.origin)
      return { decision: 'ask' }
    })
    await idle($, w)
    const v = await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: 'x' } } as never)
    expect(seen).toEqual([expect.objectContaining({ plugin: 'engine' })])
    expect(v.decision).toBe('ask')
  })

  test('the check hook never throws', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await idle($, w)
    expect((await $.tool.check({ tool: 'SendMessage', input: null } as never)).decision).toBe('ask')
    expect((await $.tool.check({ tool: 'SendMessage', input: { to: 42 } } as never)).decision).toBe('ask')
  })
})

describe("auto mode: the mod's own sends, review fixes", () => {
  test('an unmatched check with an object `to` logs the object, not [object Object]', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await running($, w)
    await complete($, 'agent1')
    const probes: string[] = []
    w.duringSend = async (check, e) => probes.push(await check({ to: { agentId: 'x' }, message: e.text }))
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    expect(probes).toEqual(['ask'])
    const line = w.logs.find(l => l.includes('SendMessage check not matched'))
    expect(line).toBeDefined()
    expect(line).toContain('"x"')
    expect(line).not.toContain('[object Object]')
    await ui.unmount()
  })

  test('the unmatched-check line goes to the debug log with the length, never the message text', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await running($, w)
    await complete($, 'agent1')
    let text = ''
    w.duringSend = async (check, e) => {
      text = e.text
      await check({ to: 'agent2', message: e.text })
    }
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'handover:agent1' })
    await ui.unmount()
    const misses = w.logSinks.filter(l => l.text.includes('SendMessage check not matched'))
    expect(misses).toHaveLength(1)
    expect(misses[0]!.to).toBe('debug')
    expect(misses[0]!.text).toContain('agent2')
    expect(misses[0]!.text).toContain(`${text.length} chars`)
    expect(misses[0]!.text).not.toContain(text.slice(0, 20))
    expect(misses[0]!.text).not.toContain('HANDOVER')
  })

  test('two identical concurrent sends: after one settles, a check during the other is still allow', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await family($, w)
    // two identical check-ins queued for agent1: armed, fired, re-armed, fired again with nothing changed
    await call($, 'agent1', 'mcp__orchestrator__checkin', { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * 60_000)
    await call($, 'agent1', 'mcp__orchestrator__checkin', { agent: 'impl-2', minutes: 5 })
    await w.clock.advance(5 * 60_000)
    let release!: () => void
    const gate = new Promise<void>(r => {
      release = r
    })
    let calls = 0
    let firstSettled!: Promise<unknown>
    const late: string[] = []
    w.duringSend = async (check, e) => {
      calls += 1
      if (calls !== 1) return
      // the first send waits until the second has settled, then checks again
      await gate
      await firstSettled
      late.push(await check({ to: 'agent1', message: e.text }))
    }
    const drained = $.command.run({ command: 'orch', args: 'roster' } as never)
    firstSettled = (async () => {
      while (calls < 2) await w.clock.advance(1)
      await w.clock.settle()
    })()
    await firstSettled
    release()
    await drained
    await w.clock.settle()
    const checkins = w.sent.filter(m => m.to.includes('agent1') && m.text.includes('check-in'))
    expect(checkins).toHaveLength(2)
    expect(checkins[0]!.text).toBe(checkins[1]!.text)
    expect(late).toEqual(['allow'])
    expect(w.checks).toEqual(['allow', 'allow'])
  })
})

describe("auto mode: the mod's own spawn", () => {
  const NOTE = `${RUN_DIR}/handover/impl-1-agent1-1.md`
  /** impl-1 at 460k is sent HANDOVER, writes its note and ends: the mod respawns it. */
  const handOver = async ($: Engine, w: World, beforeEnd?: () => void) => {
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(NOTE, 'x')
    beforeEnd?.()
    return complete($, 'agent1', 'HANDED OVER')
  }

  test('a respawn under auto mode is allowed and spawned', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await handOver($, w)
    await w.clock.settle()
    expect(w.spawnChecks).toEqual(['allow'])
    expect(w.spawns).toHaveLength(2)
    expect(row(w, 'agent2')!.replaces).toBe('agent1')
    expect(w.toasts.some(t => t.includes('no replacement started'))).toBe(false)
  })

  test('the prompt with and without the HANDOVER clause is the mod\'s; anything else is not', () => {
    const P = 'Do it.\n\n---\nYou replace…'
    const inFlight = [{ tool: 'Agent' as const, prompt: P }]
    expect(isOwnCall({ prompt: P }, inFlight)).toBe(true)
    expect(isOwnCall({ prompt: P + HANDOVER_CLAUSE }, inFlight)).toBe(true)
    expect(isOwnCall({ prompt: P + ' ' }, inFlight)).toBe(false)
    expect(isOwnCall({ prompt: 'other' }, inFlight)).toBe(false)
    expect(isOwnCall({ prompt: 42 }, inFlight)).toBe(false)
    expect(isOwnCall(null, inFlight)).toBe(false)
    expect(isOwnCall(42, inFlight)).toBe(false)
    expect(isOwnCall({ prompt: P }, [])).toBe(false)
    const stops = [{ tool: 'TaskStop' as const, taskId: 'agent1' }]
    expect(isOwnCall({ task_id: 'agent1' }, stops)).toBe(true)
    expect(isOwnCall({ shell_id: 'agent1' }, stops)).toBe(true)
    expect(isOwnCall({ task_id: 'agent2' }, stops)).toBe(false)
  })

  test('the same spawn checked after it settled is ask', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await handOver($, w)
    await w.clock.settle()
    expect(w.spawns).toHaveLength(2)
    const after = await $.tool.check({ tool: 'Agent', input: { prompt: w.spawns[1]!.prompt } } as never)
    expect(after.decision).toBe('ask')
  })

  test("a different prompt during the mod's spawn is ask; the mod's own is allow", async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    const mine =
      replacementPrompt({ prompt: 'P', subagentType: 'general-purpose', description: 'implement task', name: 'impl-1' }, NOTE) +
      HANDOVER_CLAUSE
    const probes: string[] = []
    w.duringSpawn = async check => {
      probes.push(await check({ prompt: 'P' }), await check({ prompt: mine }))
    }
    await handOver($, w)
    await w.clock.settle()
    expect(probes).toEqual(['ask', 'allow'])
  })

  test('a spawn that never answers allows nothing past the drain timeout', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    void handOver($, w, () => {
      w.hangSpawn = true
    }).catch(() => undefined)
    // the hanging spawn is recorded once its check has passed: its prompt is the one checked
    for (let i = 0; i < 100 && w.spawns.length < 2; i++) await w.clock.advance(1)
    expect(w.spawns).toHaveLength(2)
    const captured = w.spawns[1]!.prompt
    expect((await $.tool.check({ tool: 'Agent', input: { prompt: captured } } as never)).decision).toBe('allow')
    await w.clock.advance(11_000)
    expect((await $.tool.check({ tool: 'Agent', input: { prompt: captured } } as never)).decision).toBe('ask')
  })

  test('the Agent check hook never throws', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await start($)
    expect((await $.tool.check({ tool: 'Agent', input: null } as never)).decision).toBe('ask')
    expect((await $.tool.check({ tool: 'Agent', input: { prompt: 7 } } as never)).decision).toBe('ask')
  })
})

describe('a respawn that fails', () => {
  const NOTE2 = `${RUN_DIR}/handover/impl-2-agent2-1.md`
  const BRIEF2 = `${RUN_DIR}/handover/impl-2-agent2-1.brief.md`
  /** agent2 (impl-2, under agent1) at 460k is sent HANDOVER, writes its note and ends; its respawn then fails. */
  const failChild = async ($: Engine, w: World, deny = 'nope') => {
    await family($, w)
    w.spawnDeny = deny
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(NOTE2, 'x')
    await complete($, 'agent2', 'HANDED OVER')
    await w.clock.settle()
  }
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: unknown): Drawn[] =>
    n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''

  test('a refused respawn marks the gap and tells the parent agent how to respawn', async ($, on) => {
    const w = world(on)
    await failChild($, w)
    expect(row(w, 'agent2')!.status).toBe('respawn-failed')
    const told = w.sent.filter(m => m.to.includes('agent1') && m.text.includes('no replacement started: nope'))
    expect(told).toHaveLength(1)
    for (const s of [NOTE2, 'name "impl-2"', '.brief.md']) expect(told[0]!.text).toContain(s)
    const brief = w.files.get(BRIEF2)!
    expect(brief.startsWith('P2')).toBe(true)
    expect(brief).toContain(NOTE2)
    expect(w.toasts.some(t => t.includes('no replacement started'))).toBe(true)
  })

  test("main's child: the failure is submitted to main as a prompt", async ($, on) => {
    const w = world(on)
    await running($, w)
    w.spawnDeny = 'nope'
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    await w.clock.settle()
    const told = w.prompts.filter(p => p.includes('no replacement started'))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('agent1')
    expect(w.sent.some(m => m.text.includes('no replacement started'))).toBe(false)
  })

  test('a spawn that throws is a failed respawn', async ($, on) => {
    const w = world(on)
    await failChild($, w, 'throw')
    expect(row(w, 'agent2')!.status).toBe('respawn-failed')
    // The test kit hands the mod's spawn hook a throw beneath it as `no implementation`, not the original error.
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('no replacement started: spawn failed: '))).toBe(true)
  })

  test('an agent with no brief is a failed respawn', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent9', name: 'x' }]
    w.tokens.set('agent9', 460_000)
    await step($, 'agent9')
    await tool($, 'agent9')
    w.files.set(`${RUN_DIR}/handover/x-agent9-1.md`, 'x')
    await complete($, 'agent9', 'HANDED OVER')
    await w.clock.settle()
    expect(row(w, 'agent9')!.status).toBe('respawn-failed')
    expect(w.prompts.some(p => p.includes('No brief was recorded'))).toBe(true)
  })

  test('the gap shows in both panes and the roster', async ($, on) => {
    const w = world(on)
    await failChild($, w)
    const desk = await mountPane($, 'desktop')
    const deskText = (await desk.find({ key: 'row:agent2' }))!.text
    expect(deskText).toContain('⚠️')
    expect(deskText).toContain('respawn-failed')
    await desk.unmount()
    const term = await mountPane($, 'terminal')
    const termRow = walk(await term.drawn()).find(b => b.type === 'Box' && b.props?.key === 'agent2')!
    expect(textOf(termRow)).toContain('✗')
    await term.unmount()
    const roster = (await $.command.run({ command: 'orch', args: 'roster' } as never)) as { text: string }
    expect(roster.text).toContain('| respawn-failed |')
  })


  test('a refused notification leaves no unhandled rejection; the gap is still marked and told', async ($, on) => {
    const w = world(on)
    w.notifyDeny = 'no'
    // The sandbox has no `process`: the test kit itself fails the file on "a rejection nothing handled".
    await failChild($, w)
    expect(row(w, 'agent2')!.status).toBe('respawn-failed')
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('no replacement started'))).toBe(true)
  })

  test('a refused stall notification leaves no unhandled rejection', async ($, on) => {
    const w = world(on)
    w.notifyDeny = 'no'
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    await w.clock.advance(20 * 60_000 + 30_000)
    await w.clock.settle()
    expect(row(w, 'agent1')!.status).toBe('stalled')
  })

  test("a spawn by another agent naming the note is not linked as the replacement", async ($, on) => {
    const w = world(on)
    await failChild($, w)
    await spawn($, { prompt: w.files.get(BRIEF2)!, name: 'impl-2', parentAgentId: 'agent9' })
    expect(row(w, 'agent2')!.status).toBe('respawn-failed')
    expect(row(w, 'agent2')!.replacedBy).toBeUndefined()
  })

  test("the parent's own spawn from the brief file is linked as the replacement", async ($, on) => {
    const w = world(on)
    await failChild($, w)
    await spawn($, { prompt: w.files.get(BRIEF2)!, name: 'impl-2', parentAgentId: 'agent1' })
    expect(row(w, 'agent2')).toEqual(expect.objectContaining({ status: 'replaced', replacedBy: 'agent3' }))
    expect(row(w, 'agent3')!.replaces).toBe('agent2')
  })

  test('the scripted reply no longer claims the spawn', async ($, on) => {
    const w = world(on)
    await running($, w)
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    const res = await tool($, 'agent1')
    const handover = (res.context ?? []).find(c => c.includes('HANDOVER'))!
    expect(handover).toContain('will spawn the replacement')
  })

  test('under auto mode with the allow in place, a respawn is not reported as failed', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await start($)
    await spawn($, { prompt: 'P', name: 'impl-1' })
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    await w.clock.settle()
    expect(w.spawns).toHaveLength(2)
    expect(w.toasts.some(t => t.includes('no replacement started'))).toBe(false)
    expect(w.prompts.some(p => p.includes('no replacement started'))).toBe(false)
  })
})

describe('after a handover, the replacement takes over', () => {
  /** `id` at 460k is sent HANDOVER, writes `note` and ends: the mod respawns it. */
  const handOver = async ($: Engine, w: World, id: string, note: string) => {
    w.tokens.set(id, 460_000)
    await step($, id)
    await tool($, id)
    w.files.set(note, 'x')
    await complete($, id, 'HANDED OVER')
    await w.clock.settle()
  }
  /** impl-1 (agent1, with child impl-2) hands over; agent3, registered impl-1-2, replaces it. */
  const swap = async ($: Engine, w: World) => {
    await family($, w)
    w.agents.push({ id: 'agent3', name: 'impl-1-2' })
    await handOver($, w, 'agent1', `${RUN_DIR}/handover/impl-1-agent1-1.md`)
  }
  /** Records the `to` of each SendMessage that reaches the engine. */
  const watchSends = (w: World) => {
    const seen: string[] = []
    w.toolAnswer = e => {
      if (e.tool === 'SendMessage') seen.push(String(e.to))
      return undefined
    }
    return seen
  }
  const logged = async ($: Engine) => {
    const ui = await mountPane($, 'desktop')
    const s = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return s
  }

  test("a child's SendMessage to its replaced parent goes to the replacement, and the child is told", async ($, on) => {
    const w = world(on)
    await swap($, w)
    const seen = watchSends(w)
    const res = (await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'R: green' })) as { context?: string[] }
    expect(seen).toEqual(['impl-1-2'])
    const ctx = (res.context ?? []).filter(c => c.includes('impl-1 was replaced by impl-1-2'))
    expect(ctx).toHaveLength(1)
    expect(await logged($)).toContain('redirected to impl-1-2')
  })

  test('by id too', async ($, on) => {
    const w = world(on)
    await swap($, w)
    const seen = watchSends(w)
    await call($, 'agent2', 'SendMessage', { to: 'agent1', message: 'R: green' })
    expect(seen).toEqual(['impl-1-2'])
  })

  test("the redirected report counts as the child's report", async ($, on) => {
    const w = world(on)
    await swap($, w)
    await call($, 'agent3', 'mcp__orchestrator__checkin', { agent: 'impl-2', minutes: 30 })
    expect(row(w, 'agent2')!.checkinAt).toBeDefined()
    watchSends(w)
    await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'R: green' })
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    expect(row(w, 'agent2')!.report?.ok).toBe(true)
  })

  test('a replacement that registered the old name is not redirected to', async ($, on) => {
    const w = world(on)
    await family($, w)
    w.agents.push({ id: 'agent3', name: 'impl-1' })
    await handOver($, w, 'agent1', `${RUN_DIR}/handover/impl-1-agent1-1.md`)
    await complete($, 'agent3')
    const seen = watchSends(w)
    const res = (await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'x' })) as { context?: string[] }
    expect(seen).toEqual(['impl-1'])
    expect((res.context ?? []).some(c => c.includes('was replaced by'))).toBe(false)
  })

  test('a chain goes to the newest replacement', async ($, on) => {
    const w = world(on)
    await swap($, w)
    w.agents.push({ id: 'agent4', name: 'impl-1-3' })
    await step($, 'agent3') // starts small: a replacement that starts at the threshold is never handed over again
    await handOver($, w, 'agent3', `${RUN_DIR}/handover/impl-1-2-agent3-1.md`)
    expect(row(w, 'agent3')!.replacedBy).toBe('agent4')
    const seen = watchSends(w)
    await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'R' })
    expect(seen).toEqual(['impl-1-3'])
  })

  test('left as addressed: a live name, the replacement to its predecessor, a failed respawn', async ($, on) => {
    const w = world(on)
    await swap($, w)
    const seen = watchSends(w)
    const live = (await call($, 'agent3', 'SendMessage', { to: 'impl-2', message: 'x' })) as { context?: string[] }
    const back = (await call($, 'agent3', 'SendMessage', { to: 'impl-1', message: 'x' })) as { context?: string[] }
    expect(seen).toEqual(['impl-2', 'impl-1'])
    expect(live.context).toBeUndefined()
    expect(back.context).toBeUndefined()
  })

  test('left as addressed: a send to an agent whose respawn failed', async ($, on) => {
    const w = world(on)
    await family($, w)
    w.spawnDeny = 'nope'
    await handOver($, w, 'agent1', `${RUN_DIR}/handover/impl-1-agent1-1.md`)
    expect(row(w, 'agent1')!.status).toBe('respawn-failed')
    const seen = watchSends(w)
    const res = (await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'x' })) as { context?: string[] }
    expect(seen).toEqual(['impl-1'])
    expect(res.context).toBeUndefined()
  })

  test("main's SendMessage is redirected too", async ($, on) => {
    const w = world(on)
    await swap($, w)
    const seen = watchSends(w)
    const res = (await call($, undefined, 'SendMessage', { to: 'impl-1', message: 'x' })) as { context?: string[] }
    expect(seen).toEqual(['impl-1-2'])
    expect((res.context ?? []).some(c => c.includes('impl-1 was replaced by impl-1-2'))).toBe(true)
  })

  test('the old agent is stopped once its replacement started', async ($, on) => {
    const w = world(on)
    await swap($, w)
    expect(w.stops).toEqual(['agent1'])
    expect(await logged($)).toContain('impl-1 (agent1) stopped')
  })

  test('a failed stop is logged and the swap still completes', async ($, on) => {
    const w = world(on)
    w.stopFails = 'not running'
    await swap($, w)
    const s = await logged($)
    expect(s).toContain('not stopped (not running)')
    expect(row(w, 'agent3')!.replaces).toBe('agent1')
    expect(row(w, 'agent2')!.parentId).toBe('agent3')
    expect(s).toContain('impl-1 replaced by agent3')
  })

  test('a stop that throws is logged and the swap still completes', async ($, on) => {
    const w = world(on)
    w.stopFails = 'throw'
    await swap($, w)
    // The test kit hands a throw beneath the plugin's own tool call back as `no implementation`, not the original error.
    expect(await logged($)).toContain('(agent1) not stopped (')
    expect(row(w, 'agent3')!.replaces).toBe('agent1')
    expect(row(w, 'agent2')!.parentId).toBe('agent3')
  })

  test("a child respawned while its parent respawns lands under the parent's replacement", async ($, on) => {
    const w = world(on)
    await family($, w)
    let release = () => {}
    w.spawnHoldNext = new Promise<void>(r => (release = r))
    // The child hands over first; its spawn waits.
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    void complete($, 'agent2', 'HANDED OVER').catch(() => undefined)
    for (let i = 0; i < 20; i++) await w.clock.advance(1)
    // The parent hands over and is replaced (agent3) while the child's spawn waits.
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    await w.clock.settle()
    expect(row(w, 'agent1')!.replacedBy).toBe('agent3')
    release()
    await w.clock.settle()
    expect(row(w, 'agent2')!.replacedBy).toBe('agent4')
    expect(row(w, 'agent4')!.parentId).toBe('agent3')
  })

  test('the parent is told before the stop answers: main', async ($, on) => {
    const w = world(on)
    w.stopFails = 'hang'
    void swap($, w).catch(() => undefined)
    for (let i = 0; i < 50; i++) await w.clock.advance(1)
    expect(JSON.stringify(w.session.appended())).toContain('Replacement id agent3')
    await w.clock.advance(10_000)
    await w.clock.settle()
  })

  test('the parent is told before the stop answers: an agent parent', async ($, on) => {
    const w = world(on)
    await family($, w)
    w.stopFails = 'hang'
    w.tokens.set('agent2', 460_000)
    await step($, 'agent2')
    await tool($, 'agent2')
    w.files.set(`${RUN_DIR}/handover/impl-2-agent2-1.md`, 'x')
    void complete($, 'agent2', 'HANDED OVER').catch(() => undefined)
    for (let i = 0; i < 50; i++) await w.clock.advance(1)
    expect(w.sent.some(m => m.to.includes('agent1') && m.text.includes('Replacement id agent3'))).toBe(true)
    await w.clock.advance(10_000)
    await w.clock.settle()
  })

  test('a stop that never answers is given up after the drain timeout, and the parent is still told', async ($, on) => {
    const w = world(on)
    w.stopFails = 'hang'
    void swap($, w).catch(() => undefined)
    for (let i = 0; i < 50; i++) await w.clock.advance(1)
    await w.clock.advance(10_000)
    await w.clock.settle()
    expect(row(w, 'agent2')!.parentId).toBe('agent3')
    expect(JSON.stringify(w.session.appended())).toContain('Replacement id agent3')
    const s = await logged($)
    expect(s).toContain('(agent1) not stopped (')
    expect(s).toContain('impl-1 replaced by agent3')
  })

  test('under auto mode the stop is allowed, and only while in flight', async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await swap($, w)
    expect(w.stopChecks).toEqual(['allow'])
    expect(w.stops).toEqual(['agent1'])
    expect((await $.tool.check({ tool: 'TaskStop', input: { task_id: 'agent1' } } as never)).decision).toBe('ask')
    expect((await $.tool.check({ tool: 'TaskStop', input: 42 } as never)).decision).toBe('ask')
  })

  test("the old agent's children show under the replacement", async ($, on) => {
    const w = world(on)
    await swap($, w)
    expect(row(w, 'agent2')!.parentId).toBe('agent3')
    await complete($, 'agent3')
    const ui = await mountPane($, 'desktop')
    const keys = (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('row:'))
    expect(keys.indexOf('row:agent2')).toBeGreaterThan(keys.indexOf('row:agent3'))
    expect(keys.indexOf('row:agent3')).toBeGreaterThanOrEqual(0)
    expect(((await ui.find({ key: 'row:agent2' }))!.props as Record<string, unknown>).paddingLeft).toBe(2)
    expect((await ui.find({ key: 'agent:agent3' }))!.text).toContain('waiting')
    await ui.unmount()
  })

  test("a parent replaced earlier is the one told of its child's swap", async ($, on) => {
    const w = world(on)
    await swap($, w)
    w.sent.length = 0
    await handOver($, w, 'agent2', `${RUN_DIR}/handover/impl-2-agent2-1.md`)
    expect(row(w, 'agent2')!.replacedBy).toBeDefined()
    const told = w.sent.filter(m => m.text.includes('handed over'))
    expect(told.length).toBeGreaterThan(0)
    expect(told.every(m => m.to.includes('agent3'))).toBe(true)
  })

  test('a manual replacement after a failed respawn is linked, adopts the children and stops the old agent', async ($, on) => {
    const w = world(on)
    await family($, w)
    await spawn($, { prompt: 'P3', name: 'impl-3', parentAgentId: 'agent2' })
    w.spawnDeny = 'nope'
    const note = `${RUN_DIR}/handover/impl-2-agent2-1.md`
    await handOver($, w, 'agent2', note)
    expect(row(w, 'agent2')!.status).toBe('respawn-failed')
    await spawn($, { prompt: w.files.get(`${RUN_DIR}/handover/impl-2-agent2-1.brief.md`)!, name: 'impl-2', parentAgentId: 'agent1' })
    expect(row(w, 'agent2')).toEqual(expect.objectContaining({ status: 'replaced', replacedBy: 'agent4' }))
    expect(row(w, 'agent3')!.parentId).toBe('agent4')
    await w.clock.settle()
    expect(w.stops).toContain('agent2')
  })
})

describe('the activity log never holds the mod up', () => {
  test('a log line is in the pane while its file write never answers', async ($, on) => {
    const w = world(on)
    await start($)
    w.activityHang = true
    const done: string[] = []
    void spawn($, { prompt: 'P', name: 'impl-1' }).then(() => done.push('impl-1'))
    for (let i = 0; i < 5000; i++) await Promise.resolve()
    void spawn($, { prompt: 'P', name: 'impl-2' }).then(() => done.push('impl-2'))
    for (let i = 0; i < 5000; i++) await Promise.resolve()
    expect(done).toEqual(['impl-1', 'impl-2'])
    const ui = await mountPane($, 'desktop')
    const s = JSON.stringify(await ui.drawn())
    await ui.unmount()
    expect(s).toContain('spawned impl-1 (agent1)')
    expect(s).toContain('spawned impl-2 (agent2)')
  })
})

describe('the activity log never holds a press up', () => {
  test('a Hand over press goes through while its press line is never written', async ($, on) => {
    const w = world(on)
    await running($, w)
    w.activityHang = true
    const ui = await mountPane($, 'desktop')
    void ui.press({ key: 'handover:agent1' })
    for (let i = 0; i < 5000; i++) await Promise.resolve()
    expect(row(w, 'agent1')!.status).toBe('handing-over')
    await ui.unmount()
  })
})

describe('copy', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const copyKeys = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('copy:'))
  const brief = { role: 'user', text: 'Implement task 1', toolUses: [] }
  const LONG = `Long thoughts: ${'the plan has many parts and each needs care. '.repeat(12)}END`
  const bashUse = { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'PASS 3 tests' }
  const said = (...toolUses: unknown[]) => ({ value: [brief, { role: 'assistant', text: '', toolUses }] as never })
  const opened = async ($: Engine, w: World, surface: 'terminal' | 'desktop', cols = 100) => {
    await running($, w)
    const ui = await mountPane($, surface, cols)
    await ui.press({ key: 'agent:agent1' })
    await w.clock.settle()
    return ui
  }
  const mountTool = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') =>
    $.ui.mount({ plugin: 'orchestrator', surface, component: 'Pane', requestId: 'orchestrator-tool', props: { bodyColumns: 100 } as never })

  test('each desktop agent row has a copy control that copies its name and id', async ($, on) => {
    const w = world(on)
    await running($, w)
    await step($)
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ key: 'copy:agent:main' })).toBeDefined()
    expect(await ui.find({ key: 'copy:agent:agent1' })).toBeDefined()
    await ui.press({ key: 'copy:agent:agent1' })
    await w.clock.settle()
    expect(w.copies).toEqual([{ text: 'impl-1 (agent1)', surface: 'desktop' }])
    expect(w.toasts).toContain('Copied')
    await ui.press({ key: 'copy:agent:main' })
    await w.clock.settle()
    expect(w.copies[1]!.text).toBe('main thread (main)')
    await ui.unmount()
  })

  test('the terminal draws no copy control', async ($, on) => {
    const w = world(on)
    on('session.messages', () => ({ value: [brief, { role: 'assistant', text: LONG, toolUses: [] }] as never }))
    await spawn($, { prompt: 'P', name: 'a-rather-long-agent-name-that-will-not-fit-in-a-narrow-pane' })
    const ui = await opened($, w, 'terminal', 40)
    expect(await ui.find({ key: 'transcript:agent1' })).toBeDefined()
    const step = (await ui.findAll({ type: 'Button' })).find(b => (b.key ?? '').startsWith('step-agent1-'))!
    await ui.press({ key: step.key! })
    expect(await copyKeys(ui)).toHaveLength(0)
    const line = (await ui.findAll({ type: 'Button' })).find(b => b.text.includes('spawned'))!
    expect(line).toBeDefined()
    await ui.press({ key: line.key! })
    expect(await copyKeys(ui)).toHaveLength(0)
    await ui.unmount()
  })

  test('a copy that fails while logging is broken still toasts', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    w.copyFails = 'throw'
    w.logFails = true
    await ui.press({ key: 'copy:agent:agent1' })
    await w.clock.settle()
    expect(w.toasts[w.toasts.length - 1]).toBe('Not copied')
    await ui.unmount()
  })

  test('a pinned activity card has a copy control for its full text', async ($, on) => {
    const w = world(on)
    await start($)
    const name = 'a-rather-long-agent-name-that-will-not-fit-in-a-narrow-pane'
    await spawn($, { prompt: 'P', name })
    const ui = await mountPane($, 'desktop', 40)
    const line = (await ui.findAll({ type: 'Button' })).find(b => b.text.includes('spawned'))!
    expect(await ui.find({ key: `copy:${line.key}` })).toBeUndefined()
    await ui.press({ key: line.key! })
    await ui.press({ key: `copy:${line.key}` })
    await w.clock.settle()
    expect(w.copies[0]!.text).toContain(name)
    await ui.unmount()
  })

  test('an expanded transcript text has a copy control for its full text', async ($, on) => {
    const w = world(on)
    on('session.messages', () => ({ value: [brief, { role: 'assistant', text: LONG, toolUses: [] }] as never }))
    const ui = await opened($, w, 'desktop', 80)
    const button = (await ui.findAll({ type: 'Button' })).find(b => (b.key ?? '').startsWith('step-agent1-'))!
    expect(await ui.find({ key: `copy:${button.key}` })).toBeUndefined()
    await ui.press({ key: button.key! })
    await ui.press({ key: `copy:${button.key}` })
    await w.clock.settle()
    expect(w.copies[0]!.text).toContain('END')
    expect(w.copies[0]!.text).toContain('Long thoughts:')
    await ui.unmount()
  })

  test('a prose tool-detail section has a copy control; a code section has the desktop’s own (desktop dialog)', async ($, on) => {
    const w = world(on)
    on('session.messages', () => said({ ...bashUse, input: { command: 'npm test', description: 'Run the tests' } }))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    let tool = await mountTool($, 'desktop')
    // Description (text), then Command and Output (code): the desktop draws a copy button on each Code itself.
    expect((await copyKeys(tool)).map(b => b.key)).toEqual(['copy:sec:b:0'])
    await tool.press({ key: 'copy:sec:b:0' })
    await w.clock.settle()
    expect(w.copies.map(c => c.text)).toEqual(['Run the tests'])
    await tool.unmount()
    tool = await mountTool($, 'terminal')
    expect(await copyKeys(tool)).toHaveLength(0)
    await tool.unmount()
    await ui.unmount()
  })

  test('the inline detail on a desktop that places no dialog has the same controls', async ($, on) => {
    const w = world(on)
    w.placesTool = false
    on('session.messages', () => said({ ...bashUse, input: { command: 'npm test', description: 'Run the tests' } }))
    const ui = await opened($, w, 'desktop')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    expect(await ui.find({ key: 'copy:sec:b:0' })).toBeDefined()
    expect(await ui.find({ key: 'copy:sec:b:1' })).toBeUndefined()
    await ui.unmount()
  })

  test('the inline detail on the terminal has no copy controls', async ($, on) => {
    const w = world(on)
    w.placesTool = false
    on('session.messages', () => said(bashUse))
    const ui = await opened($, w, 'terminal')
    await ui.press({ key: 'tool:agent1:b' })
    await w.clock.settle()
    expect(await ui.find({ key: 'tooldetail:b' })).toBeDefined()
    expect(await copyKeys(ui)).toHaveLength(0)
    await ui.unmount()
  })

  test('a copy that fails says why and never throws', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    w.copyFails = 'no-clipboard'
    await ui.press({ key: 'copy:agent:agent1' })
    await w.clock.settle()
    expect(w.toasts).toContain('Not copied (no-clipboard)')
    w.copyFails = 'throw'
    await ui.press({ key: 'copy:agent:agent1' })
    await w.clock.settle()
    expect(w.toasts[w.toasts.length - 1]).toBe('Not copied')
    expect(w.logs.some(l => l.includes('copy failed'))).toBe(true)
    await ui.unmount()
  })
})

describe('engine-assigned names', () => {
  const CHECKIN = 'mcp__orchestrator__checkin'
  /** main spawns agent1 asking for `orchestrator`; the engine registers it as `orchestrator-2`. */
  const renamed = async ($: Engine, w: World, o: { isTeammate?: boolean } = {}) => {
    await start($)
    w.agents = [{ id: 'agent1', name: 'orchestrator-2' }]
    await spawn($, { prompt: 'P', name: 'orchestrator', ...o })
    await w.clock.settle()
    await step($, 'agent1')
  }

  test('the spawn records the name the engine registered and keeps the requested one in the brief', async ($, on) => {
    const w = world(on)
    await renamed($, w)
    expect(row(w, 'agent1')!.name).toBe('orchestrator-2')
    expect(row(w, 'agent1')!.brief!.name).toBe('orchestrator')
    const ui = await mountPane($, 'desktop')
    expect(JSON.stringify(await ui.drawn())).toContain('\\"orchestrator\\" registered as orchestrator-2 (agent1)')
    await ui.unmount()
  })

  test('an unlisted agent keeps its requested name, and a list that fails never fails the spawn', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'P', name: 'orchestrator' })
    expect(row(w, 'agent1')!.name).toBe('orchestrator')
    w.agents = null as never
    const res = await spawn($, { prompt: 'P2', name: 'orchestrator' })
    expect(res.agentId).toBe('agent2')
    expect(w.spawns).toHaveLength(2)
    expect(row(w, 'agent2')!.name).toBe('orchestrator')
  })

  for (const agent of ['orchestrator-2', 'agent1', 'orchestrator']) {
    test(`check-in finds a renamed child by its registered name, its id, or the name it asked for (${agent})`, async ($, on) => {
      const w = world(on)
      await renamed($, w)
      const res = String((await call($, undefined, CHECKIN, { agent, minutes: 30 })).result)
      expect(res).toContain('armed')
      expect(res).toContain('agent1')
      expect(row(w, 'agent1')!.checkinAt).toBeDefined()
    })
  }

  test('check-in prefers the agent holding a name over one that asked for it', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'orchestrator' }, { id: 'agent2', name: 'orchestrator-2' }]
    await spawn($, { prompt: 'P', name: 'orchestrator' })
    await spawn($, { prompt: 'P2', name: 'orchestrator' })
    await w.clock.settle()
    await call($, undefined, CHECKIN, { agent: 'orchestrator', minutes: 30 })
    expect(row(w, 'agent1')!.checkinAt).toBeDefined()
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
  })

  test('check-in on an ambiguous requested name changes nothing and names the candidates', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'impl-2' }, { id: 'agent2', name: 'impl-3' }]
    await spawn($, { prompt: 'P', name: 'impl' })
    await spawn($, { prompt: 'P2', name: 'impl' })
    await w.clock.settle()
    const res = String((await call($, undefined, CHECKIN, { agent: 'impl', minutes: 30 })).result)
    expect(res).toContain('could mean')
    expect(res).toContain('agent1')
    expect(res).toContain('agent2')
    expect(row(w, 'agent1')!.checkinAt).toBeUndefined()
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
  })

  for (const target of ['orchestrator-2', 'orchestrator']) {
    test(`/orch handover takes a renamed agent's registered or requested name (${target})`, async ($, on) => {
      const w = world(on)
      await renamed($, w)
      await complete($, 'agent1')
      const res = (await $.command.run({ command: 'orch', args: `handover ${target}` } as never)) as { text?: string }
      expect(String(res.text)).toContain('HANDOVER sent')
      expect(row(w, 'agent1')!.status).toBe('handing-over')
    })
  }

  test("a child's SendMessage to its parent's registered name is its report; to the requested name it is not", async ($, on) => {
    const w = world(on)
    await renamed($, w)
    await spawn($, { prompt: 'P2', name: 'impl', parentAgentId: 'agent1' })
    await step($, 'agent2')
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await call($, 'agent2', 'SendMessage', { to: 'orchestrator', message: 'x' })
    expect(row(w, 'agent2')!.report).toBeUndefined()
    expect(row(w, 'agent2')!.checkinAt).toBeDefined()
    await call($, 'agent2', 'SendMessage', { to: 'orchestrator-2', message: 'x' })
    expect(row(w, 'agent2')!.report).toEqual(expect.objectContaining({ text: 'x', ok: true }))
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
  })

  test("under auto mode, the mod's send to a renamed teammate is allowed", async ($, on) => {
    const w = world(on)
    autoMode($, on, w)
    await renamed($, w, { isTeammate: true })
    await complete($, 'agent1')
    const probes: string[] = []
    // the queued name notice goes out too; this probes the HANDOVER send
    w.duringSend = async (check, e) => {
      if (e.text.startsWith('HANDOVER')) probes.push(await check({ to: 'orchestrator-2', message: e.text }))
    }
    await $.command.run({ command: 'orch', args: 'handover agent1' } as never)
    expect(probes).toEqual(['allow'])
  })

  const NOTICE = nameNotice('orchestrator-2', 'orchestrator')
  const logged = async ($: Engine) => {
    const ui = await mountPane($, 'desktop')
    const s = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return s
  }

  test('a renamed agent is told its registered name once, at the next turn end', async ($, on) => {
    const w = world(on)
    await renamed($, w)
    expect(w.sent).toHaveLength(0)
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent).toEqual([{ to: 'agent1', text: NOTICE }])
    expect(await logged($)).toContain('\\"orchestrator\\" registered as orchestrator-2 (agent1); told it so')
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent).toHaveLength(1)
  })

  test('a slow agent list never holds the spawn: the row is recorded at once, renamed when the list answers', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'orchestrator-2' }]
    let answer!: () => void
    w.holdList = new Promise<void>(resolve => (answer = resolve))
    const res = await Promise.race([spawn($, { prompt: 'P', name: 'orchestrator' }), w.clock.advance(1000).then(() => 'held')])
    expect(res).not.toBe('held')
    expect(row(w, 'agent1')!.name).toBe('orchestrator')
    answer()
    await w.clock.settle()
    expect(row(w, 'agent1')!.name).toBe('orchestrator-2')
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent).toEqual([{ to: 'agent1', text: NOTICE }])
  })

  test('a renamed agent that finished before the turn end is not woken by its notice', async ($, on) => {
    const w = world(on)
    await renamed($, w)
    // it ends and the engine stops listing it: the next sync marks it done
    w.agents = []
    await w.clock.advance(30_000)
    expect(row(w, 'agent1')!.status).toBe('done')
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent).toEqual([])
    expect(w.timerSends).toEqual([])
    expect((JSON.parse(w.files.get(STATE)!) as { outbox?: unknown[] }).outbox ?? []).toEqual([])
  })

  test('the notice is queued as live-only', async ($, on) => {
    const w = world(on)
    await renamed($, w)
    const outbox = (JSON.parse(w.files.get(STATE)!) as { outbox?: { liveOnly?: boolean }[] }).outbox ?? []
    expect(outbox).toEqual([expect.objectContaining({ liveOnly: true })])
  })

  test('an agent that got the name it asked for is told nothing', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'orchestrator' }]
    await spawn($, { prompt: 'P', name: 'orchestrator' })
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent.filter(s => s.text.includes('registered as'))).toHaveLength(0)
    expect(await logged($)).not.toContain('" registered as')
  })

  test('an unnamed agent the engine names is told nothing', async ($, on) => {
    const w = world(on)
    await start($)
    w.agents = [{ id: 'agent1', name: 'bg-1' }]
    await spawn($, { prompt: 'P' })
    await w.clock.settle()
    expect(row(w, 'agent1')!.name).toBe('bg-1')
    await complete($, undefined)
    await w.clock.settle()
    expect(w.sent.filter(s => s.text.includes('registered as'))).toHaveLength(0)
    expect(await logged($)).not.toContain('" registered as')
  })

  test('a renamed replacement is told its name, once', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { prompt: 'Read files.', name: 'probe' })
    w.agents = [
      { id: 'agent1', name: 'probe', teammateId: 'probe@s' },
      { id: 'agent2', name: 'probe-2', teammateId: 'probe-2@s' },
    ]
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/probe-agent1-1.md`, 'x')
    await complete($, 'agent1')
    expect(row(w, 'agent2')!.name).toBe('probe-2')
    expect(row(w, 'agent2')!.teammateId).toBe('probe-2@s')
    await complete($, undefined)
    await w.clock.settle()
    await complete($, undefined)
    await w.clock.settle()
    const notices = w.sent.filter(s => s.text.includes('registered as'))
    expect(notices).toEqual([{ to: 'agent2', text: nameNotice('probe-2', 'probe') }])
  })

  test('the notice is queued in state.json, so a reload keeps it', async ($, on) => {
    const w = world(on)
    await renamed($, w)
    const outbox = (JSON.parse(w.files.get(STATE)!) as { outbox?: { agentId: string; text: string }[] }).outbox ?? []
    expect(outbox).toEqual([expect.objectContaining({ agentId: 'agent1', text: NOTICE })])
  })
})

describe('activity.log', () => {
  const ACT = `${RUN_DIR}/activity.log`
  const lines = (w: World) => (w.files.get(ACT) ?? '').split('\n').filter(Boolean)
  type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(textOf).join('') : ''

  test('every activity line is written to the run folder', async ($, on) => {
    const w = world(on)
    await running($, w)
    expect(w.files.get(ACT)).toContain('info spawned impl-1 (agent1)')
  })

  test('a warn is marked WARN', async ($, on) => {
    const w = world(on)
    await running($, w)
    w.spawnDeny = 'nope'
    w.tokens.set('agent1', 460_000)
    await step($, 'agent1')
    await tool($, 'agent1')
    w.files.set(`${RUN_DIR}/handover/impl-1-agent1-1.md`, 'x')
    await complete($, 'agent1', 'HANDED OVER')
    await w.clock.settle()
    expect(lines(w).some(l => / WARN .*no replacement started \(nope\)/.test(l))).toBe(true)
  })

  test('the file keeps the last ACTIVITY_MAX lines, earlier lines read back after a reload', async ($, on) => {
    const w = world(on)
    w.files.set(ACT, Array.from({ length: ACTIVITY_MAX }, (_, i) => `old ${i}`).join('\n') + '\n')
    await running($, w)
    const l = lines(w)
    expect(l).toHaveLength(ACTIVITY_MAX)
    expect(l[0]).toBe('old 1')
    expect(l.at(-1)).toContain('spawned impl-1')
    expect(w.files.get(ACT)!.endsWith('\n')).toBe(true)
  })

  test('a pane press is recorded in the file, not the pane', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'agent:agent1' })
    expect(w.files.get(ACT)).toContain('press agent:agent1 (desktop, orchestrator)')
    const drawn = (await ui.findAll({ type: 'Text' })).map(t => textOf(t)).join('\n')
    expect(drawn).not.toContain('press agent:')
    await ui.unmount()
  })

  test('two Hand over presses at once start one handover, and the second says why', async ($, on) => {
    const w = world(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    await Promise.all([ui.press({ key: 'handover:agent1' }), ui.press({ key: 'handover:agent1' })])
    await w.clock.settle()
    expect(row(w, 'agent1')!.handovers).toBe(1)
    const l = lines(w)
    expect(l.filter(x => x.includes('press handover:agent1 (desktop'))).toHaveLength(2)
    expect(l.filter(x => x.includes('Hand over not started ('))).toHaveLength(1)
    expect(l.filter(x => x.includes('HANDOVER goes with its next tool result'))).toHaveLength(1)
    await ui.unmount()
  })

  test('a failing write never breaks logging', async ($, on) => {
    const w = world(on)
    w.fsFails = ACT
    await running($, w)
    expect(row(w, 'agent1')).toBeDefined()
    expect(w.logSinks.some(s => s.to === 'debug' && s.text.includes('activity.log not written'))).toBe(true)
  })

  /** A /clear: the next read of each key finds nothing, until the plugin writes it again. */
  const wipeable = (on: Parameters<typeof world>[0]) => {
    let wiped: Set<string> | undefined
    on('state.get', async ($, e, next) => {
      const res = (await next(e)) as { value?: { value: unknown; version: number } }
      const k = (e as unknown as { key: string }).key
      if (!wiped?.has(k) || !res.value) return res as never
      return { value: { value: undefined, version: res.value.version } } as never
    })
    on('state.set', async ($, e, next) => {
      const res = await next(e)
      wiped?.delete((e as unknown as { key: string }).key)
      return res
    })
    return () => {
      wiped = new Set(['agents', 'log', 'mainPhase', 'runId', 'outbox', 'selectedAgent', 'transcripts', 'collapsed', 'toolView', 'pinnedLog', 'mainQueued'])
    }
  }
  type Mounted = Awaited<ReturnType<typeof mountPane>>
  /** A press whose rejection (a start that throws) is the test's to ignore. */
  const pressAnyway = (ui: Mounted, key: string) => ui.press({ key }).catch(() => undefined)

  test('a press and a log after a /clear, before restore, do not fork the run', async ($, on) => {
    const w = world(on)
    const wipe = wipeable(on)
    await running($, w)
    const ui = await mountPane($, 'desktop')
    wipe()
    w.sessionId = 'S2' // a /clear changes the session id; the run keeps the first
    await pressAnyway(ui, 'agent:agent1')
    await step($) // restores from state.json
    expect(row(w, 'agent1')).toBeDefined()
    expect((JSON.parse(w.files.get(STATE)!) as { runId: string }).runId).toBe('S1')
    expect(w.files.get(ACT)).toContain('spawned impl-1')
    expect(w.files.get(ACT)).toContain('press agent:agent1 (desktop, orchestrator)')
    expect([...w.files.keys()].some(k => k.includes('/S2/'))).toBe(false)
    await ui.unmount()
  })

  test('a line before session.start is not written at the root, and lands in the file after start', async ($, on) => {
    const w = world(on)
    await spawn($, { prompt: 'P0', name: 'early' })
    expect(w.files.has('/activity.log')).toBe(false)
    await running($, w)
    const l = lines(w)
    expect(l.some(x => x.includes('spawned early'))).toBe(true)
    expect(l.some(x => x.includes('spawned impl-1'))).toBe(true)
    expect([...w.files.keys()].filter(k => k.endsWith('activity.log'))).toEqual([ACT])
  })

  test('a Hand over start that throws releases its guard: the next press starts it', async ($, on) => {
    const w = world(on)
    const wipe = wipeable(on)
    await running($, w)
    await spawn($, { prompt: 'P2', name: 'impl-2', parentAgentId: 'agent1' })
    await step($, 'agent2')
    await complete($, 'agent1')
    expect(row(w, 'agent1')!.status).toBe('idle')
    const ui = await mountPane($, 'desktop')
    w.sendFails = 'throw'
    await pressAnyway(ui, 'handover:agent1')
    w.sendFails = ''
    // agent1 back to idle, as if the failed start had never happened
    const saved = JSON.parse(w.files.get(STATE)!) as { agents: AgentRow[] }
    saved.agents = saved.agents.map(a => (a.id === 'agent1' ? { ...a, status: 'idle', handoverVia: undefined } : a))
    w.files.set(STATE, JSON.stringify(saved))
    wipe()
    await step($)
    await pressAnyway(ui, 'handover:agent1')
    const l = lines(w)
    expect(l.some(x => x.includes('already starting'))).toBe(false)
    expect(l.some(x => x.includes('HANDOVER sent'))).toBe(true)
    await ui.unmount()
  })
})

describe('background shells: tracking', () => {
  const ACT = `${RUN_DIR}/activity.log`
  const logged = async (w: World, text: string) => {
    await w.clock.settle()
    return (w.files.get(ACT) ?? '').includes(text)
  }
  const out = (id: string) => `${TASKS}/${id}.output`
  /** One poll interval (15 s by default) passes and the poll's reads settle. */
  const poll = async (w: World, ms = 15_000) => {
    await w.clock.advance(ms)
    await w.clock.settle()
  }

  test("a subagent's backgrounded Bash call is tracked on its row and logged", async ($, on) => {
    const w = world(on)
    await family($, w)
    const now = w.clock.now()
    await bgBash($, w, 'agent2', 'b1', { description: 'run the tests', command: 'npm test' })
    expect(row(w, 'agent2')!.shells).toEqual([
      { id: 'b1', outputPath: out('b1'), description: 'run the tests', command: 'npm test', startedAt: now },
    ])
    expect(row(w, 'agent1')!.shells).toBeUndefined()
    expect(await logged(w, 'impl-2: background command "run the tests" (b1) started')).toBe(true)
  })

  test('a command the engine moved to the background is tracked too', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b2', { auto: true, description: 'build' })
    expect(row(w, 'agent2')!.shells).toEqual([expect.objectContaining({ id: 'b2', outputPath: out('b2'), description: 'build' })])
    // With no description, the log names it by its command, cut to 80 characters.
    await bgBash($, w, 'agent2', 'b3', { auto: true, description: '', command: 'x'.repeat(100) })
    expect(await logged(w, `impl-2: background command "${'x'.repeat(80)}" (b3) started`)).toBe(true)
  })

  test("main's backgrounded call is tracked on main's row", async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await bgBash($, w, undefined, 'm1')
    expect(row(w, 'main')!.shells).toEqual([expect.objectContaining({ id: 'm1', outputPath: out('m1') })])
    expect(await logged(w, 'main thread: background command "run the tests" (m1) started')).toBe(true)
  })

  test('foreground, failed and ends-with-final-response calls are not tracked', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent2', 'Bash', { command: 'ls', description: 'list' })
    await bgBash($, w, 'agent2', 'b1', { isError: true })
    await bgBash($, w, 'agent2', 'b2', { endsWithFinal: true })
    expect(row(w, 'agent2')!.shells).toBeUndefined()
    expect(await logged(w, 'background command')).toBe(false)
  })

  test('TaskStop of a tracked shell (task_id or shell_id) drops it and logs the stop; an unknown id changes nothing', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2', { description: 'build' })
    await bgBash($, w, 'agent2', 'b3')
    await call($, 'agent2', 'TaskStop', { task_id: 'b1' })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b2', 'b3'])
    expect(await logged(w, 'impl-2: background command "run the tests" (b1) stopped (TaskStop)')).toBe(true)
    // The model's stop of its parent's shell, by the deprecated alias, still finds it.
    await call($, 'agent1', 'TaskStop', { shell_id: 'b2' })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b3'])
    expect(await logged(w, 'impl-2: background command "build" (b2) stopped (TaskStop)')).toBe(true)
    const writes = w.writes.length
    await call($, 'agent2', 'TaskStop', { task_id: 'nope' })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b3'])
    expect(w.writes.length).toBe(writes)
  })

  test('the poll records the exit code and its time from the output file and logs it', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    w.files.set(out('b1'), 'all 12 passed')
    endOutput(w, 'b1', 0)
    const t = w.clock.now() + 15_000
    await poll(w)
    const r = row(w, 'agent2')!
    expect(r.shells).toEqual([expect.objectContaining({ id: 'b1', exit: 0, endedAt: t })])
    expect(r.shellsDoneAt).toBe(t)
    expect(await logged(w, 'impl-2: background command "run the tests" (b1) exited with code 0')).toBe(true)
  })

  test('a killed marker is recorded as killed; no marker or a marker mid-file leaves it open', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2')
    await bgBash($, w, 'agent2', 'b3')
    endOutput(w, 'b1', 'killed')
    w.files.set(out('b2'), 'still working\n')
    w.files.set(out('b3'), '\n[exited with code 0]\nand more output\n')
    await poll(w)
    const shells = row(w, 'agent2')!.shells!
    expect(shells.map(s => [s.id, s.exit])).toEqual([
      ['b1', 'killed'],
      ['b2', undefined],
      ['b3', undefined],
    ])
    expect(row(w, 'agent2')!.shellsDoneAt).toBeUndefined()
    expect(await logged(w, '(b1) was killed')).toBe(true)
  })

  test('an unchanged file is not read again', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    const reads = () => w.reads.filter(p => p === out('b1')).length
    // Empty as it was backgrounded: nothing to read.
    await poll(w)
    expect(reads()).toBe(0)
    w.files.set(out('b1'), 'some output\n')
    await poll(w)
    expect(reads()).toBe(1)
    await poll(w)
    await poll(w)
    expect(reads()).toBe(1)
    endOutput(w, 'b1', 3)
    await poll(w)
    expect(reads()).toBe(2)
    expect(row(w, 'agent2')!.shells![0]!.exit).toBe(3)
    // Ended: no longer polled.
    w.files.set(out('b1'), 'changed again')
    await poll(w)
    expect(reads()).toBe(2)
  })

  test('a missing or over-4 MiB output file is not read and stays open; the poll keeps going', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2')
    await bgBash($, w, 'agent2', 'b3')
    w.files.delete(out('b1'))
    w.files.set(out('b2'), 'x'.repeat(4 * 1024 * 1024) + '\n[exited with code 0]\n')
    endOutput(w, 'b3', 0)
    await poll(w)
    expect(w.reads.filter(p => p === out('b1') || p === out('b2'))).toEqual([])
    expect(row(w, 'agent2')!.shells!.map(s => [s.id, s.exit])).toEqual([
      ['b1', undefined],
      ['b2', undefined],
      ['b3', 0],
    ])
    endOutput(w, 'b1', 2)
    await poll(w)
    expect(row(w, 'agent2')!.shells![0]!.exit).toBe(2)
  })

  test('a failed read is retried on the next poll', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    endOutput(w, 'b1', 0)
    w.readFailsOnce = true
    await poll(w)
    expect(row(w, 'agent2')!.shells![0]!.exit).toBeUndefined()
    await poll(w)
    expect(row(w, 'agent2')!.shells![0]!.exit).toBe(0)
  })

  test('shellPollSeconds 0 polls nothing', { options: { shellPollSeconds: 0 } }, async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    endOutput(w, 'b1', 0)
    await poll(w, 120_000)
    expect(w.reads.filter(p => p === out('b1'))).toEqual([])
    expect(row(w, 'agent2')!.shells![0]!.exit).toBeUndefined()
  })

  test('tracked shells survive in state.json', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2')
    endOutput(w, 'b2', 1)
    await poll(w)
    const saved = JSON.parse(w.writes.at(-1)!) as { agents: AgentRow[] }
    expect(saved.agents.find(a => a.id === 'agent2')!.shells!.map(s => [s.id, s.exit])).toEqual([
      ['b1', undefined],
      ['b2', 1],
    ])
    expect(row(w, 'agent2')!.shells).toHaveLength(2)
  })
})

describe('background shells: grace and ceiling nudges', () => {
  const ACT = `${RUN_DIR}/activity.log`
  const logged = async (w: World, text: string) => {
    await w.clock.settle()
    return (w.files.get(ACT) ?? '').includes(text)
  }
  const out = (id: string) => `${TASKS}/${id}.output`
  const poll = async (w: World, ms = 15_000) => {
    await w.clock.advance(ms)
    await w.clock.settle()
  }
  /** A turn end (main's) delivers what the timers queued. */
  const drained = async ($: Engine, w: World) => {
    await complete($, undefined)
    await w.clock.settle()
  }
  const nudges = (w: World, to = 'agent2') => w.sent.filter(m => m.to.includes(to) && m.text.includes('background command'))
  const at = (t: number) => new Date(t).toISOString().slice(11, 16)
  /** agent2 (impl-2) backgrounds `id`, ends its turn (idle), and the poll sees the command exit with `code`. */
  const idleWithEnded = async ($: Engine, w: World, id: string, code: number | 'killed' = 0) => {
    await family($, w)
    await bgBash($, w, 'agent2', id)
    await complete($, 'agent2')
    endOutput(w, id, code)
    await poll(w)
    expect(row(w, 'agent2')!.status).toBe('idle')
    expect(row(w, 'agent2')!.shells![0]!.exit).toBe(code)
    return row(w, 'agent2')!.shells![0]!.endedAt!
  }

  test('an idle agent whose last shell exited is nudged once after the grace, with the code, time and output path', async ($, on) => {
    const w = world(on)
    const t = await idleWithEnded($, w, 'b1', 0)
    await poll(w, 45_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    await poll(w, 15_000)
    // Queued, not sent: nothing reaches the agent before a turn end.
    expect(nudges(w)).toEqual([])
    await drained($, w)
    expect(nudges(w).map(m => m.text)).toEqual([
      `[orchestrator mod] your background command "run the tests" (id b1) exited with code 0 at ${at(t)} UTC and you haven't picked it up; output: ${out('b1')}`,
    ])
    expect(await logged(w, 'impl-2: nudged about finished background command(s) b1')).toBe(true)
    expect(row(w, 'agent2')!.shells).toEqual([])
    await poll(w, 300_000)
    await drained($, w)
    expect(nudges(w)).toHaveLength(1)
  })

  test('a step that starts a new run within the grace picks it up: no nudge', async ($, on) => {
    const w = world(on)
    await idleWithEnded($, w, 'b1')
    await step($, 'agent2')
    expect(row(w, 'agent2')!.shells).toEqual([])
    expect(row(w, 'agent2')!.shellsDoneAt).toBeUndefined()
    await complete($, 'agent2')
    await poll(w, 120_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
  })

  test("a busy agent's steps don't pick it up; the grace runs from its turn end", async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    endOutput(w, 'b1', 0)
    await poll(w)
    await poll(w, 30_000)
    // Still in the same run: it may not have seen the notice.
    await step($, 'agent2')
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b1'])
    await complete($, 'agent2')
    await poll(w, 45_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    await poll(w, 15_000)
    await drained($, w)
    expect(nudges(w)).toHaveLength(1)
  })

  test("a tool call naming the shell's id or output path picks it up", async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2')
    await bgBash($, w, 'agent2', 'b3')
    endOutput(w, 'b1', 0)
    endOutput(w, 'b2', 0)
    await poll(w)
    await call($, 'agent2', 'Read', { file_path: out('b1') })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b2', 'b3'])
    // Naming an open shell picks up nothing.
    await call($, 'agent2', 'TaskOutput', { task_id: 'b3' })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b2', 'b3'])
    await call($, 'agent2', 'TaskOutput', { task_id: 'b2' })
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b3'])
    expect(row(w, 'agent2')!.shellsDoneAt).toBeUndefined()
  })

  test('with another shell still open, no nudge; when that one ends too, one nudge lists both', async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await bgBash($, w, 'agent2', 'b2', { description: 'build' })
    await complete($, 'agent2')
    endOutput(w, 'b1', 0)
    await poll(w)
    await poll(w, 120_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    endOutput(w, 'b2', 2)
    await poll(w)
    const t1 = row(w, 'agent2')!.shells![0]!.endedAt!
    const t2 = row(w, 'agent2')!.shells![1]!.endedAt!
    await poll(w, 60_000)
    await drained($, w)
    expect(nudges(w).map(m => m.text)).toEqual([
      [
        "[orchestrator mod] your background commands finished and you haven't picked them up:",
        `- "run the tests" (id b1) exited with code 0 at ${at(t1)} UTC; output: ${out('b1')}`,
        `- "build" (id b2) exited with code 2 at ${at(t2)} UTC; output: ${out('b2')}`,
      ].join('\n'),
    ])
    expect(await logged(w, 'impl-2: nudged about finished background command(s) b1, b2')).toBe(true)
  })

  test("a killed shell's nudge says it was killed", async ($, on) => {
    const w = world(on)
    await idleWithEnded($, w, 'b1', 'killed')
    await poll(w, 60_000)
    await drained($, w)
    expect(nudges(w)).toHaveLength(1)
    expect(nudges(w)[0]!.text).toContain('(id b1) was killed at ')
  })

  test('main is never nudged; its finished shells are dropped at its next step', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await bgBash($, w, undefined, 'm1')
    await complete($, undefined)
    endOutput(w, 'm1', 0)
    await poll(w)
    expect(row(w, 'main')!.shells![0]!.exit).toBe(0)
    await poll(w, 300_000)
    await drained($, w)
    expect(w.sent.filter(m => m.text.includes('background command'))).toEqual([])
    expect(w.prompts.filter(p => p.includes('background command'))).toEqual([])
    await step($)
    expect(row(w, 'main')!.shells).toEqual([])
  })

  test('shellGraceSeconds 0 never nudges', { options: { shellGraceSeconds: 0 } }, async ($, on) => {
    const w = world(on)
    await idleWithEnded($, w, 'b1')
    await poll(w, 600_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    expect(row(w, 'agent2')!.shells!.map(s => s.id)).toEqual(['b1'])
  })

  test('a shell open past shellCeilingMinutes nudges its agent once', { options: { shellCeilingMinutes: 2 } }, async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await poll(w, 105_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    await poll(w, 15_000)
    expect(nudges(w)).toEqual([])
    await drained($, w)
    expect(nudges(w).map(m => m.text)).toEqual([
      `[orchestrator mod] your background command "run the tests" (id b1) is still running after 2 min; check it (e.g. a suspended process) or stop it (TaskStop). Output: ${out('b1')}`,
    ])
    expect(row(w, 'agent2')!.shells![0]!.ceilingNudged).toBe(true)
    expect(await logged(w, 'impl-2: background command "run the tests" (b1) still running after 2 min: nudged')).toBe(true)
    await poll(w, 600_000)
    await drained($, w)
    expect(nudges(w)).toHaveLength(1)
  })

  test("main's shell past the ceiling is a warning toast, not a prompt", { options: { shellCeilingMinutes: 2 } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await bgBash($, w, undefined, 'm1')
    await poll(w, 120_000)
    await drained($, w)
    const warned = (id: string) => w.toasts.filter(t => t.includes(`main thread: background command "run the tests" (${id}) still running after 2 min`))
    expect(warned('m1')).toHaveLength(1)
    expect(w.prompts.filter(p => p.includes('background command'))).toEqual([])
    expect(w.sent.filter(m => m.text.includes('background command'))).toEqual([])
    await poll(w, 600_000)
    expect(warned('m1')).toHaveLength(1)
  })

  test('shellCeilingMinutes 0 never nudges', { options: { shellCeilingMinutes: 0 } }, async ($, on) => {
    const w = world(on)
    await family($, w)
    await bgBash($, w, 'agent2', 'b1')
    await poll(w, 24 * 3_600_000)
    await drained($, w)
    expect(nudges(w)).toEqual([])
    expect(row(w, 'agent2')!.shells![0]!.ceilingNudged).toBeUndefined()
  })

  test('a nudge for an agent no longer live is dropped unsent', async ($, on) => {
    const w = world(on)
    await idleWithEnded($, w, 'b1')
    await poll(w, 60_000)
    const outbox = () => (JSON.parse(w.files.get(STATE)!) as { outbox: { text: string }[] }).outbox
    expect(outbox().some(d => d.text.includes('(id b1)'))).toBe(true)
    // The engine no longer lists it: sync marks it done before any turn end delivers.
    w.agents = [{ id: 'agent1', name: 'impl-1' }]
    await poll(w, 30_000)
    expect(row(w, 'agent2')!.status).toBe('done')
    await drained($, w)
    expect(nudges(w)).toEqual([])
  })
})
