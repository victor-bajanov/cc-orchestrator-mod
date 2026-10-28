import { describe, expect, test } from 'claude-code/testing'

import { PEEK_DENIED, hhmm } from './view'
import { buildTimeline, timelineHeader, timelineOf, timelineRow } from './timeline'
import type { TimelineTurn } from './timeline'
import type { TranscriptItem } from '../types'

const user = (key: string, text: string, t?: number): TranscriptItem => ({ kind: 'text', key, role: 'user', text, ...(t === undefined ? {} : { t }) })
const reply = (key: string, text = 'ok'): TranscriptItem => ({ kind: 'text', key, role: 'assistant', text })
const tool = (key: string, name: string, brief = '', toolUseId = `id-${key}`): TranscriptItem => ({
  kind: 'tool',
  key,
  toolUseId,
  tool: name,
  brief,
})

const turn = (over: Partial<TimelineTurn> = {}): TimelineTurn => ({
  key: 'k1',
  number: 1,
  preview: 'implement task one',
  outcome: 'reply',
  isCurrent: false,
  items: [],
  ...over,
})

const outcomeOf = (...items: TranscriptItem[]): string => buildTimeline([user('u', 'go'), ...items])[0]!.outcome

describe('buildTimeline', () => {
  test('nothing in, no turns out', () => {
    expect(buildTimeline([])).toEqual([])
  })

  test('one user text and its replies are one current turn', () => {
    const items = [user('u1', 'hello'), reply('a1'), reply('a2')]
    const turns = buildTimeline(items)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ key: 'u1', number: 1, preview: 'hello', outcome: 'reply', isCurrent: true, items })
    expect(turns[0]!.jumpTo).toBeUndefined()
  })

  test('each user text opens a turn holding its own items', () => {
    const t1 = tool('t1', 'Read')
    const t2 = tool('t2', 'Bash')
    const turns = buildTimeline([user('u1', 'first'), t1, user('u2', 'second'), t2])
    expect(turns.map((t) => [t.key, t.number, t.isCurrent])).toEqual([
      ['u1', 1, false],
      ['u2', 2, true],
    ])
    expect(turns[0]!.items.map((i) => i.key)).toEqual(['u1', 't1'])
    expect(turns[1]!.items.map((i) => i.key)).toEqual(['u2', 't2'])
  })

  test('jumpTo is the first tool call, wherever the text steps sit', () => {
    const turns = buildTimeline([
      user('u1', 'first'),
      reply('a1'),
      tool('t1', 'Read', '', 'use-1'),
      tool('t2', 'Bash', '', 'use-2'),
      user('u2', 'second'),
      reply('a2'),
    ])
    expect(turns[0]!.jumpTo).toBe('use-1')
    expect(turns[1]!.jumpTo).toBeUndefined()
  })

  test('the opening item sets t', () => {
    expect(buildTimeline([user('u1', 'go', 1234), reply('a1')])[0]!.t).toBe(1234)
    expect(buildTimeline([user('u1', 'go')])[0]!.t).toBeUndefined()
  })

  test('outcome counts distinct files edited', () => {
    expect(
      outcomeOf(tool('1', 'Edit', 'a.ts'), tool('2', 'Write', 'b.ts'), tool('3', 'Edit', 'a.ts'), tool('4', 'Bash', 'ls')),
    ).toBe('✎ 2 files')
    expect(outcomeOf(tool('1', 'Edit', 'a.ts'))).toBe('✎ 1 file')
    expect(outcomeOf(tool('1', 'MultiEdit', 'a.ts'), tool('2', 'Write', 'b.ts'))).toBe('✎ 2 files')
  })

  test('outcome counts commands when nothing was edited', () => {
    expect(outcomeOf(tool('1', 'Bash'), tool('2', 'Bash'), tool('3', 'Bash'), tool('4', 'Read'))).toBe('› 3 cmds')
    expect(outcomeOf(tool('1', 'Bash'))).toBe('› 1 cmd')
  })

  test('outcome counts other tools, else is a reply', () => {
    expect(outcomeOf(tool('1', 'Read'), tool('2', 'Grep'))).toBe('2 tools')
    expect(outcomeOf(tool('1', 'Read'))).toBe('1 tool')
    expect(outcomeOf(reply('a1'))).toBe('reply')
  })

  test('a lone system-reminder does not open a turn', () => {
    const turns = buildTimeline([
      user('u1', 'real ask'),
      user('r1', '  <system-reminder>\nnote\n</system-reminder>  '),
      reply('a1'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.preview).toBe('real ask')
    expect(turns[0]!.items.map((i) => i.key)).toEqual(['u1', 'r1', 'a1'])
  })

  test('real text between two reminder blocks still opens a turn', () => {
    const turns = buildTimeline([
      user('u1', '<system-reminder>a</system-reminder> real ask <system-reminder>b</system-reminder>'),
    ])
    expect(turns.map((t) => t.key)).toEqual(['u1'])
  })

  test('adjacent reminder blocks alone do not open a turn', () => {
    const turns = buildTimeline([
      user('u1', 'real ask'),
      user('r1', '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.items.map((i) => i.key)).toEqual(['u1', 'r1'])
  })

  test('a cut reminder-only text, with no closing tag, opens no turn', () => {
    const turns = buildTimeline([user('u1', 'real ask'), user('r1', '<system-reminder>\nlong body that was cut off…'), reply('a1')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.items.map((i) => i.key)).toEqual(['u1', 'r1', 'a1'])
  })

  test('the preview drops reminder blocks around the real text', () => {
    expect(buildTimeline([user('u1', '<system-reminder>x</system-reminder>\nreal ask')])[0]!.preview).toBe('real ask')
    expect(buildTimeline([user('u1', 'real ask\n<system-reminder>x</system-reminder>')])[0]!.preview).toBe('real ask')
    expect(buildTimeline([user('u1', 'real ask <system-reminder>cut off…')])[0]!.preview).toBe('real ask')
  })

  test('steps before the first user text form a leading turn', () => {
    const turns = buildTimeline([reply('a0'), tool('t0', 'Read'), user('u1', 'now this')])
    expect(turns.map((t) => [t.key, t.number, t.preview])).toEqual([
      ['earlier', 1, 'earlier steps'],
      ['u1', 2, 'now this'],
    ])
    expect(turns[0]!.items.map((i) => i.key)).toEqual(['a0', 't0'])
    expect(turns[0]!.outcome).toBe('1 tool')
  })

  test('the preview is one line', () => {
    expect(buildTimeline([user('u1', '  fix\n\tthe   bug \n now ')])[0]!.preview).toBe('fix the bug now')
  })
})

describe('timelineOf', () => {
  test('says why there is nothing to list', () => {
    expect(timelineOf(undefined)).toEqual({ dim: 'loading…' })
    expect(timelineOf({ denied: true })).toEqual({ dim: PEEK_DENIED })
    expect(timelineOf({ items: [] })).toEqual({ dim: 'no messages yet' })
  })

  test('steps without a user text are the leading turn, not an empty list', () => {
    const r = timelineOf({ items: [tool('t0', 'Read')] })
    expect('turns' in r && r.turns.map((t) => t.key)).toEqual(['earlier'])
  })

  test('hands back the built turns', () => {
    const items = [user('u1', 'go'), reply('a1')]
    expect(timelineOf({ items })).toEqual({ turns: buildTimeline(items) })
  })
})

describe('timelineHeader', () => {
  test('names the agent and counts turns', () => {
    expect(timelineHeader('impl-1', 3)).toBe('Timeline · impl-1 · 3 turns')
    expect(timelineHeader('impl-1', 1)).toBe('Timeline · impl-1 · 1 turn')
    expect(timelineHeader('impl-1', 0)).toBe('Timeline · impl-1 · 0 turns')
  })
})

describe('timelineRow', () => {
  test('right-aligns the number', () => {
    expect(timelineRow(turn({ number: 7 }), 80, 3).num).toBe('  7')
    expect(timelineRow(turn({ number: 12 }), 80, 3).num).toBe(' 12')
  })

  test('time is --:-- until the turn has a stamp', () => {
    expect(timelineRow(turn(), 80, 2).time).toBe('--:--')
    expect(timelineRow(turn({ t: 3_600_000 }), 80, 2).time).toBe(hhmm(3_600_000))
  })

  test('here follows isCurrent', () => {
    expect(timelineRow(turn({ isCurrent: true }), 80, 2).here).toBe(true)
    expect(timelineRow(turn(), 80, 2).here).toBe(false)
  })

  test('a short preview is kept whole, with the outcome as is', () => {
    const r = timelineRow(turn({ outcome: '✎ 2 files' }), 80, 2)
    expect(r.preview).toBe('implement task one')
    expect(r.outcome).toBe('✎ 2 files')
  })

  test('a long preview is cut so the row fits the width', () => {
    for (const isCurrent of [false, true]) {
      const numW = 2
      const r = timelineRow(turn({ preview: 'x'.repeat(200), outcome: '› 3 cmds', isCurrent }), 60, numW)
      expect(r.preview.endsWith('…')).toBe(true)
      const cells = [r.num, r.preview, r.outcome, ...(r.here ? ['• here'.padEnd(7)] : []), r.time, '↗ ']
      expect(cells.join(' ').length).toBeLessThanOrEqual(60)
      // the preview takes everything the fixed cells leave
      expect(cells.join(' ').length).toBeGreaterThanOrEqual(58)
    }
  })

  test('a tiny width keeps an 8-column preview', () => {
    const r = timelineRow(turn({ preview: 'y'.repeat(100) }), 10, 2)
    expect(r.preview).toHaveLength(8)
    expect(r.preview.endsWith('…')).toBe(true)
  })
})
