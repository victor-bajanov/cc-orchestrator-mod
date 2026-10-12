import { describe, expect, test } from 'claude-code/testing'

import {
  ACTIVITY_MAX,
  activityLine,
  MAX_SAMPLES,
  adoptChildren,
  contextOf,
  crossed,
  fmtTokens,
  level,
  notePathFor,
  orderRows,
  recordStep,
  nameNotice,
  replacementPrompt,
  resumePrompt,
  rosterMarkdown,
  sparkline,
  timeline,
  handoverMessage,
  briefPathFor,
  respawnFailedNotice,
  wrapFill,
  numberSetting,
  OUTPUT_PATH,
  backgroundedShell,
  shellExit,
  shellEndWords,
  openShells,
  addShell,
  endShell,
  dropShell,
  pickUpShells,
  graceDue,
  shellNudge,
  ceilingDue,
  markCeiling,
  ceilingNudge,
  goneShells,
  watchdogNudge,
} from './core'
import type { AgentRow, Shell } from '../types'

const row = (over: Partial<AgentRow>): AgentRow => ({
  id: 'a1',
  description: 'implement task 1',
  type: 'general-purpose',
  status: 'running',
  tokens: 0,
  peak: 0,
  samples: [],
  steps: 0,
  tools: 0,
  startedAt: 0,
  lastActive: 0,
  ...over,
})

describe('contextOf', () => {
  test('sums uncached, cache-written and cache-read input', () => {
    expect(
      contextOf({
        input_tokens: 10,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
        output_tokens: 99,
      }),
    ).toBe(3210)
  })
  test('treats missing fields as zero', () => {
    expect(contextOf({ input_tokens: 5, output_tokens: 1 })).toBe(5)
  })
})

describe('recordStep', () => {
  test('creates a row for an agent it has not seen', () => {
    const rows = recordStep([], { id: 'x', tokens: 1000, t: 5, tools: 2 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!).toEqual(
      expect.objectContaining({ id: 'x', tokens: 1000, peak: 1000, steps: 1, tools: 2, status: 'running' }),
    )
    expect(rows[0]!.samples).toEqual([{ t: 5, tokens: 1000 }])
  })
  test('updates tokens, peak, steps and samples of a known agent', () => {
    let rows = recordStep([], { id: 'x', tokens: 1000, t: 5, tools: 1 })
    rows = recordStep(rows, { id: 'x', tokens: 800, t: 9, tools: 1 })
    expect(rows[0]!).toEqual(expect.objectContaining({ tokens: 800, peak: 1000, steps: 2, tools: 2, lastActive: 9 }))
    expect(rows[0]!.samples).toHaveLength(2)
  })
  test('wakes an idle agent back to running', () => {
    const rows = recordStep([row({ id: 'x', status: 'idle' })], { id: 'x', tokens: 1, t: 1, tools: 0 })
    expect(rows[0]!.status).toBe('running')
    expect(rows[0]!.resumedAt).toBeUndefined()
  })
  test('revives a done agent resumed by a message, noting when', () => {
    const rows = recordStep([row({ id: 'x', status: 'done' })], { id: 'x', tokens: 1, t: 42, tools: 0 })
    expect(rows[0]!.status).toBe('running')
    expect(rows[0]!.resumedAt).toBe(42)
  })
  test('a step revives a respawn-failed row as running, marked resumed', () => {
    const rows = recordStep([row({ id: 'x', status: 'respawn-failed' })], { id: 'x', tokens: 1, t: 42, tools: 0 })
    expect(rows[0]!.status).toBe('running')
    expect(rows[0]!.resumedAt).toBe(42)
  })
  test('leaves replaced, handing-over and stalled rows as they are', () => {
    for (const status of ['replaced', 'handing-over', 'stalled'] as const) {
      const rows = recordStep([row({ id: 'x', status })], { id: 'x', tokens: 1, t: 42, tools: 0 })
      expect(rows[0]!.status).toBe(status)
      expect(rows[0]!.resumedAt).toBeUndefined()
    }
  })
  test('keeps at most MAX_SAMPLES samples, first and last kept', () => {
    let rows: AgentRow[] = []
    for (let i = 0; i < MAX_SAMPLES * 3; i++) rows = recordStep(rows, { id: 'x', tokens: i, t: i, tools: 0 })
    const s = rows[0]!.samples
    expect(s.length <= MAX_SAMPLES).toBe(true)
    expect(s[0]!.t).toBe(0)
    expect(s[s.length - 1]!.t).toBe(MAX_SAMPLES * 3 - 1)
  })
})

describe('crossed', () => {
  test('names live subagents at or past the threshold, never main or settled ones', () => {
    const rows = [
      row({ id: 'main', tokens: 900 }),
      row({ id: 'a', tokens: 500 }),
      row({ id: 'b', tokens: 400 }),
      row({ id: 'c', tokens: 600, status: 'handing-over' }),
      row({ id: 'd', tokens: 600, status: 'replaced' }),
      row({ id: 'e', tokens: 700, status: 'idle' }),
    ]
    expect(crossed(rows, 450).map(r => r.id)).toEqual(['a', 'e'])
  })
})

describe('level', () => {
  test('is ok under 60% of the threshold, warn under it, hot at or past it', () => {
    expect(level(50, 100)).toBe('ok')
    expect(level(75, 100)).toBe('warn')
    expect(level(100, 100)).toBe('hot')
  })
})

describe('fmtTokens', () => {
  test('abbreviates', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(312_345)).toBe('312k')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
  })
})

