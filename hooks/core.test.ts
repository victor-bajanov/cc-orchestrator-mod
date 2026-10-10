import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_SAMPLES,
  contextOf,
  crossed,
  fmtTokens,
  level,
  notePathFor,
  orderRows,
  recordStep,
  replacementPrompt,
  resumePrompt,
  rosterMarkdown,
  sparkline,
  timeline,
  handoverMessage,
} from './core'
import type { AgentRow } from '../types'

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
  test('tells the agent its parent need not act when the mod respawns it', () => {
    const m = handoverMessage('/n.md', true)
    expect(m).toContain('HANDOVER')
    expect(m).toContain('/n.md')
    expect(m).toContain('no action needed')
  })
  test('tells the parent to respawn when the mod does not', () => {
    expect(handoverMessage('/n.md', false)).toContain('spawn a replacement')
  })
})
