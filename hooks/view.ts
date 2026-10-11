import type { AgentRow, AgentStatus, LogEntry, MainPhase, Sample } from '../types'
import { fmtTokens, label, orderRows } from './core'

export const MAIN_COLOR = '#6B7280'
export const PALETTE: readonly string[] = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00']
export const LIMIT_COLOR = '#DC2626'

/** Statuses the pane draws as live. */
export const LIVE: readonly AgentStatus[] = ['running', 'idle', 'handing-over']

/** Today's terminal header: live and handed-over subagents, the limits, the main mode and any phase. */
export const paneHeader = (
  rows: readonly AgentRow[],
  o: { agentThreshold: number; mainThreshold: number; mainMode: string; phase: MainPhase },
): string => {
  const subs = rows.filter(r => r.id !== 'main')
  const live = subs.filter(r => LIVE.includes(r.status)).length
  const replaced = subs.filter(r => r.status === 'replaced').length
  return `${live} live · ${replaced} handed over · limits ${fmtTokens(o.agentThreshold)} / main ${fmtTokens(o.mainThreshold)} (${o.mainMode}${o.phase !== 'idle' ? `, ${o.phase}` : ''})`
}

/** main → MAIN_COLOR; every other row in orderRows order → PALETTE[i % PALETTE.length]. */
export const seriesColors = (rows: readonly AgentRow[]): Map<string, string> => {
  const out = new Map<string, string>()
  let i = 0
  for (const { row } of orderRows(rows)) {
    out.set(row.id, row.id === 'main' ? MAIN_COLOR : (PALETTE[i++ % PALETTE.length] ?? MAIN_COLOR))
  }
  return out
}

/** `log-${t}-${text.length}`: the id the terminal card already uses. */
export const logId = (l: LogEntry): string => `log-${l.t}-${l.text.length}`

/** clamp(bodyColumns * 8, 320, 1200) */
export const chartWidthPx = (bodyColumns: number): number => Math.min(1200, Math.max(320, bodyColumns * 8))

export type ChartInput = {
  rows: readonly AgentRow[]
  now: number
  width: number // CSS px
  height: number // CSS px
  agentThreshold: number
  mainThreshold: number
  colors: ReadonlyMap<string, string>
  selected?: string // agent id; '' or undefined = none
}

const M = { left: 44, right: 8, top: 8, bottom: 20 }
const AXIS = `fill="${MAIN_COLOR}" font-family="system-ui, sans-serif" font-size="10"`

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16)

const r1 = (n: number) => Math.round(n)

/** At most `max` samples: first and last kept, each bucket between reduced to its peak. */
const downsample = (s: readonly Sample[], max: number): readonly Sample[] => {
  if (s.length <= max || max < 2) return s
  const inner = s.slice(1, -1)
  const buckets = max - 2
  const out: Sample[] = [s[0]!]
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * inner.length) / buckets)
    const to = Math.floor(((b + 1) * inner.length) / buckets)
    let peak: Sample | undefined
    for (let i = from; i < to; i++) if (!peak || inner[i]!.tokens > peak.tokens) peak = inner[i]
    if (peak) out.push(peak)
  }
  out.push(s[s.length - 1]!)
  return out
}

/** The context chart for remote surfaces: one step-after line per agent over a shared time axis. */
export const contextChart = (i: ChartInput): { source: string; alt: string; width: number; height: number } => {
  const W = i.width
  const H = i.height
  const plotW = W - M.left - M.right
  const plotH = H - M.top - M.bottom
  const right = M.left + plotW
  const bottom = M.top + plotH
  const series = i.rows.filter(r => r.samples.length > 0)
  const t0 = i.rows.reduce((m, r) => Math.min(m, r.startedAt), i.now)
  const span = Math.max(1, i.now - t0)
  const peak = series.reduce((m, r) => Math.max(m, r.peak, ...r.samples.map(s => s.tokens)), 0)
  const yMax = Math.max(i.agentThreshold, i.mainThreshold, peak, 1) * 1.05
  const x = (t: number) => r1(Math.min(right, Math.max(M.left, M.left + ((t - t0) / span) * plotW)))
  const y = (v: number) => r1(M.top + plotH * (1 - Math.min(1, Math.max(0, v / yMax))))
  const ceilingOf = (r: AgentRow) => (r.id === 'main' ? i.mainThreshold : i.agentThreshold)
  const sel = i.selected ?? ''

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`,
    `<line x1="${M.left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${MAIN_COLOR}" stroke-width="1"/>`,
    `<text x="${M.left - 4}" y="${bottom}" text-anchor="end" ${AXIS}>0</text>`,
    `<text x="${M.left}" y="${H - 4}" ${AXIS}>${hhmm(t0)}</text>`,
    `<text x="${right}" y="${H - 4}" text-anchor="end" ${AXIS}>${hhmm(i.now)}</text>`,
  ]

  const limits =
    i.agentThreshold === i.mainThreshold
      ? [{ v: i.agentThreshold, text: `limit ${fmtTokens(i.agentThreshold)}` }]
      : [
          { v: i.agentThreshold, text: `agent limit ${fmtTokens(i.agentThreshold)}` },
          { v: i.mainThreshold, text: `main limit ${fmtTokens(i.mainThreshold)}` },
        ]
  for (const l of limits) {
    const ly = y(l.v)
    out.push(
      `<line x1="${M.left}" y1="${ly}" x2="${right}" y2="${ly}" stroke="${LIMIT_COLOR}" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<text x="${M.left + 2}" y="${ly - 2}" ${AXIS}>${esc(l.text)}</text>`,
    )
  }

  const maxPoints = Math.floor(plotW / 3)
  for (const r of series) {
    const pts = downsample(r.samples, maxPoints)
    const first = pts[0]!
    let d = `M${x(first.t)} ${y(first.tokens)}`
    let lastY = y(first.tokens)
    for (const p of pts.slice(1)) {
      const py = y(p.tokens)
      d += `H${x(p.t)}`
      if (py !== lastY) d += `V${py}`
      lastY = py
    }
    if (LIVE.includes(r.status)) d += `H${right}`
    const last = pts[pts.length - 1]!
    const color = i.colors.get(r.id) ?? MAIN_COLOR
    const isSel = sel !== '' && r.id === sel
    const width = isSel ? '3' : '1.5'
    const opacity = sel !== '' && !isSel ? '0.3' : '1'
    const title = `<title>${esc(`${label(r)} · ${fmtTokens(r.tokens)} / ${fmtTokens(ceilingOf(r))} · ${r.status}`)}</title>`
    out.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}">${title}</path>`,
      `<circle cx="${x(last.t)}" cy="${y(last.tokens)}" r="3" fill="${color}" opacity="${opacity}">${title}</circle>`,
    )
  }
  out.push('</svg>')

  const alt = series.length
    ? `Context over time: ${series.map(r => `${label(r)} ${fmtTokens(r.tokens)} of ${fmtTokens(ceilingOf(r))}`).join('; ')}`
    : 'No model requests yet.'
  return { source: out.join(''), alt, width: W, height: H }
}