describe('sparkline', () => {
  test('one block per bucket, scaled to the ceiling', () => {
    const samples = [0, 25, 50, 100].map((tokens, t) => ({ t, tokens }))
    expect(sparkline(samples, 4, 100)).toBe('▁▃▅█')
  })
  test('takes the max of each bucket when there are more samples than columns', () => {
    const samples = [0, 100, 0, 0].map((tokens, t) => ({ t, tokens }))
    expect(sparkline(samples, 2, 100)).toBe('█▁')
  })
  test('is empty with no samples and clamps above the ceiling', () => {
    expect(sparkline([], 5, 100)).toBe('')
    expect(sparkline([{ t: 0, tokens: 500 }], 5, 100)).toBe('█')
  })
})

describe('orderRows', () => {
  test('main first, then a depth-first tree by parent, spawn order kept', () => {
    const rows = [
      row({ id: 'main' }),
      row({ id: 'orch', startedAt: 1 }),
      row({ id: 'impl', parentId: 'orch', startedAt: 2 }),
      row({ id: 'rev', parentId: 'impl', startedAt: 3 }),
      row({ id: 'plan', parentId: 'orch', startedAt: 4 }),
      row({ id: 'orphan', parentId: 'gone', startedAt: 5 }),
    ]
    expect(orderRows(rows).map(r => `${r.depth}:${r.row.id}`)).toEqual([
      '0:main',
      '0:orch',
      '1:impl',
      '2:rev',
      '1:plan',
      '0:orphan',
    ])
  })
})

describe('notePathFor', () => {
  test('slugs the name under the run dir, numbered by attempt', () => {
    expect(notePathFor('/r', row({ id: 'abc', name: 'Impl Task#1' }), 2)).toBe('/r/handover/impl-task-1-abc-2.md')
    expect(notePathFor('/r', row({ id: 'abc' }), 1)).toBe('/r/handover/agent-abc-1.md')
  })
})

describe('prompts', () => {
  test('nameNotice names the registered and the requested name', () => {
    expect(nameNotice('orchestrator-2', 'orchestrator')).toBe(
      '[orchestrator mod] You are registered as `orchestrator-2` (you asked for `orchestrator`); tell your children to SendMessage `orchestrator-2`.',
    )
  })
  test('a replacement keeps the original brief and points at the note', () => {
    const p = replacementPrompt({ prompt: 'Do X.', subagentType: 'general-purpose', description: 'x' }, '/n.md')
    expect(p.startsWith('Do X.')).toBe(true)
    expect(p).toContain('/n.md')
  })
  test('the resume prompt carries the note and the live agents', () => {
    const p = resumePrompt({
      note: 'NOTE BODY',
      notePath: '/m.md',
      rosterPath: '/roster.md',
      agents: [row({ id: 'a', name: 'orchestrator', tokens: 120_000 })],
    })
    expect(p).toContain('NOTE BODY')
    expect(p).toContain('/roster.md')
    expect(p).toContain('orchestrator')
    expect(p).toContain('a')
  })
  test('the roster lists every agent with its status and note', () => {
    const md = rosterMarkdown([
      row({ id: 'a', name: 'impl', status: 'replaced', notePath: '/n.md', replacedBy: 'b' }),
      row({ id: 'b', name: 'impl', replaces: 'a' }),
    ])
    expect(md).toContain('| impl | a |')
    expect(md).toContain('replaced')
    expect(md).toContain('/n.md')
  })
})

