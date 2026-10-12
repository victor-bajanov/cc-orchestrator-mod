import { describe, expect, test } from 'claude-code/testing'

import {
  LIMIT_COLOR,
  LIVE,
  PEEK_DENIED,
  MAIN_COLOR,
  PALETTE,
  addressFor,
  ceilingOf,
  canFold,
  capLines,
  cleanBlock,
  chartWidthPx,
  contextChart,
  checkinDue,
  childrenOf,
  collapseHidden,
  cut,
  displayStatus,
  expandCap,
  foldGlyph,
  forwardTarget,
  effortAbbrev,
  hashText,
  hhmm,
  hiddenCount,
  latest,
  logId,
  mainButtonShown,
  modelLabel,
  modelName,
  namesAgent,
  paneHeader,
  redirectTarget,
  resolveAgent,
  runnerFor,
  sameReport,
  seriesColors,
  statusEmoji,
  statusStyle,
  terminalBase,
  textKey,
  toolBrief,
  transcriptItems,
  transcriptView,
  watchdogDue,
} from './view'
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import type { AgentRow, AgentStatus, TranscriptItem } from '../types'

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
  test('counts respawn-failed rows as not replaced, before the limits; none adds nothing', () => {
    const failed = [...rows, row({ id: 'f', status: 'respawn-failed' })]
    expect(paneHeader(failed, { agentThreshold: 450_000, mainThreshold: 300_000, mainMode: 'ask', phase: 'idle' })).toContain(
      '· 1 not replaced · limits',
    )
    expect(paneHeader(rows, { agentThreshold: 450_000, mainThreshold: 300_000, mainMode: 'ask', phase: 'idle' })).not.toContain(
      'not replaced',
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

describe('modelName', () => {
  test('maps model ids and aliases to display names', () => {
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5')
    expect(modelName('claude-sonnet-4-5@20250929')).toBe('Sonnet 4.5')
    expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelName('sonnet')).toBe('Sonnet')
    expect(modelName('inherit')).toBe('')
    expect(modelName('gpt-x')).toBe('gpt-x')
  })

  test('an unknown id longer than 16 characters is cut to 16', () => {
    const name = modelName('some-very-long-model-identifier')
    expect(name).toHaveLength(16)
    expect(name.endsWith('…')).toBe(true)
  })
})

describe('effortAbbrev and modelLabel', () => {
  test('abbreviates the effort levels and formats a token budget', () => {
    expect(effortAbbrev('low')).toBe('low')
    expect(effortAbbrev('medium')).toBe('med')
    expect(effortAbbrev('high')).toBe('high')
    expect(effortAbbrev('xhigh')).toBe('xhigh')
    expect(effortAbbrev('max')).toBe('max')
    expect(effortAbbrev('32000')).toBe('32k')
    expect(effortAbbrev('odd')).toBe('odd')
  })

  test('joins the model and effort; the model alone without effort; nothing without a model', () => {
    expect(modelLabel('claude-sonnet-5-5', 'medium')).toBe('Sonnet 5.5 med')
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel(undefined, 'medium')).toBe('')
    expect(modelLabel('inherit', 'high')).toBe('')
  })
})

describe('statusStyle', () => {
  test('gives each status its theme colour and weight', () => {
    expect(statusStyle('running')).toEqual({ color: 'success', bold: true })
    expect(statusStyle('idle')).toEqual({ color: 'warning', dimColor: true })
    expect(statusStyle('done')).toEqual({ color: 'success', dimColor: true })
    expect(statusStyle('stalled')).toEqual({ color: 'error', bold: true })
    expect(statusStyle('handing-over')).toEqual({ color: 'suggestion', bold: true })
    expect(statusStyle('replaced')).toEqual({ color: 'inactive', dimColor: true })
    expect(statusStyle('respawn-failed')).toEqual({ color: 'error', bold: true })
  })
})

describe('runnerFor and statusEmoji', () => {
  const runners = ['🏃‍♂️', '🏃‍♀️']

  test('the same id always gets the same runner, and both runners occur', () => {
    expect(runnerFor('agent7')).toBe(runnerFor('agent7'))
    const seen = new Set(Array.from({ length: 20 }, (_, i) => runnerFor(`agent${i + 1}`)))
    expect([...seen].sort()).toEqual([...runners].sort())
  })

  test('gives each status its emoji; running is the agent own runner', () => {
    expect(statusEmoji('idle', 'x')).toBe('😴')
    expect(statusEmoji('done', 'x')).toBe('✅')
    expect(statusEmoji('stalled', 'x')).toBe('🛑')
    expect(statusEmoji('handing-over', 'x')).toBe('📝')
    expect(statusEmoji('replaced', 'x')).toBe('♻️')
    expect(statusEmoji('respawn-failed', 'x')).toBe('⚠️')
    for (const id of ['a', 'b', 'agent3']) expect(statusEmoji('running', id)).toBe(runnerFor(id))
  })
})

describe('displayStatus', () => {
  const kid = (id: string, parentId: string, status: AgentStatus) => row({ id, parentId, status })

  test('an idle parent with a running, idle or handing-over child displays waiting', () => {
    for (const s of ['running', 'idle', 'handing-over'] as const) {
      const p = row({ id: 'p', status: 'idle' })
      expect(displayStatus(p, [p, kid('c', 'p', s)])).toBe('waiting')
    }
  })

  test('an idle parent whose children are settled, or who has none, displays idle', () => {
    for (const s of ['done', 'replaced', 'stalled'] as const) {
      const p = row({ id: 'p', status: 'idle' })
      expect(displayStatus(p, [p, kid('c', 'p', s)])).toBe('idle')
    }
    const lone = row({ id: 'p', status: 'idle' })
    expect(displayStatus(lone, [lone, kid('c', 'other', 'running')])).toBe('idle')
  })

  test('only idle becomes waiting: a running parent with a running child is running', () => {
    const p = row({ id: 'p', status: 'running' })
    expect(displayStatus(p, [p, kid('c', 'p', 'running')])).toBe('running')
    const d = row({ id: 'p', status: 'done' })
    expect(displayStatus(d, [d, kid('c', 'p', 'running')])).toBe('done')
  })

  test('nesting: main and its idle child both wait on a running grandchild', () => {
    const m = main({ status: 'idle' })
    const c = kid('c', 'main', 'idle')
    const g = kid('g', 'c', 'running')
    const rows = [m, c, g]
    expect(displayStatus(m, rows)).toBe('waiting')
    expect(displayStatus(c, rows)).toBe('waiting')
    expect(displayStatus(g, rows)).toBe('running')
  })

  test("main is the parent of rows whose parentId is 'main'", () => {
    const m = main({ status: 'idle' })
    expect(displayStatus(m, [m, kid('c', 'main', 'running')])).toBe('waiting')
  })

  test('waiting has its own style and emoji', () => {
    expect(statusStyle('waiting')).toEqual({ color: 'planMode' })
    expect(statusEmoji('waiting', 'x')).toBe('⏳')
  })

  test('leaves the rows unchanged', () => {
    const rows = [main({ status: 'idle' }), kid('c', 'main', 'idle'), kid('g', 'c', 'running')]
    const before = JSON.parse(JSON.stringify(rows))
    for (const r of rows) displayStatus(r, rows)
    expect(rows).toEqual(before)
  })
})

describe('hashText and textKey', () => {
  test('hashText is a stable base-36 djb2', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
    expect(hashText('abc')).toMatch(/^[0-9a-z]+$/)
  })

  test('textKey ignores whitespace and ANSI differences and differs by role', () => {
    const k = textKey('assistant', 'hi there')
    expect(k.startsWith('txt:')).toBe(true)
    expect(textKey('assistant', '  hi\n\tthere ')).toBe(k)
    expect(textKey('assistant', '\x1b[31mhi\x1b[0m there')).toBe(k)
    expect(textKey('user', 'hi there')).not.toBe(k)
    expect(textKey('assistant', 'hi where')).not.toBe(k)
  })
})

