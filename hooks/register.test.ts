import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow } from '../types'
import { PEEK_TIMEOUT_MS, liveSelection } from './register'
import { PEEK_DENIED as DENIED } from './view'

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
    /** Runs while /clear is in flight, as a turn the person starts before the restart finishes. */
    duringClear: undefined as (() => Promise<unknown>) | undefined,
    /** What `$.agent.list()` answers. */
    agents: [] as { id: string; name?: string; teammateId?: string }[],
    closed: [] as string[],
    /** The status line as last set. */
    status: undefined as string | undefined,
    /** Makes the next main turn end fail beneath the plugin, once. */
    failMainEnd: false,
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
    w.sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
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
    return { value: { isPlaced: true } }
  })
  on('turn.step', async function* ($, e) {
    const tokens = w.tokens.get(e.agentId ?? 'main') ?? 1000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokens - 10,
        output_tokens: 50,
        model: 'claude-opus-5-5',
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
  on('tool.call', () => ({ result: 'ok' }) as never)
  return Object.assign(w, { session })
}

import type { Engine } from 'claude-code/testing'

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const spawn = ($: Engine, o: { prompt: string; name?: string; parentAgentId?: string }) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: o.prompt,
    description: 'implement task',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    name: o.name,
    parentAgentId: o.parentAgentId,
    background: true,
    fork: false,
  } as never)

const step = async ($: Engine, agentId?: string) => {
  const s = $.turn.step({ turnId: 'T', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId })
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
  /** Each terminal row's name cell (a Text keeps no key, so it is found as the first child of the row's Box). */
  const names = async (ui: Awaited<ReturnType<typeof mountViewed>>) =>
    new Map(
      walk(await ui.drawn())
        .filter(b => b.type === 'Box' && typeof b.props?.key === 'string' && /^(main|agent\d+)$/.test(b.props.key as string))
        .map(b => {
          // A subagent's name cell sits inside its pressable Button; main's is the bare Text.
          const first = b.children![0] as Drawn
          const cell = first.type === 'Button' ? (first.children![0] as Drawn) : first
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
      expect(await ui.find({ key: 'peek:agent1' })).toBeUndefined()
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      const peek = (await ui.find({ key: 'peek:agent1' }))!
      expect(peek).toBeDefined()
      expect(peek.text).toContain('Tests are red, as expected')
      expect(peek.text).toContain('⚙ Read, Bash×2 · Reading the plan')
      expect(asked).toContain('agent1')
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect(await ui.find({ key: 'peek:agent1' })).toBeUndefined()
      await ui.unmount()
    })

    test(`a transcript the session cannot read says so (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: { deny: 'agent1 runs in another process' } }))
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain(DENIED)
      await ui.unmount()
    })

    test(`an empty transcript says there is nothing yet (${surface})`, async ($, on) => {
      const w = world(on)
      on('session.messages', () => ({ value: [] }))
      await running($, w)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'agent:agent1' })
      await w.clock.settle() // the read runs off the render
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain('no messages yet')
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
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain(DENIED)
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
      const box = walk(await ui.drawn()).find(b => b.type === 'Box' && b.props?.key === 'peek:agent1')!
      const lines = walk(box).filter(b => b.type === 'Text')
      expect(lines).toHaveLength(1)
      expect(lines[0]!.props?.wrap).toBe('truncate')
      await ui.unmount()
    })
  }

  test('terminal: main has no transcript button', async ($, on) => {
    const w = world(on)
    await running($, w)
    await step($)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'agent:agent1' })).toBeDefined()
    expect(await ui.find({ key: 'agent:main' })).toBeUndefined()
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
    expect(await ui.find({ key: 'peek:main' })).toBeUndefined()
    expect(asked).toBe(0)
    await ui.unmount()
  })

  test('terminal: an open transcript takes its rows from the activity', async ($, on) => {
    const w = world(on)
    on('session.messages', () => ({ value: transcript as never }))
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
    expect(await activity()).toBe(ROOM - (3 + 2)) // three message lines inside a border
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
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain('loading…')
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
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain('loading…')
      h.release()
      await w.clock.settle()
      const peek = (await ui.find({ key: 'peek:agent1' }))!.text
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
      expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain(DENIED)
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
    expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain(DENIED)
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
    const text = (await ui.find({ key: 'peek:agent1' }))!.text
    expect(text).toContain('yyy')
    expect(text.length).toBeLessThanOrEqual(500)
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
    expect((await ui.find({ key: 'peek:agent1' }))!.text).toContain('second')
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
    const text = (await ui.find({ key: 'peek:agent1' }))!.text
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
    const text = (await ui.find({ key: 'peek:agent1' }))!.text
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