describe('timeline', () => {
  const ceiling = 100
  test('places an agent on the shared time axis, blank outside its life', () => {
    // axis 0..100 over 10 columns; agent lives 30..60
    const samples = [
      { t: 30, tokens: 25 },
      { t: 60, tokens: 100 },
    ]
    expect(timeline(samples, 10, 0, 100, ceiling)).toBe('   ▃▃▃█   ')
  })
  test('carries the last reading forward between samples', () => {
    const samples = [
      { t: 0, tokens: 50 },
      { t: 90, tokens: 50 },
    ]
    expect(timeline(samples, 10, 0, 100, ceiling)).toBe('▅▅▅▅▅▅▅▅▅▅'.slice(0, 10))
  })
  test('runs to the end of the axis while the agent is live', () => {
    const samples = [{ t: 50, tokens: 100 }]
    expect(timeline(samples, 10, 0, 100, ceiling, true)).toBe('     █████')
    expect(timeline(samples, 10, 0, 100, ceiling, false)).toBe('     █    ')
  })
  test('is all blank with no samples', () => {
    expect(timeline([], 4, 0, 100, ceiling)).toBe('    ')
  })
})

describe('handoverMessage', () => {
  test('tells the agent the mod will spawn its replacement, without claiming it has', () => {
    const m = handoverMessage('/n.md', true)
    expect(m).toContain('HANDOVER')
    expect(m).toContain('/n.md')
    expect(m).toContain('no action needed')
    expect(m).toContain('will spawn the replacement')
    expect(m).not.toContain('has spawned')
  })
  test('tells the parent to respawn when the mod does not', () => {
    expect(handoverMessage('/n.md', false)).toContain('spawn a replacement')
  })
})

describe('respawnFailedNotice', () => {
  const brief = { prompt: 'P', subagentType: 'general-purpose', description: 'impl', model: 'opus', name: 'impl-2' }
  test('names the note, the brief file and how to spawn', () => {
    const t = respawnFailedNotice({ label: 'impl-2', id: 'agent2', notePath: '/n.md', reason: 'nope', brief, briefPath: '/r/h/impl-2-agent2-1.brief.md' })
    for (const s of ['no replacement started: nope', 'note at /n.md', 'name "impl-2"', 'subagent_type "general-purpose"', 'model "opus"', '/r/h/impl-2-agent2-1.brief.md'])
      expect(t).toContain(s)
  })
  test('with no brief file, it quotes the start line', () => {
    const t = respawnFailedNotice({ label: 'impl-2', id: 'agent2', notePath: '/n.md', reason: 'nope', brief })
    expect(t).toContain('Start from the handover note at /n.md')
  })
  test('with no brief, it says so', () => {
    const t = respawnFailedNotice({ label: 'x', id: 'agent9', notePath: '/n.md', reason: 'no brief recorded' })
    expect(t).toContain('No brief was recorded')
  })
  test('briefPathFor', () => {
    expect(briefPathFor('/r/h/x-1.md')).toBe('/r/h/x-1.brief.md')
  })
})

describe('wrapFill', () => {
  test('wraps at word breaks and pads every line to the full width', () => {
    expect(wrapFill('probe2 handed over to the next one', 12)).toEqual(['probe2      ', 'handed over ', 'to the next ', 'one         '])
  })
  test('hard-breaks a word longer than the width', () => {
    expect(wrapFill('/a/very/long/path ok', 8)).toEqual(['/a/very/', 'long/pat', 'h ok    '])
  })
})