describe('toolBrief', () => {
  test('Bash gives its command with newlines collapsed', () => {
    expect(toolBrief('Bash', { command: 'cd x &&\n  ls -la', description: 'list' })).toBe('cd x && ls -la')
  })

  test('Read, Edit and Write give the path; Agent its description', () => {
    expect(toolBrief('Read', { file_path: '/a/b.ts', limit: 5 })).toBe('/a/b.ts')
    expect(toolBrief('Edit', { old_string: 'x', file_path: '/a/c.ts' })).toBe('/a/c.ts')
    expect(toolBrief('Write', { content: 'x', file_path: '/a/d.ts' })).toBe('/a/d.ts')
    expect(toolBrief('Agent', { prompt: 'long', description: 'review task 1' })).toBe('review task 1')
  })

  test('Grep and Glob give the pattern, in the path when there is one', () => {
    expect(toolBrief('Grep', { pattern: 'foo.*', path: 'hooks' })).toBe('foo.* in hooks')
    expect(toolBrief('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  test('an unknown tool gives its first string field; none gives nothing', () => {
    expect(toolBrief('Mystery', { n: 3, flag: true, what: 'thing', other: 'x' })).toBe('thing')
    expect(toolBrief('Mystery', { n: 3 })).toBe('')
  })

  test('strips escapes and caps the brief at 300 characters', () => {
    expect(toolBrief('Bash', { command: '\x1b[1mls\x1b[0m\x07' })).toBe('ls')
    const b = toolBrief('Bash', { command: 'x'.repeat(1000) })
    expect(b).toHaveLength(300)
    expect(b.endsWith('…')).toBe(true)
  })
})

const use = (id: string, tool: string, input: Record<string, unknown>, over: Partial<ToolUseSummary> = {}): ToolUseSummary => ({
  tool_use_id: id,
  tool,
  input,
  text: 'ok',
  ...over,
})
const tmsg = (role: 'user' | 'assistant', text: string, uses: ToolUseSummary[] = []): SessionMessage => ({ role, text, toolUses: uses })
const noStamps = () => undefined
const opts0 = { n: 12, chars: 2000, startedAt: 1000 }

describe('transcriptItems', () => {
  test('gives one text item and one tool item per use, in order', () => {
    const items = transcriptItems(
      [tmsg('user', 'go'), tmsg('assistant', 'looking', [use('t1', 'Bash', { command: 'ls' }), use('t2', 'Read', { file_path: '/x' })])],
      noStamps,
      opts0,
    )
    expect(items.map(i => i.kind)).toEqual(['text', 'text', 'tool', 'tool'])
    expect(items[0]).toMatchObject({ kind: 'text', role: 'user', text: 'go' })
    expect(items[1]).toMatchObject({ kind: 'text', role: 'assistant', text: 'looking' })
    expect(items[2]).toMatchObject({ kind: 'tool', toolUseId: 't1', tool: 'Bash', brief: 'ls' })
    expect(items[3]).toMatchObject({ kind: 'tool', toolUseId: 't2', tool: 'Read', brief: '/x' })
  })

  test('a message without text gives only its tool items; a tool-result-only user row adds nothing', () => {
    const results: SessionMessage = { ...tmsg('user', ''), toolResults: [{ tool_use_id: 't1', text: 'ok' } as never] }
    const items = transcriptItems([tmsg('assistant', '', [use('t1', 'Bash', { command: 'ls' })]), results], noStamps, opts0)
    expect(items.map(i => i.kind)).toEqual(['tool'])
  })

  test('keeps only the last n items', () => {
    const all = [tmsg('user', 'one'), tmsg('assistant', 'two', [use('t1', 'Bash', { command: 'a' })]), tmsg('assistant', 'three')]
    const items = transcriptItems(all, noStamps, { ...opts0, n: 3 })
    expect(items.map(i => (i.kind === 'text' ? i.text : i.brief))).toEqual(['two', 'a', 'three'])
  })

  test('strips escapes, keeps the text as written and caps it at chars', () => {
    const items = transcriptItems([tmsg('assistant', 'a\n  b'), tmsg('assistant', `\x1b[31m${'x'.repeat(50)}`)], noStamps, {
      ...opts0,
      chars: 20,
    })
    expect((items[0] as { text: string }).text).toBe('a\n  b')
    const long = (items[1] as { text: string }).text
    expect(long).toHaveLength(20)
    expect(long.endsWith('…')).toBe(true)
  })

  test('a tool name with escapes is drawn clean', () => {
    const [it] = transcriptItems([tmsg('assistant', '', [{ tool_use_id: 'e', tool: '\x1b[31mBash', input: { command: 'ls' } }])], () => undefined, {
      n: 5,
      chars: 100,
      startedAt: 0,
    })
    expect(it).toMatchObject({ kind: 'tool', tool: 'Bash' })
  })

  test('carries isError, and isPending for a call with no result text', () => {
    const items = transcriptItems(
      [tmsg('assistant', '', [use('t1', 'Bash', { command: 'a' }, { isError: true }), use('t2', 'Bash', { command: 'b' }, { text: undefined })])],
      noStamps,
      opts0,
    )
    expect(items[0]).toMatchObject({ isError: true })
    expect('isPending' in items[0]!).toBe(false)
    expect(items[1]).toMatchObject({ isPending: true })
    expect('isError' in items[1]!).toBe(false)
  })
})

describe('transcriptItems stamps', () => {
  const stamps = (m: Record<string, number>) => (k: string) => m[k]

  test('a tool item takes its tool_use_id stamp', () => {
    const items = transcriptItems([tmsg('user', 'go'), tmsg('assistant', '', [use('t1', 'Bash', { command: 'a' })])], stamps({ t1: 5000 }), opts0)
    expect(items[1]!.t).toBe(5000)
  })

  test('a text item takes its textKey stamp, else its first tool use stamp', () => {
    const all = [
      tmsg('user', 'brief'),
      tmsg('assistant', 'stamped  text'),
      tmsg('assistant', 'unstamped', [use('t2', 'Read', { file_path: '/x' }), use('t3', 'Read', { file_path: '/y' })]),
    ]
    const items = transcriptItems(all, stamps({ [textKey('assistant', 'stamped text')]: 7000, t2: 8000, t3: 9000 }), opts0)
    expect(items[1]!.t).toBe(7000)
    expect(items[2]!.t).toBe(8000)
    expect(items[4]!.t).toBe(9000)
  })

  test('message 0 takes startedAt; any other unstamped item has no t', () => {
    const items = transcriptItems([tmsg('user', 'brief'), tmsg('assistant', 'later')], noStamps, opts0)
    expect(items[0]!.t).toBe(1000)
    expect('t' in items[1]!).toBe(false)
  })

  test('a repeated text takes its own stamp of several, aligned from the end', () => {
    const key = textKey('assistant', 'same')
    const msgs = [tmsg('user', 'brief'), tmsg('assistant', 'same'), tmsg('assistant', 'x'), tmsg('assistant', 'same')]
    const both = transcriptItems(msgs, k => (k === key ? [100, 200] : undefined), opts0)
    expect([both[1]!.t, both[3]!.t]).toEqual([100, 200])
    // one stamp for two occurrences: the newest has it; the older was never seen
    const one = transcriptItems(msgs, k => (k === key ? [200] : undefined), opts0)
    expect(one[3]!.t).toBe(200)
    expect('t' in one[1]!).toBe(false)
    // a single number still stamps every occurrence
    const all = transcriptItems(msgs, k => (k === key ? 300 : undefined), opts0)
    expect([all[1]!.t, all[3]!.t]).toEqual([300, 300])
  })

  test('a repeated identical text gets distinct keys', () => {
    const items = transcriptItems([tmsg('user', 'brief'), tmsg('assistant', 'same'), tmsg('assistant', 'same')], noStamps, opts0)
    const base = textKey('assistant', 'same')
    expect(items[1]!.key).toBe(`${base}#0`)
    expect(items[2]!.key).toBe(`${base}#1`)
    expect(new Set(items.map(i => i.key)).size).toBe(3)
  })
})

describe('transcriptView', () => {
  const text = (over: Partial<TranscriptItem & { kind: 'text' }> = {}): TranscriptItem => ({
    kind: 'text',
    key: 'txt:a#0',
    role: 'assistant',
    text: 'hello',
    ...over,
  })

  test("a user text leaves room for its '» ' marker", () => {
    const fits = 40 - 6
    const user = transcriptView({ items: [text({ role: 'user', text: 'u'.repeat(fits) })] }, 40, 5) as { items: { short: string }[] }
    expect(user.items[0]!.short.length).toBe(fits - 2)
    expect(user.items[0]!.short.endsWith('…')).toBe(true)
    const said = transcriptView({ items: [text({ text: 'a'.repeat(fits) })] }, 40, 5) as { items: { short: string }[] }
    expect(said.items[0]!.short).toBe('a'.repeat(fits))
  })

  test('nothing read yet is loading; denied is the not-readable line; no items is nothing yet', () => {
    expect(transcriptView(undefined, 40, 5)).toEqual({ dim: 'loading…' })
    expect(transcriptView({ denied: true }, 40, 5)).toEqual({ dim: PEEK_DENIED })
    expect(transcriptView({ items: [] }, 40, 5)).toEqual({ dim: 'no messages yet' })
  })

  test('a stamped item shows hh:mm, an unstamped one --:--; the id is step-<key>', () => {
    const v = transcriptView({ items: [text({ t: Date.UTC(2026, 0, 1, 9, 5) }), text({ key: 'txt:b#0' })] }, 40, 5) as {
      items: { id: string; time: string }[]
    }
    expect(v.items[0]).toMatchObject({ id: 'step-txt:a#0', time: '09:05', short: 'hello', kind: 'text', role: 'assistant' })
    expect(v.items[1]!.time).toBe('--:--')
  })

  test('a long item is cut with an ellipsis and keeps its full text; a short one has no full', () => {
    const long = 'y'.repeat(100)
    const v = transcriptView({ items: [text({ text: long }), text({ key: 'txt:b#0', text: 'short' })] }, 40, 5) as {
      items: { short: string; full?: string }[]
    }
    expect(v.items[0]!.short).toHaveLength(34)
    expect(v.items[0]!.short.endsWith('…')).toBe(true)
    expect(v.items[0]!.full).toBe(long)
    expect('full' in v.items[1]!).toBe(false)
  })

  test('a tool item reads ⚙ <Tool> <brief> and carries its id and flags', () => {
    const tool: TranscriptItem = { kind: 'tool', key: 'tool:t1', toolUseId: 't1', tool: 'Bash', brief: 'ls', isError: true, isPending: true }
    const v = transcriptView({ items: [tool] }, 40, 5) as { items: Record<string, unknown>[] }
    expect(v.items[0]).toMatchObject({ id: 'step-tool:t1', short: '⚙ Bash ls', kind: 'tool', toolUseId: 't1', isError: true, isPending: true })
    const bare = transcriptView({ items: [{ ...tool, brief: '' }] }, 40, 5) as { items: { short: string }[] }
    expect(bare.items[0]!.short).toBe('⚙ Bash')
  })

  test('n keeps the last items', () => {
    const items = ['a', 'b', 'c'].map(k => text({ key: k, text: k }))
    const v = transcriptView({ items }, 40, 2) as { items: { short: string }[] }
    expect(v.items.map(i => i.short)).toEqual(['b', 'c'])
  })
})

describe('review fixes', () => {
  test('textKey strips control characters before collapsing whitespace', () => {
    expect(textKey('assistant', 'a \x07 b')).toBe(textKey('assistant', 'a b'))
  })

  test('a text item keeps its newlines; the view flattens short but full keeps them', () => {
    const [item] = transcriptItems([tmsg('assistant', 'line one\n\x1b[31mline\x1b[0m two\x07')], noStamps, opts0)
    expect((item as { text: string }).text).toBe('line one\nline two')
    const v = transcriptView({ items: [{ kind: 'text', key: 'k', role: 'assistant', text: `first\n${'z'.repeat(80)}` }] }, 40, 5) as {
      items: { short: string; full?: string }[]
    }
    expect(v.items[0]!.short.includes('\n')).toBe(false)
    expect(v.items[0]!.short.startsWith('first z')).toBe(true)
    expect(v.items[0]!.full).toBe(`first\n${'z'.repeat(80)}`)
    const flat = transcriptView({ items: [{ kind: 'text', key: 'k', role: 'assistant', text: 'a\nb' }] }, 40, 5) as {
      items: { short: string; full?: string }[]
    }
    expect(flat.items[0]!.short).toBe('a b')
  })

  test('a repeated text keeps its key when earlier copies scroll out of the window', () => {
    const all = [tmsg('user', 'brief'), tmsg('assistant', 'same'), tmsg('assistant', 'other'), tmsg('assistant', 'same')]
    const items = transcriptItems(all, noStamps, { ...opts0, n: 1 })
    expect(items[0]!.key).toBe(`${textKey('assistant', 'same')}#1`)
  })

  test('message 0 is the brief only when the transcript was not cut at 4096 entries', () => {
    const full = Array.from({ length: 4096 }, (_, i) => tmsg('assistant', `m${i}`))
    const items = transcriptItems(full, noStamps, { ...opts0, n: 4096 })
    expect('t' in items[0]!).toBe(false)
    const short = transcriptItems(full.slice(0, 4095), noStamps, { ...opts0, n: 1 + 4095 })
    expect(short[0]!.t).toBe(1000)
  })

  test('a failed or running tool item leaves room for its markers', () => {
    const tool: TranscriptItem = { kind: 'tool', key: 'tool:t1', toolUseId: 't1', tool: 'Bash', brief: 'x'.repeat(100) }
    const len = (it: TranscriptItem) => ((transcriptView({ items: [it] }, 40, 5) as { items: { short: string }[] }).items[0]!.short.length)
    expect(len(tool)).toBe(34)
    expect(len({ ...tool, isError: true })).toBe(32)
    expect(len({ ...tool, isPending: true })).toBe(24)
    expect(len({ ...tool, isError: true, isPending: true })).toBe(22)
  })

  test('modelName drops a -latest suffix', () => {
    expect(modelName('claude-3-5-haiku-latest')).toBe('Haiku 3.5')
    expect(modelName('claude-sonnet-4-5-latest')).toBe('Sonnet 4.5')
  })
})

describe('cleanBlock', () => {
  test('keeps only newline and tab among control characters', () => {
    expect(cleanBlock('a\x1b[1;32mb\x1b[0m\tc\r\nd\x07e\x00f')).toBe('ab\tc\ndef')
  })

  test('strips the one-byte CSI form and OSC sequences whole', () => {
    expect(cleanBlock('\x9b31mred\x9b0m')).toBe('red')
    expect(cleanBlock('\x1b]8;;http://x\x07link\x1b]8;;\x1b\\')).toBe('link')
  })
})

describe('namesAgent', () => {
  test('a SendMessage `to` names a row by id or name; main by "main"', () => {
    const r = row({ id: 'agent2', name: 'impl-2' })
    expect(namesAgent('agent2', r)).toBe(true)
    expect(namesAgent('impl-2', r)).toBe(true)
    expect(namesAgent('impl-3', r)).toBe(false)
    expect(namesAgent(undefined, r)).toBe(false)
    expect(namesAgent({ agentId: 'agent2' }, r)).toBe(false)
    expect(namesAgent('main', main())).toBe(true)
    expect(namesAgent('main', r)).toBe(false)
    // ListAgents rows carry a ` [ref]` after the name
    expect(namesAgent('impl-2 [3fa9c1]', r)).toBe(true)
    expect(namesAgent('agent2 [3fa9c1]', r)).toBe(true)
    expect(namesAgent('impl-3 [3fa9c1]', r)).toBe(false)
  })

  test("a teammate is named by its address too: its teammateId, or its name at the address's team", () => {
    const t = { ...row({ id: 'agent2', name: 'impl-2' }), teammateId: 'impl-2@s' }
    expect(namesAgent('impl-2@s', t)).toBe(true)
    expect(namesAgent('impl-2@s [3fa9c1]', t)).toBe(true)
    expect(namesAgent('impl-2', t)).toBe(true)
    expect(namesAgent('impl-2@other', t)).toBe(false)
    expect(namesAgent('impl-3@s', t)).toBe(false)
    // a replacement registered under a new name keeps its team: its name at that team names it
    const renamed = { ...row({ id: 'agent3', name: 'impl-2-2' }), teammateId: 'impl-2@s' }
    expect(namesAgent('impl-2-2@s', renamed)).toBe(true)
    // no teammateId: an address names nothing
    expect(namesAgent('impl-2@s', row({ id: 'agent2', name: 'impl-2' }))).toBe(false)
  })
})

describe('resolveAgent', () => {
  test('an id, then a registered name, then the name it asked for', () => {
    const a1 = row({ id: 'a1', name: 'orchestrator-2', brief: { prompt: 'P', subagentType: 'x', description: 'd', name: 'orchestrator' } })
    for (const t of ['a1', 'orchestrator-2', 'orchestrator']) expect(resolveAgent([a1], t)).toEqual({ row: a1 })
    expect(resolveAgent([a1], 'nope')).toBeUndefined()
    expect(resolveAgent([a1], '')).toBeUndefined()
  })

  test("a registered name beats another agent's requested name", () => {
    const a1 = row({ id: 'a1', name: 'orchestrator' })
    const a2 = row({ id: 'a2', name: 'orchestrator-2', brief: { prompt: 'P', subagentType: 'x', description: 'd', name: 'orchestrator' } })
    expect(resolveAgent([a1, a2], 'orchestrator')).toEqual({ row: a1 })
    expect(resolveAgent([a2, a1], 'orchestrator')).toEqual({ row: a1 })
  })

  test('a requested name held by two is ambiguous, unless exactly one is live', () => {
    const asked = (id: string, name: string, askedFor: string, over: Partial<AgentRow> = {}) =>
      row({ id, name, brief: { prompt: 'P', subagentType: 'x', description: 'd', name: askedFor }, ...over })
    const i2 = asked('a1', 'impl-2', 'impl')
    const i3 = asked('a2', 'impl-3', 'impl')
    expect(resolveAgent([i2, i3], 'impl')).toEqual({ ambiguous: [i2, i3] })
    const done = { ...i2, status: 'done' as const }
    expect(resolveAgent([done, i3], 'impl')).toEqual({ row: i3 })
    const original = asked('a1', 'probe-x', 'probe', { status: 'replaced', replacedBy: 'a2' })
    const replacement = asked('a2', 'probe-2', 'probe')
    expect(resolveAgent([original, replacement], 'probe')).toEqual({ row: replacement })
  })

  test('a trailing [ref] is ignored', () => {
    const a1 = row({ id: 'a1', name: 'orchestrator-2' })
    expect(resolveAgent([a1], 'orchestrator-2 [a1]')).toEqual({ row: a1 })
  })
})

describe('sameReport', () => {
  test('matches the same text however it is spaced, or one nearly containing the other', () => {
    expect(sameReport('Done: all 3 tests\n pass.', 'Done: all 3 tests pass.')).toBe(true)
    expect(sameReport('Report: tests pass, gates green.', 'Report: tests pass, gates green')).toBe(true)
    expect(sameReport('started', 'Report: tests pass, gates green, all done here.')).toBe(false)
    expect(sameReport('Report A', 'Totally different report B')).toBe(false)
    expect(sameReport('', '')).toBe(false)
  })
})

describe('checkinDue', () => {
  test('is every row whose check-in deadline has come', () => {
    const rows = [row({ id: 'a', checkinAt: 100 }), row({ id: 'b', checkinAt: 101 }), row({ id: 'c' })]
    expect(checkinDue(rows, 100).map(r => r.id)).toEqual(['a'])
    expect(checkinDue(rows, 200).map(r => r.id)).toEqual(['a', 'b'])
  })
})

describe('watchdogDue', () => {
  const MIN = 60_000
  const idle = (over: Partial<AgentRow> = {}) => row({ id: 'a', status: 'idle', lastActive: 0, ...over })
  const listed = (entries: Record<string, string>) => new Map(Object.entries(entries))

  test('an idle row the engine lists idle, past idleMs, is due', () => {
    const a = idle()
    expect(watchdogDue([main(), a], listed({ a: 'idle' }), 5 * MIN, 5 * MIN).map(r => r.id)).toEqual(['a'])
  })

  test('not main, not engine completed/waiting/unlisted, not with busy children, not with shells, not before idleMs', () => {
    const m = main({ status: 'idle' })
    expect(watchdogDue([m], listed({ main: 'idle' }), 10 * MIN, 5 * MIN)).toEqual([])
    for (const s of ['completed', 'waiting', 'running', 'failed', 'killed']) {
      expect(watchdogDue([idle()], listed({ a: s }), 10 * MIN, 5 * MIN)).toEqual([])
    }
    expect(watchdogDue([idle()], listed({}), 10 * MIN, 5 * MIN)).toEqual([])
    const p = idle()
    const kid = row({ id: 'c', parentId: 'a', status: 'idle', lastActive: 0 })
    expect(watchdogDue([p, kid], listed({ a: 'idle' }), 10 * MIN, 5 * MIN)).toEqual([])
    const settled = row({ id: 'c', parentId: 'a', status: 'done' })
    expect(watchdogDue([p, settled], listed({ a: 'idle' }), 10 * MIN, 5 * MIN).map(r => r.id)).toEqual(['a'])
    const shell = { id: 'b1', outputPath: '', description: 'x', command: 'x', startedAt: 0 }
    expect(watchdogDue([idle({ shells: [shell] })], listed({ a: 'idle' }), 10 * MIN, 5 * MIN)).toEqual([])
    expect(watchdogDue([idle({ shells: [] })], listed({ a: 'idle' }), 10 * MIN, 5 * MIN).map(r => r.id)).toEqual(['a'])
    expect(watchdogDue([idle({ lastActive: 6 * MIN })], listed({ a: 'idle' }), 10 * MIN, 5 * MIN)).toEqual([])
    for (const s of ['running', 'done', 'handing-over'] as const) {
      expect(watchdogDue([idle({ status: s })], listed({ a: 'idle' }), 10 * MIN, 5 * MIN)).toEqual([])
    }
  })

  test('nudged: not due until two turns have ended', () => {
    const at = (ends: number) => watchdogDue([idle({ watchdog: { t: 0, ends } })], listed({ a: 'idle' }), 10 * MIN, 5 * MIN)
    expect(at(0)).toEqual([])
    expect(at(1)).toEqual([])
    expect(at(2).map(r => r.id)).toEqual(['a'])
  })

  test('idleMs 0: none', () => {
    expect(watchdogDue([idle()], listed({ a: 'idle' }), 10 * MIN, 0)).toEqual([])
  })
})

describe('forwardTarget', () => {
  const child = (over: Partial<AgentRow> = {}) => row({ id: 'agent2', name: 'impl-2', parentId: 'agent1', background: true, ...over })

  test('forwards a background child of a subagent its final answer', () => {
    expect(forwardTarget(child(), 'R', 'answer')).toEqual({ agentId: 'agent1', mayDuplicate: false })
  })

  test('skips main and absent parents, teammates, foreground children, handovers, empty or unfinished answers', () => {
    expect(forwardTarget(child({ parentId: 'main' }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ parentId: undefined }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ isTeammate: true }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ background: false }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ status: 'handing-over' }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ status: 'stalled' }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child(), '  \n', 'answer')).toBe('skip')
    expect(forwardTarget(child(), 'R', 'aborted')).toBe('skip')
    expect(forwardTarget(child(), 'R', 'error')).toBe('skip')
  })

  test('skips a run whose delivered report to the parent was its last act, or matches the answer', () => {
    expect(forwardTarget(child({ report: { t: 1, text: 'early', ok: true, final: true } }), 'R', 'answer')).toBe('skip')
    expect(forwardTarget(child({ report: { t: 1, text: 'All done: R', ok: true, final: false } }), 'All done: R', 'answer')).toBe('skip')
  })

  test('a replacement is forwarded even when it inherited foreground', () => {
    expect(forwardTarget(child({ background: false, replaces: 'agent9' }), 'R', 'answer')).toEqual({ agentId: 'agent1', mayDuplicate: false })
    expect(forwardTarget(child({ background: false, replaces: 'agent9', isTeammate: true }), 'R', 'answer')).toBe('skip')
  })

  test('forwards anyway, flagged, when the report failed, was not last and differs', () => {
    expect(forwardTarget(child({ report: { t: 1, text: 'early', ok: true, final: false } }), 'Final R', 'answer')).toEqual({
      agentId: 'agent1',
      mayDuplicate: true,
    })
    expect(forwardTarget(child({ report: { t: 1, text: 'R', ok: false, final: true } }), 'R', 'answer')).toEqual({
      agentId: 'agent1',
      mayDuplicate: true,
    })
  })
})

