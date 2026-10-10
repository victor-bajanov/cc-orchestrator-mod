import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow } from '../types'

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
  }
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }))
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
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
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
  on('turn.complete', ($, e) => ({ text: e.answer }))
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

  test('in ask mode offers a button above the prompt instead of acting', { options: { mainThreshold: 100_000 } }, async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens.set('main', 150_000)
    await step($)
    await complete($, undefined)
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(0)
    expect(phase(w)).toBe('offered')

    const ui = await $.ui.mount({ plugin: 'orchestrator', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
    await ui.press({ key: 'handover' })
    await w.clock.advance(10)
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('main-1.md')
  })

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