describe('adoptChildren', () => {
  test("moves only the old agent's children and never the replacement itself", () => {
    const rows = [
      row({ id: 'old', parentId: 'main' }),
      row({ id: 'new', parentId: 'old' }),
      row({ id: 'c1', parentId: 'old' }),
      row({ id: 'c2', parentId: 'other' }),
    ]
    const out = adoptChildren(rows, 'old', 'new')
    expect(out.map(r => r.parentId)).toEqual(['main', 'old', 'new', 'other'])
  })
})

describe('activityLine', () => {
  test('a warn line: UTC time, WARN, newlines folded', () => {
    expect(activityLine(Date.UTC(2026, 9, 12, 10, 0, 0), 'warn', 'a\nb')).toBe('2026-10-12T10:00:00.000Z WARN a ⏎ b')
  })

  test('the info level prints info', () => {
    expect(activityLine(Date.UTC(2026, 9, 12, 10, 0, 0), 'info', 'x\r\ny')).toBe('2026-10-12T10:00:00.000Z info x ⏎ y')
    expect(ACTIVITY_MAX).toBe(2000)
  })
})

// ---- background shells

const shell = (over: Partial<Shell>): Shell => ({
  id: 'b1',
  outputPath: '/t/b1.output',
  description: 'run the tests',
  command: 'npm test',
  startedAt: 0,
  ...over,
})

describe('numberSetting', () => {
  test('defaults, 0 kept, negatives and junk fall back', () => {
    expect(numberSetting(undefined, 15)).toBe(15)
    expect(numberSetting(null, 15)).toBe(15)
    expect(numberSetting(30, 15)).toBe(30)
    expect(numberSetting('45', 15)).toBe(45)
    expect(numberSetting(0, 15)).toBe(0)
    expect(numberSetting(-1, 15)).toBe(15)
    expect(numberSetting('soon', 15)).toBe(15)
    expect(numberSetting(Infinity, 15)).toBe(15)
  })
})

describe('backgroundedShell', () => {
  const text = (id: string) => `Command running in background with ID: ${id}. Output is being written to: /t/${id}.output. Check it later.`
  test('explicit, auto-background, missing path, foreground, error, ends with final response', () => {
    expect(backgroundedShell({ result: { backgroundTaskId: 'b1' }, text: text('b1') })).toEqual({ id: 'b1', outputPath: '/t/b1.output' })
    const auto = 'Command did not complete within its 3s timeout and was moved to the background with ID: b2. Output is being written to: /t/b2.output.'
    expect(backgroundedShell({ result: { backgroundTaskId: 'b2', timedOutAfterMs: 3000 }, text: auto })).toEqual({ id: 'b2', outputPath: '/t/b2.output' })
    expect(backgroundedShell({ result: { backgroundTaskId: 'b3' }, text: 'moved to the background' })).toEqual({ id: 'b3', outputPath: '' })
    expect(backgroundedShell({ result: { backgroundTaskId: 'b3' } })).toEqual({ id: 'b3', outputPath: '' })
    expect(backgroundedShell({ result: { stdout: 'ok', stderr: '' }, text: 'ok' })).toBeUndefined()
    expect(backgroundedShell({ result: { backgroundTaskId: '' }, text: text('b4') })).toBeUndefined()
    expect(backgroundedShell({ result: { backgroundTaskId: 'b5' }, text: text('b5'), isError: true })).toBeUndefined()
    expect(backgroundedShell({ deny: 'no', result: { backgroundTaskId: 'b6' } })).toBeUndefined()
    expect(backgroundedShell({ result: { backgroundTaskId: 'b7', backgroundEndsWithFinalResponse: true }, text: text('b7') })).toBeUndefined()
    expect(backgroundedShell(undefined)).toBeUndefined()
    expect(backgroundedShell('text')).toBeUndefined()
    expect(OUTPUT_PATH.exec(text('b8'))?.[1]).toBe('/t/b8.output')
  })

  test('an output path with spaces is parsed whole', () => {
    const path = '/Users/a b/tmp/claude-501/-my project/S1/tasks/b9.output'
    const moved = `Command did not complete within its 3s timeout and was moved to the background with ID: b9. Output is being written to: ${path}. You will be notified when it completes.`
    const running = `Command running in background with ID: b9. Output is being written to: ${path}.`
    expect(backgroundedShell({ result: { backgroundTaskId: 'b9' }, text: moved })).toEqual({ id: 'b9', outputPath: path })
    expect(backgroundedShell({ result: { backgroundTaskId: 'b9' }, text: running })).toEqual({ id: 'b9', outputPath: path })
  })
})