describe('latest', () => {
  test('follows the replacedBy chain to the newest agent; an unknown or unreplaced id is itself', () => {
    const rows = [
      row({ id: 'a1', replacedBy: 'a2' }),
      row({ id: 'a2', replacedBy: 'a3' }),
      row({ id: 'a3' }),
      row({ id: 'b1', replacedBy: 'ghost' }),
    ]
    expect(latest(rows, 'a1')).toBe('a3')
    expect(latest(rows, 'a3')).toBe('a3')
    expect(latest(rows, 'main')).toBe('main')
    expect(latest(rows, 'zz')).toBe('zz')
    expect(latest(rows, 'b1')).toBe('ghost')
  })

  test('a cycle ends instead of looping', () => {
    const rows = [row({ id: 'x', replacedBy: 'y' }), row({ id: 'y', replacedBy: 'x' })]
    expect(['x', 'y']).toContain(latest(rows, 'x'))
  })

  test('forwardTarget sends to the parent latest replacement', () => {
    const rows = [row({ id: 'p1', replacedBy: 'p2' }), row({ id: 'p2' })]
    const c = row({ id: 'c', parentId: 'p1', background: true })
    expect(forwardTarget(c, 'R', 'answer', rows)).toEqual({ agentId: 'p2', mayDuplicate: false })
  })
})

