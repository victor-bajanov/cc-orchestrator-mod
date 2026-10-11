import { describe, expect, test } from 'claude-code/testing'

import {
  LIMIT_COLOR,
  LIVE,
  MAIN_COLOR,
  PALETTE,
  ceilingOf,
  chartWidthPx,
  contextChart,
  cut,
  hhmm,
  logId,
  mainButtonShown,
  paneHeader,
  peekLines,
  seriesColors,
} from './view'
import type { SessionMessage } from 'claude-code'
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

const main = (over: Partial<AgentRow> = {}) => row({ id: 'main', description: 'main thread', type: 'main', ...over })

const paths = (source: string) => source.match(/<path [^>]*>/g) ?? []

/** The x of the pen's final position after a path's `d`. */
const endX = (tag: string): number => {
  const d = /d="([^"]*)"/.exec(tag)?.[1] ?? ''
  let x = NaN
  for (const m of d.matchAll(/([MHV])\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/g)) {
    if (m[1] === 'M' || m[1] === 'H') x = Number(m[2])
  }
  return x
}

/** Points a step-after path visits: the move plus one per vertical step. */
const points = (tag: string): number => {
  const d = /d="([^"]*)"/.exec(tag)?.[1] ?? ''
  return 1 + (d.match(/V/g) ?? []).length
}

const base = { now: 100, width: 640, height: 180, agentThreshold: 450_000, mainThreshold: 450_000 }

describe('paneHeader', () => {
  const rows = [
    main(),
    row({ id: 'r1', status: 'running' }),
    row({ id: 'r2', status: 'running' }),
    row({ id: 'x', status: 'replaced' }),
    row({ id: 'd', status: 'done' }),
  ]
  test('counts live and handed-over subagents, with limits, mode and phase', () => {
    expect(paneHeader(rows, { agentThreshold: 450_000, mainThreshold: 300_000, mainMode: 'ask', phase: 'offered' })).toBe(
      '2 live · 1 handed over · limits 450k / main 300k (ask, offered)',
    )
  })
  test('leaves the phase out when idle', () => {
    expect(
      paneHeader(rows, { agentThreshold: 450_000, mainThreshold: 300_000, mainMode: 'ask', phase: 'idle' }).endsWith('(ask)'),
    ).toBe(true)
  })
})

describe('seriesColors', () => {
  test('main is grey; subagents cycle the palette in spawn (array) order', () => {
    const rows = [
      row({ id: 'p', startedAt: 1 }),
      main(),
      row({ id: 'q', startedAt: 3 }),
      row({ id: 'c', startedAt: 2, parentId: 'p' }),
      row({ id: 's4', startedAt: 4 }),
      row({ id: 's5', startedAt: 5 }),
      row({ id: 's6', startedAt: 6 }),
      row({ id: 's7', startedAt: 7 }),
    ]
    const c = seriesColors(rows)
    expect(c.get('main')).toBe(MAIN_COLOR)
    expect(c.get('p')).toBe(PALETTE[0])
    expect(c.get('q')).toBe(PALETTE[1])
    expect(c.get('c')).toBe(PALETTE[2])
    expect(c.get('s5')).toBe(PALETTE[4])
    expect(c.get('s6')).toBe(PALETTE[5])
    expect(c.get('s7')).toBe(PALETTE[0])
  })
  test('a nested spawn does not shift an existing colour', () => {
    const before = [row({ id: 'p', startedAt: 1 }), row({ id: 'q', startedAt: 2 })]
    const q = seriesColors(before).get('q')
    const after = seriesColors([...before, row({ id: 'c', startedAt: 3, parentId: 'p' })])
    expect(after.get('q')).toBe(q)
    expect(after.get('p')).toBe(PALETTE[0])
  })
})

describe('hhmm', () => {
  test('is the UTC hh:mm of a time', () => {
    expect(hhmm(0)).toBe('00:00')
    expect(hhmm(3_723_000)).toBe('01:02')
  })
})

describe('cut', () => {
  test('cuts to fits characters, ending in an ellipsis', () => {
    expect(cut('abcdef', 4)).toBe('abc…')
    expect(cut('abcdef', 1)).toBe('a…')
    expect(cut('abcdef', 0)).toBe('a…')
  })
})

describe('ceilingOf', () => {
  test('is the main limit for main and the agent limit otherwise', () => {
    const t = { agentThreshold: 450_000, mainThreshold: 300_000 }
    expect(ceilingOf(main(), t)).toBe(300_000)
    expect(ceilingOf(row({ id: 'a1' }), t)).toBe(450_000)
  })
})

describe('logId', () => {
  test('is the id the terminal card uses', () => {
    expect(logId({ t: 5, text: 'abc', level: 'info' })).toBe('log-5-3')
  })
})