describe('shellExit', () => {
  test('0, 137, killed, none, marker not at EOF, empty file, marker only', () => {
    expect(shellExit('done\n\n[exited with code 0]\n')).toBe(0)
    expect(shellExit('x'.repeat(5000) + '\n[exited with code 137]\n')).toBe(137)
    expect(shellExit('partial\n[killed]\n')).toBe('killed')
    expect(shellExit('still going\n')).toBeUndefined()
    expect(shellExit('\n[exited with code 0]\nmore output\n')).toBeUndefined()
    expect(shellExit('')).toBeUndefined()
    expect(shellExit('\n[exited with code 2]\n')).toBe(2)
  })
})

describe('shellEndWords', () => {
  test('a code, killed, unknown', () => {
    expect(shellEndWords(0)).toBe('exited with code 0')
    expect(shellEndWords(137)).toBe('exited with code 137')
    expect(shellEndWords('killed')).toBe('was killed')
    expect(shellEndWords('unknown')).toBe('finished (exit code unknown)')
  })
})

describe('shell rows', () => {
  test('addShell replaces by id and clears watchdog; unknown agent unchanged', () => {
    const rows = [row({ id: 'a1', watchdog: { t: 5, ends: 1 } }), row({ id: 'a2' })]
    const once = addShell(rows, 'a1', shell({ id: 'b1', command: 'one' }))
    expect(once[0]?.shells?.map(s => s.command)).toEqual(['one'])
    expect(once[0]?.watchdog).toBeUndefined()
    expect(once[1]).toBe(rows[1])
    const twice = addShell(once, 'a1', shell({ id: 'b1', command: 'two' }))
    expect(twice[0]?.shells?.map(s => s.command)).toEqual(['two'])
    expect(addShell(twice, 'a1', shell({ id: 'b2' }))[0]?.shells?.map(s => s.id)).toEqual(['b1', 'b2'])
    expect(addShell(rows, 'nobody', shell({}))).toBe(rows)
  })

  test('openShells lists the shells with no exit', () => {
    const r = row({ shells: [shell({ id: 'b1' }), shell({ id: 'b2', exit: 0, endedAt: 3 })] })
    expect(openShells(r).map(s => s.id)).toEqual(['b1'])
    expect(openShells(row({}))).toEqual([])
  })

  test('endShell sets exit once and shellsDoneAt only when the last open ends', () => {
    const rows = [row({ id: 'a1', shells: [shell({ id: 'b1' }), shell({ id: 'b2' })] })]
    const one = endShell(rows, 'b1', 0, 100)
    expect(one[0]?.shells?.[0]).toMatchObject({ exit: 0, endedAt: 100 })
    expect(one[0]?.shellsDoneAt).toBeUndefined()
    const again = endShell(one, 'b1', 'killed', 150)
    expect(again[0]?.shells?.[0]).toMatchObject({ exit: 0, endedAt: 100 })
    const both = endShell(again, 'b2', 'killed', 200)
    expect(both[0]?.shells?.[1]).toMatchObject({ exit: 'killed', endedAt: 200 })
    expect(both[0]?.shellsDoneAt).toBe(200)
    expect(endShell(both, 'nope', 1, 300)).toEqual(both)
  })

  test('dropShell of the last open shell sets shellsDoneAt from the finished ones', () => {
    const rows = [
      row({
        id: 'a1',
        status: 'idle',
        shells: [shell({ id: 'b1' }), shell({ id: 'b2', exit: 0, endedAt: 7 }), shell({ id: 'b3', exit: 1, endedAt: 9 })],
      }),
    ]
    const out = dropShell(rows, 'b1')
    expect(out[0]?.shells?.map(s => s.id)).toEqual(['b2', 'b3'])
    expect(out[0]?.shellsDoneAt).toBe(9)
    expect(graceDue(out, 9 + 60, 60).map(r => r.id)).toEqual(['a1'])
  })

  test('dropShell removes it from any row and clears shellsDoneAt with no finished shell left', () => {
    const rows = [
      row({ id: 'a1', shells: [shell({ id: 'b1', exit: 0, endedAt: 5 })], shellsDoneAt: 5 }),
      row({ id: 'a2', shells: [shell({ id: 'b2' }), shell({ id: 'b3', exit: 1, endedAt: 6 })], shellsDoneAt: 6 }),
    ]
    const out = dropShell(rows, 'b1')
    expect(out[0]?.shells).toEqual([])
    expect(out[0]?.shellsDoneAt).toBeUndefined()
    const kept = dropShell(rows, 'b2')
    expect(kept[1]?.shells?.map(s => s.id)).toEqual(['b3'])
    expect(kept[1]?.shellsDoneAt).toBe(6)
  })

  test('pickUpShells all vs mention by id or path', () => {
    const rows = [
      row({
        id: 'a1',
        shellsDoneAt: 9,
        shells: [
          shell({ id: 'b1', outputPath: '/t/b1.output', exit: 0, endedAt: 5 }),
          shell({ id: 'b2', outputPath: '/t/x.output', exit: 0, endedAt: 9 }),
          shell({ id: 'b3', outputPath: '' }),
        ],
      }),
      row({ id: 'a2', shells: [shell({ id: 'b9', exit: 0 })], shellsDoneAt: 1 }),
    ]
    const all = pickUpShells(rows, 'a1')
    expect(all[0]?.shells?.map(s => s.id)).toEqual(['b3'])
    expect(all[0]?.shellsDoneAt).toBeUndefined()
    expect(all[1]).toBe(rows[1])
    const byId = pickUpShells(rows, 'a1', '{"command":"cat b1 log"}')
    expect(byId[0]?.shells?.map(s => s.id)).toEqual(['b2', 'b3'])
    expect(byId[0]?.shellsDoneAt).toBe(9)
    const byPath = pickUpShells(rows, 'a1', '{"file_path":"/t/x.output"}')
    expect(byPath[0]?.shells?.map(s => s.id)).toEqual(['b1', 'b3'])
    const none = pickUpShells(rows, 'a1', 'nothing here, not even b3')
    expect(none[0]?.shells?.map(s => s.id)).toEqual(['b1', 'b2', 'b3'])
  })
})