describe('collapse', () => {
  const tree = (over: Record<string, Partial<AgentRow>> = {}) => [
    main(),
    row({ id: 'o', parentId: 'main', status: 'idle', ...over.o }),
    row({ id: 'd1', parentId: 'o', status: 'done', ...over.d1 }),
    row({ id: 'd2', parentId: 'o', status: 'done', ...over.d2 }),
    row({ id: 'r1', parentId: 'o', status: 'running', ...over.r1 }),
  ]
  const ids = (s: Set<string>) => [...s].sort()

  test('childrenOf: main has the top-level rows, an orchestrator its own', () => {
    const rows = [...tree(), row({ id: 'top2', parentId: undefined })]
    expect(childrenOf(rows, 'main').map(r => r.id)).toEqual(['o', 'top2'])
    expect(childrenOf(rows, 'o').map(r => r.id)).toEqual(['d1', 'd2', 'r1'])
    expect(childrenOf(rows, 'd1')).toEqual([])
  })

  test('collapsing hides done and replaced descendants only, and nothing when not collapsed', () => {
    expect(ids(collapseHidden(tree(), ['o']))).toEqual(['d1', 'd2'])
    expect(ids(collapseHidden(tree(), []))).toEqual([])
    expect(ids(collapseHidden(tree({ d2: { status: 'replaced' } }), ['o']))).toEqual(['d1', 'd2'])
  })

  test('a done child with a live grandchild stays; its own done children go', () => {
    const rows = [
      ...tree(),
      row({ id: 'g1', parentId: 'd1', status: 'running' }),
      row({ id: 'g2', parentId: 'd1', status: 'done' }),
    ]
    expect(ids(collapseHidden(rows, ['o']))).toEqual(['d2', 'g2'])
  })

  test('a fully finished orchestrator collapsed hides all its descendants', () => {
    const rows = tree({ r1: { status: 'done' } })
    expect(ids(collapseHidden(rows, ['o']))).toEqual(['d1', 'd2', 'r1'])
  })

  test('main collapsed hides finished top-level agents and keeps running and stalled ones', () => {
    const rows = [
      main(),
      row({ id: 'a', parentId: 'main', status: 'done' }),
      row({ id: 'b', parentId: 'main', status: 'running' }),
      row({ id: 'c', parentId: 'main', status: 'stalled' }),
      row({ id: 'e', parentId: 'main', status: 'replaced' }),
    ]
    expect(ids(collapseHidden(rows, ['main']))).toEqual(['a', 'e'])
  })

  test('collapsing never hides a respawn-failed descendant', () => {
    expect(ids(collapseHidden(tree({ d2: { status: 'respawn-failed' } }), ['o']))).toEqual(['d1'])
    expect(ids(collapseHidden(tree({ d2: { status: 'respawn-failed' } }), ['main']))).toEqual(['d1'])
  })

  test('a stale id or a childless row hides nothing; hiddenCount matches', () => {
    expect(ids(collapseHidden(tree(), ['ghost', 'd1']))).toEqual([])
    const hidden = collapseHidden(tree(), ['o'])
    expect(hiddenCount(tree(), 'o', hidden)).toBe(2)
    expect(hiddenCount(tree(), 'main', hidden)).toBe(2)
    expect(hiddenCount(tree(), 'r1', hidden)).toBe(0)
  })

  test('canFold: a row with finished descendants, or collapsed; not a childless or all-live row', () => {
    expect(canFold(tree(), 'o', [])).toBe(true)
    const live = tree({ d1: { status: 'running' }, d2: { status: 'running' } })
    expect(canFold(live, 'o', [])).toBe(false)
    expect(canFold(live, 'o', ['o'])).toBe(true)
    expect(canFold(tree(), 'd1', [])).toBe(false)
    expect(canFold(tree(), 'main', [])).toBe(true)
    const grand = [
      ...tree({ d2: { status: 'running' } }),
      row({ id: 'g1', parentId: 'd1', status: 'running' }),
      row({ id: 'g2', parentId: 'd1', status: 'done' }),
    ]
    expect(canFold(grand, 'o', [])).toBe(true)
  })

  test('foldGlyph: ▸ collapsed, ▾ expanded', () => {
    expect(foldGlyph(true)).toBe('▸')
    expect(foldGlyph(false)).toBe('▾')
  })

  test('contextChart takes a given t0 for its left axis, else the rows', () => {
    const rows = [row({ id: 'x', startedAt: 600_000, samples: [{ t: 600_000, tokens: 10 }] })]
    const base2 = { ...base, now: 900_000, colors: new Map([['x', '#000']]), selected: '' }
    expect(contextChart({ ...base2, rows }).source).toContain(`>${hhmm(600_000)}<`)
    expect(contextChart({ ...base2, rows, t0: 60_000 }).source).toContain(`>${hhmm(60_000)}<`)
  })
})

