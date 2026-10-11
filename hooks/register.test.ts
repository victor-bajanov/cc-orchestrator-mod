import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow } from '../types'
import { PEEK_TIMEOUT_MS, liveSelection } from './register'
import { hhmm } from './view'
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
    agents: [] as { id: string; name?: string; teammateId?: string }[],
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
  }
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: w.agents as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.send', ($, e) => {
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
  on('agent.spawn', ($, e) => {
    const raw = e as typeof e & { subagent_type?: string }
    w.spawns.push({ ...e, subagentType: e.subagentType ?? raw.subagent_type ?? '' })
    return { model: 'opus', agentId: `agent${w.spawns.length}` }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status = e.text
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
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
  on('tool.call', ($, e) => (w.toolAnswer?.(e as never) ?? { result: 'ok' }) as never)
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

  test('a truncated activity line shows its full text in a card on hover, pinned by a click', async ($, on) => {
    const w = world(on)
    await start($)
    const name = 'a-rather-long-agent-name-that-will-not-fit-in-a-narrow-pane'
    await spawn($, { prompt: 'P', name })
    const ui = await $.ui.mount({
      plugin: 'orchestrator',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'orchestrator',
      props: { bodyColumns: 40 } as never,
    })
    const line = (await ui.findAll({ type: 'Button' })).find(b => b.text.includes('spawned'))!
    expect(line).toBeDefined()
    expect(line.text).toContain('…')
    expect(line.text).not.toContain(name)

    type Drawn = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Drawn[] =>
      n && typeof n === 'object' ? [n as Drawn, ...((n as Drawn).children ?? []).flatMap(walk)] : []
    const card = async () =>
      walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.position === 'absolute' && JSON.stringify(b.children).includes('spawned'))!

    expect((await card()).props!.display).toBe('none')
    expect((await card()).hover).toMatchObject({ display: 'flex' })
    // it overlays other lines: every cell inside the border is painted, so nothing shows through
    const rowsOf = JSON.stringify((await card()).children).match(/"[^"]*"/g)!.map(t => JSON.parse(t) as string)
    const painted = rowsOf.filter(t => t.length > 10)
    expect(painted.length).toBeGreaterThan(1)
    expect(new Set(painted.map(t => t.length)).size).toBe(1)
    expect((await card()).props!.paddingX).toBeUndefined()

    await ui.press({ key: line.key! })
    expect((await card()).props!.display).toBe('flex')
    await ui.press({ key: line.key! })
    expect((await card()).props!.display).toBe('none')
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
          const first = b.children![0] as Drawn
          const cell = first.type === 'Button' ? (first.children![1] as Drawn) : (b.children![1] as Drawn)
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

  test('terminal: a long text is cut, and its card shows on hover, pinned by a press', async ($, on) => {
    const w = world(on)
    longStub(on)
    await running($, w)
    const ui = await open($, w, 'terminal', 80)
    const button = await stepButton(ui)
    expect(button).toBeDefined()
    expect(button.text).toContain('…')
    expect(button.text).not.toContain('END')
    const card = async () =>
      walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.position === 'absolute' && JSON.stringify(b.children).includes('END'))!
    expect((await card()).props!.display).toBe('none')
    expect((await card()).hover).toMatchObject({ display: 'flex' })
    await ui.press({ key: button.key! })
    expect((await card()).props!.display).toBe('flex')
    await ui.press({ key: button.key! })
    expect((await card()).props!.display).toBe('none')
    await ui.unmount()
  })

  test('terminal: a long text card opens downward inside the border, its lines capped to the room', async ($, on) => {
    const w = world(on)
    const HUGE = `${'word '.repeat(390)}END`
    on('session.messages', () => ({ value: [brief, { role: 'assistant', text: HUGE, toolUses: [] }] as never }))
    await running($, w)
    const ui = await open($, w, 'terminal', 40)
    const card = walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.position === 'absolute' && JSON.stringify(b.children).includes('word'))!
    expect(card.props!.top as number).toBeGreaterThanOrEqual(0)
    expect(card.props!.left).toBe(-1)
    const lines = (card.children as Drawn[]).filter(c => c.type === 'Text')
    // 30 rows (no viewport given): far fewer than the ~55 lines the text wraps to.
    expect(lines.length).toBeLessThan(30)
    expect(JSON.stringify(lines[lines.length - 1]!.children)).toContain('…')
    expect(JSON.stringify(card.children)).not.toContain('END')
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
        // glyph and name, mark included, still fill exactly the NAME columns
        const NAME = Math.min(24, Math.max(12, Math.floor(100 * 0.25)))
        const button = walk(await ui.drawn()).find(b => b.props?.key === 'agent:agent1')!
        expect(textOf(button)).toHaveLength(NAME)
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

describe('check-in', () => {
  const MIN = 60_000
  const CHECKIN = 'mcp__orchestrator__checkin'
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
    await w.clock.advance(29 * MIN)
    expect(checkins(w)).toHaveLength(0)
    await w.clock.advance(MIN + 30_000)
    expect(checkins(w)).toHaveLength(1)
    expect(checkins(w)[0]!.text).toContain('impl-2')
    expect(checkins(w)[0]!.text).toContain('30 min')
    expect(row(w, 'agent2')!.checkinAt).toBeUndefined()
    await w.clock.advance(30_000)
    expect(checkins(w)).toHaveLength(1)
  })

  for (const to of ['agent1', 'impl-1']) {
    test(`the child's SendMessage to its parent (${to}) disarms it and records the report`, async ($, on) => {
      const w = world(on)
      await family($, w)
      await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
      await call($, 'agent2', 'SendMessage', { to, message: 'done: all green' })
      expect(row(w, 'agent2')!.report).toEqual(expect.objectContaining({ text: 'done: all green', ok: true, final: true }))
      await w.clock.advance(31 * MIN)
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
    await w.clock.advance(31 * MIN)
    expect(checkins(w)).toHaveLength(1)
  })

  test("a SendMessage to someone else leaves it armed", async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await call($, 'agent2', 'SendMessage', { to: 'impl-9', message: 'hi' })
    expect(row(w, 'agent2')!.report).toBeUndefined()
    await w.clock.advance(31 * MIN)
    expect(checkins(w)).toHaveLength(1)
  })

  test("the child's turn ending disarms it", async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'agent2', minutes: 30 })
    await complete($, 'agent2', 'R')
    await w.clock.advance(31 * MIN)
    expect(checkins(w)).toHaveLength(0)
  })

  test('calling again re-arms; minutes 0 cancels; an unknown agent is refused and changes nothing', async ($, on) => {
    const w = world(on)
    await family($, w)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 10 })
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 40 })
    await w.clock.advance(11 * MIN)
    expect(checkins(w)).toHaveLength(0)
    await w.clock.advance(30 * MIN)
    expect(checkins(w)).toHaveLength(1)
    await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 5 })
    const cancel = await call($, 'agent1', CHECKIN, { agent: 'impl-2', minutes: 0 })
    expect(String(cancel.result)).toContain('cancel')
    await w.clock.advance(6 * MIN)
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
    await w.clock.advance(6 * MIN)
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
    await w.clock.advance(31 * 60_000)
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
    await w.clock.advance(31 * MIN)
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
    await w.clock.advance(6 * MIN)
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
    await w.clock.advance(31 * MIN)
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
  /** agent1 orchestrating under main: agent2 and agent3 done, agent4 running. */
  const crew = async ($: Engine, w: World) => {
    await running($, w)
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
  const double = async (ui: Ui, id: string) => {
    await ui.press({ key: `agent:${id}` })
    await ui.press({ key: `agent:${id}` })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a double-click collapses finished descendants, and another expands them (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      await double(ui, 'agent1')
      await w.clock.settle()
      expect(await drawn(ui, surface, 'agent2')).toBe(false)
      expect(await drawn(ui, surface, 'agent3')).toBe(false)
      expect(await drawn(ui, surface, 'agent4')).toBe(true)
      expect(await rowText(ui, surface, 'agent1')).toContain('+2 done')
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      if (surface === 'desktop') {
        const src = String((await ui.find({ type: 'Svg' }))!.props.source)
        expect(src).not.toContain('stroke="#E69F00"')
        expect(src).not.toContain('stroke="#009E73"')
        expect(src).toContain('stroke="#CC79A7"')
      }
      await double(ui, 'agent1')
      expect(await drawn(ui, surface, 'agent2')).toBe(true)
      expect(await drawn(ui, surface, 'agent3')).toBe(true)
      expect(await rowText(ui, surface, 'agent1')).not.toContain('+2 done')
      await ui.unmount()
    })

    test(`two presses 500 ms apart are two single clicks (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle()
      expect(await ui.find({ key: 'transcript:agent1' })).toBeDefined()
      await w.clock.advance(500)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle()
      expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
      expect(await drawn(ui, surface, 'agent2')).toBe(true)
      await ui.unmount()
    })

    test(`a double-click keeps the transcript that was open; on a childless row it does nothing (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await crew($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent4' })
      await w.clock.advance(1000)
      await double(ui, 'agent1')
      await w.clock.settle()
      expect(await drawn(ui, surface, 'agent2')).toBe(false)
      expect(await ui.find({ key: 'transcript:agent4' })).toBeDefined()
      await w.clock.advance(1000)
      await double(ui, 'agent4')
      await w.clock.settle()
      expect(await ui.find({ key: 'transcript:agent4' })).toBeDefined()
      expect(await drawn(ui, surface, 'agent4')).toBe(true)
      await ui.unmount()
    })

    test(`main collapses its finished top-level agents and keeps a running one (${surface})`, async ($, on) => {
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
      await double(ui, 'main')
      for (const n of [1, 2, 3, 4]) expect(await drawn(ui, surface, `agent${n}`)).toBe(false)
      expect(await drawn(ui, surface, 'agent5')).toBe(true)
      expect(await rowText(ui, surface, 'main')).toContain('+4 done')
      await ui.unmount()
    })

    test(`a collapsed row counts a child that finishes later (${surface})`, async ($, on) => {
      const w = world(on)
      await crew($, w)
      const ui = await mountPane($, surface)
      await double(ui, 'agent1')
      await complete($, 'agent4', 'R4')
      w.agents = [{ id: 'agent1', name: 'impl-1' }]
      await w.clock.advance(30_000)
      expect(await rowText(ui, surface, 'agent1')).toContain('+3 done')
      expect(await drawn(ui, surface, 'agent4')).toBe(false)
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
    await double(ui, 'agent3')
    expect(await drawn(ui, 'terminal', 'agent4')).toBe(false)
    const button = walk(await ui.drawn()).find(b => b.props?.key === 'agent:agent3')!
    const name = textOf((button.children as Drawn[])[1])
    expect(name).toContain('impl')
    // glyph and name still fill exactly the NAME columns
    expect(textOf(button)).toHaveLength(12)
    await ui.unmount()
  })

  test('two presses dispatched together still count as a double-click', async ($, on) => {
    const w = world(on)
    await crew($, w)
    const ui = await mountPane($, 'desktop')
    await Promise.all([ui.press({ key: 'agent:agent1' }), ui.press({ key: 'agent:agent1' })])
    await w.clock.settle()
    expect(await ui.find({ key: 'agent:agent2' })).toBeUndefined()
    expect(await ui.find({ key: 'transcript:agent1' })).toBeUndefined()
    await ui.unmount()
  })

  test('collapse is display only and persists across a remount', async ($, on) => {
    const w = world(on)
    await crew($, w)
    let ui = await mountPane($, 'desktop')
    const header = (await ui.findAll({ type: 'Text' })).find(t => t.text.includes('live'))!.text
    await double(ui, 'agent1')
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