describe('graceDue', () => {
  const done = (over: Partial<AgentRow>) =>
    row({ status: 'idle', lastActive: 0, shellsDoneAt: 100, shells: [shell({ exit: 0, endedAt: 100 })], ...over })
  test('idle only, not main, waits on the later of shellsDoneAt and lastActive, 0 disables, none while one is open', () => {
    expect(graceDue([done({})], 160, 60).map(r => r.id)).toEqual(['a1'])
    expect(graceDue([done({})], 159, 60)).toEqual([])
    expect(graceDue([done({ status: 'running' })], 1000, 60)).toEqual([])
    expect(graceDue([done({ id: 'main' })], 1000, 60)).toEqual([])
    expect(graceDue([done({ lastActive: 150 })], 160, 60)).toEqual([])
    expect(graceDue([done({ lastActive: 150 })], 210, 60).map(r => r.id)).toEqual(['a1'])
    expect(graceDue([done({})], 1000, 0)).toEqual([])
    const open = done({ shells: [shell({ exit: 0, endedAt: 100 }), shell({ id: 'b2' })] })
    expect(graceDue([open], 1000, 60)).toEqual([])
    expect(graceDue([done({ shellsDoneAt: undefined })], 1000, 60)).toEqual([])
    expect(graceDue([done({ shells: [] })], 1000, 60)).toEqual([])
  })
})