describe('chartWidthPx', () => {
  test('is 8 px a column, clamped to 320..1200', () => {
    expect(chartWidthPx(10)).toBe(320)
    expect(chartWidthPx(100)).toBe(800)
    expect(chartWidthPx(500)).toBe(1200)
  })
})

describe('contextChart', () => {
  const two = (over: Partial<AgentRow> = {}) => [
    row({ id: 'a1', name: 'impl-1', tokens: 300_000, peak: 300_000, samples: [{ t: 0, tokens: 100_000 }, { t: 50, tokens: 300_000 }], status: 'done', ...over }),
    main({ tokens: 20_000, peak: 20_000, samples: [{ t: 10, tokens: 20_000 }] }),
  ]
  const colors = (rows: AgentRow[]) => seriesColors(rows)

  test('root svg carries the size and viewBox', () => {
    const rows = two()
    const c = contextChart({ ...base, rows, colors: colors(rows) })
    expect(c.source.startsWith('<svg')).toBe(true)
    expect(c.source).toContain('viewBox="0 0 640 180"')
    expect(c.width).toBe(640)
    expect(c.height).toBe(180)
  })

  test('one path per row with samples, none for a row without', () => {
    const rows = [...two(), row({ id: 'empty', startedAt: 5 })]
    const c = contextChart({ ...base, rows, colors: colors(rows) })
    expect(paths(c.source)).toHaveLength(2)
  })

  test('steps after: a settled row stops at its last sample, a live row runs to the right edge', () => {
    const plotW = 640 - 44 - 8
    const settled = row({ id: 's', status: 'done', samples: [{ t: 0, tokens: 10 }, { t: 50, tokens: 20 }] })
    const live = row({ id: 'l', status: 'running', startedAt: 1, samples: [{ t: 0, tokens: 10 }, { t: 50, tokens: 20 }] })
    const rows = [settled, live]
    const c = contextChart({ ...base, rows, colors: colors(rows) })
    const [ps, pl] = paths(c.source)
    expect(Math.abs(endX(ps!) - (44 + plotW / 2))).toBeLessThanOrEqual(0.5)
    expect(endX(pl!)).toBe(640 - 8)
  })

  test('a selection thickens its line and fades the rest', () => {
    const rows = two()
    const sel = contextChart({ ...base, rows, colors: colors(rows), selected: 'a1' })
    const [a1, m] = paths(sel.source)
    expect(a1).toContain('stroke-width="3"')
    expect(m).toContain('opacity="0.3"')
    const none = contextChart({ ...base, rows, colors: colors(rows) })
    expect(none.source).not.toContain('opacity="0.3"')
    expect(none.source).not.toContain('stroke-width="3"')
    expect(contextChart({ ...base, rows, colors: colors(rows), selected: '' }).source).not.toContain('opacity="0.3"')
  })

  test('limit lines: one when the thresholds match, two when they differ', () => {
    const rows = two()
    const same = contextChart({ ...base, rows, colors: colors(rows) })
    expect(same.source.match(/stroke-dasharray/g)).toHaveLength(1)
    expect(same.source).toContain('limit 450k')
    expect(same.source).toContain(LIMIT_COLOR)
    const diff = contextChart({ ...base, mainThreshold: 300_000, rows, colors: colors(rows) })
    expect(diff.source.match(/stroke-dasharray/g)).toHaveLength(2)
    expect(diff.source).toContain('agent limit 450k')
    expect(diff.source).toContain('main limit 300k')
  })

  test('escapes interpolated text', () => {
    const rows = two({ name: 'a<b & "c"' })
    const c = contextChart({ ...base, rows, colors: colors(rows) })
    expect(c.source).toContain('<title>a&lt;b &amp; &quot;c&quot;')
    expect(c.source).not.toContain('<b ')
  })

  test('stays under the Svg source limit and downsamples each series', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      row({
        id: `agent-with-a-long-id-${i}`,
        name: `implementer-number-${i}`,
        startedAt: 0,
        status: 'running',
        tokens: 400_000,
        peak: 400_000,
        samples: Array.from({ length: 180 }, (_, k) => ({ t: k * 1000 + i, tokens: 1000 * ((k * 7919 + i * 31) % 450) })),
      }),
    )
    const c = contextChart({ ...base, now: 200_000, rows: many, colors: seriesColors(many) })
    expect(c.source.length).toBeLessThan(131072)
    for (const p of paths(c.source)) expect(points(p)).toBeLessThanOrEqual(Math.floor((640 - 52) / 3) + 2)
    const narrow = contextChart({ ...base, width: 320, now: 200_000, rows: many, colors: seriesColors(many) })
    for (const p of paths(narrow.source)) expect(points(p)).toBeLessThanOrEqual(Math.floor((320 - 52) / 3) + 2)
  })

  test('alt names each series, or says there is nothing yet', () => {
    const rows = two()
    expect(contextChart({ ...base, rows, colors: colors(rows) }).alt).toBe(
      'Context over time: impl-1 300k of 450k; main thread 20k of 450k',
    )
    expect(contextChart({ ...base, rows: [], colors: new Map() }).alt).toBe('No model requests yet.')
  })
})

