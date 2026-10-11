import { describe, expect, test } from 'claude-code/testing'

import {
  LIMIT_COLOR,
  LIVE,
  MAIN_COLOR,
  PALETTE,
  chartWidthPx,
  contextChart,
  logId,
  paneHeader,
  seriesColors,
} from './view'
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
  test('main is grey; subagents cycle the palette in tree order', () => {
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
    expect(c.get('c')).toBe(PALETTE[1])
    expect(c.get('q')).toBe(PALETTE[2])
    expect(c.get('s6')).toBe(PALETTE[5])
    expect(c.get('s7')).toBe(PALETTE[0])
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