describe('shellNudge', () => {
  const t = Date.UTC(2026, 9, 12, 9, 5, 30)
  test('one and several, path omitted, command fallback', () => {
    expect(shellNudge([shell({ exit: 0, endedAt: t })])).toBe(
      '[orchestrator mod] your background command "run the tests" (id b1) exited with code 0 at 09:05 UTC and you haven\'t picked it up; output: /t/b1.output',
    )
    expect(shellNudge([shell({ exit: 'killed', endedAt: t, outputPath: '' })])).toBe(
      '[orchestrator mod] your background command "run the tests" (id b1) was killed at 09:05 UTC and you haven\'t picked it up',
    )
    const long = 'x'.repeat(100)
    expect(shellNudge([shell({ description: '', command: long, exit: 'unknown', endedAt: t })])).toContain(
      `"${'x'.repeat(80)}" (id b1) finished (exit code unknown) at 09:05 UTC`,
    )
    expect(shellNudge([shell({ exit: 0, endedAt: t }), shell({ id: 'b2', description: 'build', exit: 2, endedAt: t, outputPath: '' })])).toBe(
      [
        "[orchestrator mod] your background commands finished and you haven't picked them up:",
        '- "run the tests" (id b1) exited with code 0 at 09:05 UTC; output: /t/b1.output',
        '- "build" (id b2) exited with code 2 at 09:05 UTC',
      ].join('\n'),
    )
  })
})

describe('ceiling', () => {
  test('ceilingDue and markCeiling, 0 disables, done rows skipped', () => {
    const rows = [
      row({ id: 'main', type: 'main', shells: [shell({ id: 'm1', startedAt: 0 })] }),
      row({ id: 'a1', status: 'idle', shells: [shell({ id: 'b1', startedAt: 0 }), shell({ id: 'b2', startedAt: 50 })] }),
      row({ id: 'a2', status: 'handing-over', shells: [shell({ id: 'b3', startedAt: 0 }), shell({ id: 'b4', startedAt: 0, exit: 0 })] }),
      row({ id: 'a3', status: 'done', shells: [shell({ id: 'b5', startedAt: 0 })] }),
      row({ id: 'a4', status: 'replaced', shells: [shell({ id: 'b6', startedAt: 0 })] }),
    ]
    expect(ceilingDue(rows, 100, 100).map(d => `${d.row.id}:${d.shell.id}`)).toEqual(['main:m1', 'a1:b1', 'a2:b3'])
    expect(ceilingDue(rows, 99, 100)).toEqual([])
    expect(ceilingDue(rows, 1000, 0)).toEqual([])
    const marked = markCeiling(rows, 'b1')
    expect(marked[1]?.shells?.[0]?.ceilingNudged).toBe(true)
    expect(ceilingDue(marked, 100, 100).map(d => d.shell.id)).toEqual(['m1', 'b3'])
  })

  test('ceilingNudge omits Output with no path', () => {
    expect(ceilingNudge(shell({ outputPath: '' }), 60)).toBe(
      '[orchestrator mod] your background command "run the tests" (id b1) is still running after 60 min; check it (e.g. a suspended process) or stop it (TaskStop).',
    )
  })

  test('ceilingNudge', () => {
    expect(ceilingNudge(shell({}), 60)).toBe(
      '[orchestrator mod] your background command "run the tests" (id b1) is still running after 60 min; check it (e.g. a suspended process) or stop it (TaskStop). Output: /t/b1.output',
    )
  })
})

describe('goneShells', () => {
  test('non-array, listed, unlisted', () => {
    const rows = [
      row({ id: 'a1', shells: [shell({ id: 'b1' }), shell({ id: 'b2' }), shell({ id: 'b3', exit: 0 })] }),
      row({ id: 'main', shells: [shell({ id: 'm1' })] }),
    ]
    expect(goneShells(rows, undefined)).toEqual([])
    expect(goneShells(rows, { id: 'b1' })).toEqual([])
    expect(goneShells(rows, [{ id: 'b1', type: 'shell' }]).map(g => `${g.agentId}:${g.shell.id}`)).toEqual(['a1:b2', 'main:m1'])
    expect(goneShells(rows, [{ id: 'b1' }, { id: 'b2' }, { id: 'm1' }])).toEqual([])
    expect(goneShells(rows, [null, 'b1']).length).toBe(3)
  })
})

describe('watchdogNudge', () => {
  test('names the minutes', () => {
    expect(watchdogNudge(5)).toBe(
      "[orchestrator mod] you've been idle 5 min with no running children or background commands; if you're waiting on something, check it; otherwise carry on or report.",
    )
  })
})