describe('mainButtonShown', () => {
  test('ask mode shows it unless main is already handing over', () => {
    expect(mainButtonShown('ask', 'idle')).toBe(true)
    expect(mainButtonShown('ask', 'offered')).toBe(true)
    expect(mainButtonShown('ask', 'cooldown')).toBe(true)
    expect(mainButtonShown('ask', 'writing')).toBe(false)
    expect(mainButtonShown('ask', 'clearing')).toBe(false)
  })

  test('auto and off never show it', () => {
    expect(mainButtonShown('auto', 'idle')).toBe(false)
    expect(mainButtonShown('auto', 'offered')).toBe(false)
    expect(mainButtonShown('off', 'idle')).toBe(false)
  })
})

describe('peekLines', () => {
  const msg = (role: 'user' | 'assistant', text: string, tools: string[] = []): SessionMessage => ({
    role,
    text,
    toolUses: tools.map((tool, i) => ({ tool_use_id: `t${i}`, tool, input: {} })),
  })

  test('an empty transcript gives no lines; a tool-result-only user row is dropped', () => {
    expect(peekLines([], 80, 5)).toEqual([])
    const results: SessionMessage = { ...msg('user', ''), toolResults: [{ tool_use_id: 't0', text: 'ok' } as never] }
    expect(peekLines([results], 80, 5)).toEqual([])
  })

  test('keeps the last n drawable messages, oldest first', () => {
    const all = [msg('user', 'one'), msg('assistant', 'two'), msg('user', ''), msg('assistant', 'three')]
    expect(peekLines(all, 80, 2)).toEqual(['assistant: two', 'assistant: three'])
  })

  test('prefixes the role and collapses whitespace', () => {
    expect(peekLines([msg('assistant', 'a\n  b\tc ')], 80, 5)).toEqual(['assistant: a b c'])
    expect(peekLines([msg('user', 'go')], 80, 5)).toEqual(['user: go'])
  })

  test('summarises tool uses before the text, counting repeats in first-use order', () => {
    expect(peekLines([msg('assistant', 'text', ['Bash', 'Read', 'Bash'])], 80, 5)).toEqual(['assistant: ⚙ Bash×2, Read · text'])
    expect(peekLines([msg('assistant', '', ['Bash', 'Read', 'Bash'])], 80, 5)).toEqual(['assistant: ⚙ Bash×2, Read'])
  })

  test('cuts a long line to exactly the width, ending in an ellipsis', () => {
    const [line] = peekLines([msg('assistant', 'x'.repeat(200), ['Edit'])], 40, 5)
    expect(line).toHaveLength(40)
    expect(line!.endsWith('…')).toBe(true)
    expect(line!.startsWith('assistant: ⚙ Edit · x')).toBe(true)
    expect(peekLines([msg('user', 'short')], 40, 5)).toEqual(['user: short'])
  })
})

describe('LIVE', () => {
  test('is the statuses the terminal treats as live', () => {
    expect([...LIVE]).toEqual(['running', 'idle', 'handing-over'])
  })
})