describe('redirectTarget', () => {
  const r1 = row({ id: 'a1', name: 'probe', status: 'replaced', replacedBy: 'a2', startedAt: 1 })
  const r2 = row({ id: 'a2', name: 'probe-2', status: 'running', startedAt: 2 })
  test('a replaced agent named by name, id or a ListAgents row gives its replacement', () => {
    for (const to of ['probe', 'a1', 'probe [ref]']) expect(redirectTarget([r1, r2], to)).toBe(r2)
  })
  test('a chain gives the newest replacement', () => {
    const a2 = { ...r2, status: 'replaced' as const, replacedBy: 'a3' }
    const a3 = row({ id: 'a3', name: 'probe-3', status: 'running', startedAt: 3 })
    expect(redirectTarget([r1, a2, a3], 'probe')).toBe(a3)
  })
  test('a name a live agent holds is left as addressed', () => {
    const live = row({ id: 'b1', name: 'probe', status: 'idle', startedAt: 5 })
    expect(redirectTarget([r1, r2, live], 'probe')).toBeUndefined()
  })
  test('the replacement messaging its predecessor is left as addressed', () => {
    expect(redirectTarget([r1, r2], 'probe', 'a2')).toBeUndefined()
  })
  test('a respawn-failed row, a non-string to and an unknown name are left as addressed', () => {
    const gap = row({ id: 'a1', name: 'probe', status: 'respawn-failed', startedAt: 1 })
    expect(redirectTarget([gap], 'probe')).toBeUndefined()
    expect(redirectTarget([r1, r2], { agentId: 'a1' })).toBeUndefined()
    expect(redirectTarget([r1, r2], 'nobody')).toBeUndefined()
  })
  test('a replacement that holds the same name is no redirect for that name; the old id still is', () => {
    const old = row({ id: 'a1', name: 'probe', status: 'replaced', replacedBy: 'a2', startedAt: 1 })
    const dest = row({ id: 'a2', name: 'probe', status: 'done', replaces: 'a1', startedAt: 2 })
    expect(redirectTarget([old, dest], 'probe')).toBeUndefined()
    expect(redirectTarget([old, dest], 'probe [x]')).toBeUndefined()
    expect(redirectTarget([old, dest], 'a1')).toBe(dest)
  })
  test('a newer agent that took the old name, live or not, is no redirect for that name', () => {
    const A = row({ id: 'a1', name: 'probe', status: 'replaced', replacedBy: 'a2', startedAt: 1 })
    const B = row({ id: 'a2', name: 'probe-2', status: 'idle', startedAt: 2 })
    expect(redirectTarget([A, B], 'probe')).toBe(B)
    for (const status of ['done', 'respawn-failed', 'stalled'] as const) {
      const C = row({ id: 'a3', name: 'probe', status, startedAt: 3 })
      expect(redirectTarget([A, B, C], 'probe')).toBeUndefined()
    }
  })
  test('addressFor: the registered name, the teammate address for an address, else the id', () => {
    expect(addressFor(r2, 'probe')).toBe('probe-2')
    expect(addressFor({ ...r2, teammateId: 'probe-2@team' }, 'probe@team')).toBe('probe-2@team')
    expect(addressFor({ ...r2, name: undefined }, 'probe')).toBe('a2')
  })
})

describe('terminal budget', () => {
  test('terminalBase: viewport rows less agent rows, the frame, the button row and the open transcript box', () => {
    expect(terminalBase({ rows: 30, agents: 2, peekRows: 5, buttonRow: true })).toBe(14)
    expect(terminalBase({ rows: 30, agents: 2, peekRows: 5, buttonRow: false })).toBe(15)
  })
  test('expandCap leaves the activity at least 3 lines beside the border; a pane too small shows none', () => {
    expect(expandCap(14)).toBe(9)
    // One line of text and a cut marker would be all `…`: under 2 lines, none.
    expect(expandCap(7)).toBe(2)
    expect(expandCap(6)).toBe(0)
    expect(expandCap(5)).toBe(0)
    expect(expandCap(4)).toBe(0)
  })
  test('capLines keeps lines that fit and ends a cut list in …', () => {
    expect(capLines(['a', 'b'], 3)).toEqual(['a', 'b'])
    expect(capLines(['a', 'b', 'c', 'd'], 3)).toEqual(['a', 'b', '…'])
    expect(capLines(['a', 'b'], 1)).toEqual(['…'])
  })
})
