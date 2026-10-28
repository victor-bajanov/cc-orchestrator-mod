import { describe, expect, test } from 'claude-code/testing'

import { PEEK_DENIED } from './view'
import { buildTimeline, cutCells, jumpScroll, stampOf, timelineCols, timelineOf, timelineRow, turnCount, widthOf } from './timeline'
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

describe('turnCount', () => {
  test('counts turns, singular for one', () => {
    expect(turnCount(3)).toBe('3 turns')
    expect(turnCount(1)).toBe('1 turn')
    expect(turnCount(0)).toBe('0 turns')
  })
})

describe('stampOf', () => {
  const now = Date.UTC(2026, 9, 28, 15, 0)
  test('today is hh:mm', () => {
    expect(stampOf(Date.UTC(2026, 9, 28, 8, 5), now)).toBe('08:05')
  })

  test('an older day is D Mon, with no zero on the day', () => {
    expect(stampOf(Date.UTC(2026, 9, 27, 23, 59), now)).toBe('27 Oct')
    expect(stampOf(Date.UTC(2026, 8, 3, 12, 0), now)).toBe('3 Sep')
  })

  test('no stamp is --:--', () => {
    expect(stampOf(undefined, now)).toBe('--:--')
  })
})

describe('timelineCols', () => {
  test('the number column fits the count, the outcome column the widest outcome', () => {
    const turns = [turn({ outcome: 'reply' }), turn({ outcome: '✎ 12 files' }), turn({ outcome: '3 tools' })]
    expect(timelineCols(turns)).toEqual({ numW: 1, outW: 10 })
    expect(timelineCols(Array.from({ length: 12 }, () => turn()))).toEqual({ numW: 2, outW: 5 })
  })
})

const NOW = Date.UTC(2026, 9, 28, 15, 0)
const cols = { numW: 2, outW: 8 }

describe('timelineRow', () => {
  test('right-aligns the number', () => {
    expect(timelineRow(turn({ number: 7 }), 80, { numW: 3, outW: 8 }, NOW).num).toBe('  7')
    expect(timelineRow(turn({ number: 12 }), 80, { numW: 3, outW: 8 }, NOW).num).toBe(' 12')
  })

  test('right-aligns the outcome in its column', () => {
    expect(timelineRow(turn({ outcome: 'reply' }), 80, cols, NOW).outcome).toBe('   reply')
    expect(timelineRow(turn({ outcome: '✎ 2 files' }), 80, { numW: 2, outW: 9 }, NOW).outcome).toBe('✎ 2 files')
  })

  test('the time is --:-- until the turn has a stamp, hh:mm today, D Mon before, right-aligned in 6', () => {
    expect(timelineRow(turn(), 80, cols, NOW).time).toBe(' --:--')
    expect(timelineRow(turn({ t: Date.UTC(2026, 9, 28, 8, 5) }), 80, cols, NOW).time).toBe(' 08:05')
    expect(timelineRow(turn({ t: Date.UTC(2026, 9, 27, 8, 5) }), 80, cols, NOW).time).toBe('27 Oct')
  })

  test('here follows isCurrent', () => {
    expect(timelineRow(turn({ isCurrent: true }), 80, cols, NOW).here).toBe(true)
    expect(timelineRow(turn(), 80, cols, NOW).here).toBe(false)
  })

  test('a short preview is kept whole and its room is what the fixed cells leave', () => {
    const r = timelineRow(turn(), 80, cols, NOW)
    expect(r.preview).toBe('implement task one')
    // fold glyph, number, outcome, time and four single-space gaps
    expect(r.room).toBe(80 - (1 + 2 + 8 + 6 + 4))
  })

  test('a long preview is cut to its room, so the whole row fills the width exactly', () => {
    for (const isCurrent of [false, true]) {
      const r = timelineRow(turn({ preview: 'x'.repeat(200), isCurrent }), 60, cols, NOW)
      expect(r.preview).toHaveLength(r.room)
      expect(r.preview.endsWith('…')).toBe(true)
      expect(['▸', r.num, r.preview, r.outcome, r.time].join(' ')).toHaveLength(60)
    }
  })

  test('a tiny width keeps an 8-column preview', () => {
    const r = timelineRow(turn({ preview: 'y'.repeat(100) }), 10, cols, NOW)
    expect(r.preview).toHaveLength(8)
    expect(r.preview.endsWith('…')).toBe(true)
  })
})

describe('widthOf', () => {
  test('counts terminal cells: wide characters two, combining marks none', () => {
    expect(widthOf('abc')).toBe(3)
    expect(widthOf('日本')).toBe(4)
    expect(widthOf('🚀')).toBe(2)
    expect(widthOf('e\u0301')).toBe(1)
    expect(widthOf('👨\u200d👩')).toBe(4)
  })
})

describe('cutCells', () => {
  test('keeps what fits, and ends a cut text in … within the cells', () => {
    expect(cutCells('hello', 10)).toBe('hello')
    expect(cutCells('日本語日本語', 7)).toBe('日本語…')
    expect(widthOf(cutCells('日本語日本語', 8))).toBeLessThanOrEqual(8)
    expect(cutCells('🚀🚀🚀🚀', 5)).toBe('🚀🚀…')
  })
})

describe('timelineRow with wide characters', () => {
  test('the preview and its pad fill the room in cells', () => {
    for (const preview of ['日本語'.repeat(40), '🚀 launch '.repeat(30), 'short']) {
      const r = timelineRow(turn({ preview }), 60, cols, NOW)
      expect(widthOf(r.preview) + r.pad).toBe(r.room)
    }
  })
})

describe('jumpScroll', () => {
  test('a turn with no tool call has nowhere to scroll', () => {
    expect(jumpScroll(turn())).toBeUndefined()
  })

  test("the first tool call lands at the window's foot, so the opening prompt above it stays in view", () => {
    expect(jumpScroll(turn({ jumpTo: 'use-1' }))).toEqual({ to: { requestId: 'use-1' }, block: 'end' })
  })
})