describe('contextChart geometry', () => {
  const dOf = (tag: string) => /d="([^"]*)"/.exec(tag)?.[1] ?? ''

  test('a settled row steps across, then up: H before V', () => {
    const rows = [row({ id: 's', status: 'done', samples: [{ t: 0, tokens: 0 }, { t: 50, tokens: 236_250 }] })]
    const [p] = paths(contextChart({ ...base, rows, colors: seriesColors(rows) }).source)
    expect(dOf(p!)).toBe('M44 160H338V84')
  })

  test('downsampling keeps a spike and both ends', () => {
    const samples = Array.from({ length: 300 }, (_, k) => ({ t: k, tokens: k === 150 ? 400_000 : 10_000 }))
    const rows = [row({ id: 's', status: 'done', samples, tokens: 10_000, peak: 400_000 })]
    const c = contextChart({ ...base, width: 320, now: 299, rows, colors: seriesColors(rows) })
    const [p] = paths(c.source)
    const d = dOf(p!)
    const spikeY = Math.round(8 + 152 * (1 - 400_000 / (450_000 * 1.05)))
    expect(d).toContain(`V${spikeY}`)
    expect(d.startsWith('M44 ')).toBe(true)
    expect(endX(p!)).toBe(320 - 8)
    expect(points(p!)).toBeLessThanOrEqual(Math.floor((320 - 52) / 3) + 2)
  })

  test('a zero time span draws no NaN', () => {
    const rows = [row({ id: 's', status: 'running', startedAt: 5, samples: [{ t: 5, tokens: 1000 }] })]
    expect(contextChart({ ...base, now: 5, rows, colors: seriesColors(rows) }).source).not.toContain('NaN')
  })

  test('a single-sample settled row is a move plus a circle', () => {
    const rows = [row({ id: 's', status: 'done', samples: [{ t: 0, tokens: 0 }] })]
    const c = contextChart({ ...base, rows, colors: seriesColors(rows) })
    expect(dOf(paths(c.source)[0]!)).toBe('M44 160')
    expect(c.source).toContain('<circle cx="44" cy="160" r="3"')
  })

  test('zero thresholds and tokens draw no NaN or Infinity', () => {
    const rows = [main({ samples: [{ t: 0, tokens: 0 }, { t: 10, tokens: 0 }] })]
    const c = contextChart({ ...base, agentThreshold: 0, mainThreshold: 0, rows, colors: seriesColors(rows) })
    expect(c.source).not.toContain('NaN')
    expect(c.source).not.toContain('Infinity')
  })
})

describe('contextChart scale and bounds', () => {
  const dOf = (tag: string) => /d="([^"]*)"/.exec(tag)?.[1] ?? ''
  const LIMIT = 131072

  test("a row's peak drives the scale", () => {
    const rows = [row({ id: 's', status: 'done', peak: 900, samples: [{ t: 0, tokens: 0 }, { t: 50, tokens: 500 }] })]
    const [p] = paths(contextChart({ ...base, agentThreshold: 100, mainThreshold: 100, rows, colors: seriesColors(rows) }).source)
    const y500 = Math.round(8 + 152 * (1 - 500 / (900 * 1.05)))
    expect(dOf(p!)).toBe(`M44 160H338V${y500}`)
  })

  const crowd = (n: number, name: (i: number) => string) =>
    Array.from({ length: n }, (_, i) =>
      row({
        id: `agent-${i}`,
        name: name(i),
        startedAt: i,
        status: i % 5 === 0 ? 'running' : 'done',
        tokens: 400_000,
        peak: 449_000,
        samples: Array.from({ length: 180 }, (_, k) => ({ t: i + k * 1000, tokens: 1000 * ((k * 7919 + i * 31) % 450) })),
      }),
    )
  const opts = { ...base, width: 1200, now: 500_000 }

  test('250 agents of 180 samples share a point budget and stay under the limit', () => {
    const rows = crowd(250, i => `implementer-number-${i}`)
    const c = contextChart({ ...opts, rows, colors: seriesColors(rows) })
    expect(c.source.length).toBeLessThan(LIMIT)
    expect(paths(c.source)).toHaveLength(250)
  })

  test('past the limit, the oldest finished agents are dropped and the alt says so; live ones stay', () => {
    const rows = crowd(250, i => `${i}-${'x'.repeat(200)}`)
    const c = contextChart({ ...opts, rows, colors: seriesColors(rows) })
    expect(c.source.length).toBeLessThan(LIMIT)
    for (const r of rows.filter(r => r.status === 'running')) expect(c.source).toContain(`<title>${r.startedAt}-`)
    const drawn = paths(c.source).length
    expect(drawn).toBeLessThan(250)
    expect(c.alt).toContain(`${250 - drawn} finished agents not drawn`)
    // The newest finished agent survives before the oldest does.
    expect(c.source).toContain(`<title>249-`)
    expect(c.source).not.toContain(`<title>1-`)
  })

  const liveCrowd = (n: number) =>
    crowd(n, i => `${i}-${'y'.repeat(500)}`).map(r => ({ ...r, status: 'running' as const }))

  test('long labels are cut to 80 characters in tooltips', () => {
    const rows = liveCrowd(120)
    const c = contextChart({ ...opts, rows, colors: seriesColors(rows) })
    expect(c.source.length).toBeLessThan(LIMIT)
    expect(paths(c.source)).toHaveLength(120)
    expect(c.source).toContain(`<title>7-${'y'.repeat(80 - 3)}… · `)
  })

  test('when live series alone are past the limit, circles lose their tooltips; lines keep theirs', () => {
    const rows = liveCrowd(250)
    const c = contextChart({ ...opts, rows, colors: seriesColors(rows) })
    expect(c.source.length).toBeLessThan(LIMIT)
    expect(paths(c.source)).toHaveLength(250)
    expect(c.source).not.toContain('</title></circle>')
    expect(c.source.match(/<\/title><\/path>/g)).toHaveLength(250)
  })
})
