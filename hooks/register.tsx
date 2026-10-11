import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, LogEntry, MainPhase } from '../types'
import {
  HANDOVER_CLAUSE,
  contextOf,
  fmtTokens,
  handoverMessage,
  label,
  level,
  mainHandoverPrompt,
  newRow,
  notePathFor,
  orderRows,
  recordStep,
  replacementPrompt,
  resumePrompt,
  rosterMarkdown,
  timeline,
  wrapFill,
} from './core'
import { LIVE, ceilingOf, chartWidthPx, contextChart, cut, hhmm, logId, paneHeader, seriesColors } from './view'

type $ = EngineInterface

const PANE = 'orchestrator'
const SYNC_MS = 30_000
const STALL_MS = 20 * 60_000

const agentsAtom = atom({ plugin: 'orchestrator', key: 'agents' } as const, [] as AgentRow[])
const logAtom = atom({ plugin: 'orchestrator', key: 'log' } as const, [] as LogEntry[])
const phaseAtom = atom({ plugin: 'orchestrator', key: 'mainPhase' } as const, 'idle' as MainPhase)
const runAtom = atom({ plugin: 'orchestrator', key: 'runId' } as const, '')
/** The activity line whose full-text card a click pinned open ('' for none). */
const pinnedAtom = atom({ plugin: 'orchestrator', key: 'pinnedLog' } as const, '')
/** The agent whose chart line the desktop pane highlights ('' for none). */
const selectedAtom = atom({ plugin: 'orchestrator', key: 'selectedAgent' } as const, '')

const patch = (rows: AgentRow[], id: string, change: Partial<AgentRow>) =>
  rows.map(r => (r.id === id ? { ...r, ...change } : r))

const cfg = {
  agentThreshold: 450_000,
  mainThreshold: 450_000,
  mainMode: 'ask',
  autoRespawn: true,
  injectClause: true,
  runRoot: '',
}

/** Running or idle: an agent loop that has not settled or started handing over. */
const isActive = (r: AgentRow) => r.status === 'running' || r.status === 'idle'

/** A subagent that can be handed over now. */
const canHandOver = (r: AgentRow) => r.id !== 'main' && isActive(r)

/** The selection, or '' when it names no row (so a stale one fades no line). */
export const liveSelection = (rows: readonly AgentRow[], selected: string) =>
  rows.some(r => r.id === selected) ? selected : ''
// The run folder outlives a /clear (the session id changes, the run does not).
let runDirCache = ''
let paneOffered = false
/** Main is mid-turn: from its `turn.start` (main's alone) to its `turn.complete`. */
let mainBusy = false
/** A main handover asked for mid-turn: it starts when that turn ends. */
let mainHandoverQueued = false
/** A main handover is being set up: a second press in the meantime does nothing. */
let mainHandoverStarting = false
// The id the agent.spawn hook last saw started: a plugin's own spawn may resolve without it.
let lastSpawned: string | undefined


async function runDir($: $) {
  let id = await read($, runAtom)
  if (!id) {
    id = await $.session.id()
    await update($, runAtom, () => id)
  }
  const root = cfg.runRoot || `${await $.session.root()}/.orchestrator`
  runDirCache = `${root}/${id}`
  return runDirCache
}

/** Keeps the default run folder out of `git status` without touching the tracked .gitignore. */
async function excludeFromGit($: $) {
  if (cfg.runRoot) return
  const exclude = `${await $.session.root()}/.git/info/exclude`
  if (!(await $.fs.exists(exclude))) return
  const text = await $.fs.read(exclude)
  if (text.split('\n').some(line => line.trim() === '.orchestrator/')) return
  await $.fs.write(exclude, `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}.orchestrator/\n`)
}

/** After a /clear wiped the session's state, put it back from the run folder. */
async function restore($: $) {
  if (!runDirCache || (await read($, runAtom))) return
  const path = `${runDirCache}/state.json`
  if (!(await $.fs.exists(path))) return
  const saved = JSON.parse(await $.fs.read(path)) as { agents: AgentRow[]; mainPhase: MainPhase; runId: string }
  await update($, runAtom, () => saved.runId)
  await update($, agentsAtom, () => saved.agents)
  await update($, phaseAtom, () => saved.mainPhase)
}

async function log($: $, text: string, lvl: LogEntry['level'] = 'info') {
  const t = await $.clock.now()
  await update($, logAtom, l => [...l, { t, text, level: lvl }].slice(-200))
  if (lvl === 'warn') $.ui.toast(`orchestrator: ${text}`)
}

async function persist($: $) {
  const dir = await runDir($)
  const agents = await read($, agentsAtom)
  const mainPhase = await read($, phaseAtom)
  const runId = await read($, runAtom)
  await $.fs.write(`${dir}/state.json`, JSON.stringify({ runId, mainPhase, agents }))
  await $.fs.write(`${dir}/roster.md`, rosterMarkdown(agents))
  const subs = agents.filter(a => a.id !== 'main')
  const live = subs.filter(a => LIVE.includes(a.status))
  const main = agents.find(a => a.id === 'main')
  const top = live.reduce((m, a) => Math.max(m, a.tokens), 0)
  $.ui.status(
    [
      live.length ? `${live.length} agent${live.length === 1 ? '' : 's'}, max ${fmtTokens(top)}/${fmtTokens(cfg.agentThreshold)}` : '',
      main ? `main ${fmtTokens(main.tokens)}/${fmtTokens(cfg.mainThreshold)}` : '',
      mainPhase !== 'idle' && mainPhase !== 'cooldown' ? `handover: ${mainPhase}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined,
  )
}

// ---- pane presses ----------------------------------------------------

function togglePinned($: $, id: string) {
  return update($, pinnedAtom, p => (p === id ? '' : id))
}

function toggleSelected($: $, id: string) {
  return update($, selectedAtom, s => (s === id ? '' : id))
}

// ---- subagents -------------------------------------------------------

async function startHandover($: $, id: string, why: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r || !canHandOver(r)) return false
  const attempt = (r.handovers ?? 0) + 1
  const notePath = notePathFor(await runDir($), r, attempt)
  const now = await $.clock.now()
  await update($, agentsAtom, l =>
    patch(l, id, { status: 'handing-over', notePath, handoverAt: now, handovers: attempt, handoverVia: undefined }),
  )
  if (r.status === 'idle') return sendHandover($, id, why)
  // A message would wait in a busy teammate's inbox until its turn ends: it rides on the next tool result instead.
  await log($, `${label(r)} ${why}: HANDOVER goes with its next tool result`)
  await persist($)
  return true
}

/** Sends HANDOVER as a message, which wakes an idle teammate or resumes a finished subagent. */
async function sendHandover($: $, id: string, why: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r?.notePath) return false
  const sent = await $.session.send({ to: { agentId: id }, text: handoverMessage(r.notePath, cfg.autoRespawn) })
  if (sent.isDelivered) {
    const now = await $.clock.now()
    await update($, agentsAtom, l => patch(l, id, { handoverVia: 'message', handoverAt: now }))
    await log($, `${label(r)} ${why}: HANDOVER sent`)
  } else {
    await update($, agentsAtom, l => patch(l, id, { status: 'stalled' }))
    await log($, `${label(r)}: HANDOVER could not be delivered (${sent.reason})`, 'warn')
  }
  await persist($)
  return sent.isDelivered
}

async function tellParent($: $, parentId: string | undefined, text: string) {
  if (parentId === undefined || parentId === 'main') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    await $.session.send({ to: { agentId: parentId }, text })
  }
}

async function respawn($: $, old: AgentRow) {
  const brief = old.brief
  if (!brief || !old.notePath) {
    await log($, `${label(old)}: no brief recorded, cannot respawn`, 'warn')
    return
  }
  lastSpawned = undefined
  const res = await $.agent.spawn({
    prompt: replacementPrompt(brief, old.notePath),
    subagentType: brief.subagentType,
    description: brief.description,
    model: brief.model,
    name: brief.name,
  })
  const newId = res.agentId ?? lastSpawned
  if (res.deny !== undefined || !newId) {
    await log($, `${label(old)}: respawn refused (${res.deny ?? 'no agent id'})`, 'warn')
    return
  }
  // A teammate's name is suffixed when the original still holds it; the engine delivers its final reply itself.
  const info = (await $.agent.list()).find(a => a.id === newId)
  const name = info?.name ?? brief.name
  const isTeammate = info?.teammateId !== undefined
  const now = await $.clock.now()
  await update($, agentsAtom, l => {
    const known = l.some(a => a.id === newId) ? l : [...l, newRow(newId, now)]
    return known.map(a =>
      a.id === old.id
        ? { ...a, replacedBy: newId }
        : a.id === newId
          ? {
              ...a,
              name,
              description: brief.description,
              type: brief.subagentType,
              brief,
              replaces: old.id,
              parentId: old.parentId,
              isOurs: true,
              isTeammate,
            }
          : a,
    )
  })
  await log($, `${label(old)} replaced by ${newId}, resuming from ${old.notePath}`)
  await tellParent(
    $,
    old.parentId,
    `[orchestrator mod] Agent ${label(old)} (id ${old.id}) reached ${fmtTokens(old.tokens)} context and handed over; note at ${old.notePath}. ` +
      `Replacement id ${newId}${name ? ` (SendMessage name "${name}")` : ''} continues from the note. ` +
      `No action needed: do not spawn another.${!isTeammate && (old.parentId === 'main' || old.parentId === undefined) ? ' Its final report will be forwarded to you.' : ''} Update your roster.`,
  )
}

async function onAgentEnd($: $, id: string, answer: string) {
  const r = (await read($, agentsAtom)).find(a => a.id === id)
  if (!r) return
  if (r.status === 'handing-over') {
    if (r.notePath && (await $.fs.exists(r.notePath))) {
      await update($, agentsAtom, l => patch(l, id, { status: 'replaced' }))
      await log($, `${label(r)} handed over (${r.notePath})`)
      if (cfg.autoRespawn) await respawn($, { ...r, status: 'replaced' })
    } else if (r.handoverVia !== 'message') {
      // It finished before a tool result could carry the HANDOVER: the message wakes it to write the note.
      await sendHandover($, id, 'ended before seeing it')
      return
    } else {
      await update($, agentsAtom, l => patch(l, id, { status: 'done' }))
      await log($, `${label(r)} ended without writing its handover note`, 'warn')
    }
  } else if (isActive(r)) {
    await update($, agentsAtom, l => patch(l, id, { status: 'idle' }))
    if (r.isOurs && !r.isTeammate && r.parentId !== undefined) {
      const text = `[orchestrator mod] ${label(r)} (id ${id}, replacement for ${r.replaces}) reports:\n\n${answer}`
      if (r.parentId === 'main') $.clock.after(0, () => void $.prompt.submit({ text }))
      else await $.session.send({ to: { agentId: r.parentId }, text })
    }
  }
  await persist($)
}

/** Marks agents the engine no longer lists as done, and handovers that hang as stalled. */
async function sync($: $) {
  const listed = new Set((await $.agent.list()).map(a => a.id))
  const now = await $.clock.now()
  const rows = await read($, agentsAtom)
  let changed = false
  for (const r of rows) {
    if (r.id === 'main') continue
    if (r.status === 'handing-over' && r.handoverAt && now - r.handoverAt > STALL_MS) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'stalled' }))
      await log($, `${label(r)} has not handed over after ${Math.round(STALL_MS / 60_000)} min`, 'warn')
      void $.ui.notify(`${label(r)} has not handed over`, { title: 'orchestrator' })
      changed = true
    } else if (isActive(r) && !listed.has(r.id)) {
      await update($, agentsAtom, l => patch(l, r.id, { status: 'done' }))
      changed = true
    }
  }
  if (changed) await persist($)
}

// ---- main thread -----------------------------------------------------

function setPhase($: $, p: MainPhase) {
  return update($, phaseAtom, () => p)
}

async function startMainHandover($: $) {
  // Synchronous guards, before any await: a second press cannot start a second round.
  if (mainHandoverStarting) return
  if (mainBusy) {
    // A prompt submitted now would queue behind the running turn, whose end would then look for the note too early.
    if (mainHandoverQueued) return
    mainHandoverQueued = true
    await log($, 'main thread hands over when this turn ends')
    return
  }
  mainHandoverStarting = true
  try {
    const phase = await read($, phaseAtom)
    if (phase === 'writing' || phase === 'clearing') return
    const main = (await read($, agentsAtom)).find(a => a.id === 'main') ?? newRow('main', await $.clock.now())
    const attempt = (main.handovers ?? 0) + 1
    const notePath = `${await runDir($)}/handover/main-${attempt}.md`
    await update($, agentsAtom, l =>
      (l.some(a => a.id === 'main') ? l : [main, ...l]).map(a =>
        a.id === 'main' ? { ...a, notePath, handovers: attempt } : a,
      ),
    )
    await setPhase($, 'writing')
    await log($, `main thread at ${fmtTokens(main.tokens)}: writing handover note`)
    await persist($)
    await $.prompt.submit({ text: mainHandoverPrompt(notePath) })
  } finally {
    mainHandoverStarting = false
  }
}

async function finishMainHandover($: $) {
  const main = (await read($, agentsAtom)).find(a => a.id === 'main')
  const notePath = main?.notePath
  if (!notePath || !(await $.fs.exists(notePath))) {
    await setPhase($, 'idle')
    await log($, 'main thread did not write its handover note; not clearing', 'warn')
    await persist($)
    return
  }
  const note = await $.fs.read(notePath)
  await setPhase($, 'clearing')
  await persist($)
  await $.command.run({ command: 'clear' })
  await restore($)
  const agents = await read($, agentsAtom)
  await setPhase($, 'cooldown')
  await log($, `main thread cleared; resuming from ${notePath}`)
  await persist($)
  await $.prompt.submit({
    text: resumePrompt({ note, notePath, rosterPath: `${await runDir($)}/roster.md`, agents }),
  })
}

async function checkMain($: $, tokens: number) {
  const phase = await read($, phaseAtom)
  // 'clearing' too: a restart cut short (Esc) never reaches cooldown, so the next main step settles it.
  if ((phase === 'cooldown' || phase === 'clearing') && tokens < cfg.mainThreshold) await setPhase($, 'idle')
  if (phase === 'idle' && cfg.mainMode !== 'off' && tokens >= cfg.mainThreshold) {
    await setPhase($, 'offered')
    if (cfg.mainMode === 'ask') {
      await log($, `main thread at ${fmtTokens(tokens)}: handover offered above the prompt`, 'warn')
    }
  }
}

export const register: Register = (on, options) => {
  cfg.agentThreshold = Number(options.agentThreshold ?? 450_000)
  cfg.mainThreshold = Number(options.mainThreshold ?? 450_000)
  cfg.mainMode = String(options.mainHandover ?? 'ask')
  cfg.autoRespawn = options.autoRespawn !== false
  cfg.injectClause = options.injectClause !== false
  cfg.runRoot = String(options.runRoot ?? '').replace(/\/+$/, '')
  paneOffered = false
  mainBusy = false
  mainHandoverQueued = false
  mainHandoverStarting = false

  // ---- events ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch',
      description: 'Orchestrator: open or close the agents pane, show the roster, or hand an agent (or main) over now',
      argumentHint: '[close | roster | handover [name|id]]',
    })
    await runDir($)
    await excludeFromGit($).catch(() => undefined)
    $.clock.every(SYNC_MS, () => void sync($))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(cfg.injectClause ? { ...e, prompt: e.prompt + HANDOVER_CLAUSE } : e)
    if (res.deny !== undefined || !res.agentId) return res
    const id = res.agentId
    lastSpawned = id
    const type = e.subagentType ?? (e as typeof e & { subagent_type?: string }).subagent_type ?? 'agent'
    const now = await $.clock.now()
    await update($, agentsAtom, l => [
      ...l.filter(a => a.id !== id),
      {
        ...newRow(id, now),
        name: e.name,
        description: e.description,
        type,
        parentId: e.parentAgentId ?? 'main',
        brief: {
          prompt: e.prompt,
          subagentType: type,
          description: e.description,
          model: e.model,
          name: e.name,
        },
      },
    ])
    await log($, `spawned ${e.name ?? e.description} (${id})`)
    await persist($)
    if (!paneOffered) {
      paneOffered = true
      void $.ui.open({ id: PANE, title: 'Orchestrator' })
    }
    return res
 }).catch(($, e, next) => next(e)) // tracking failed: the spawn goes ahead either way

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (!res.usage) return res
    try {
      await restore($)
      const id = e.agentId ?? 'main'
      const now = await $.clock.now()
      if (id !== 'main' && !(await read($, agentsAtom)).some(a => a.id === id)) {
        const info = (await $.agent.list()).find(a => a.id === id)
        if (!info) return res // an engine fork (compaction, memory): not an agent of the run
        await update($, agentsAtom, l => [
          ...l,
          { ...newRow(id, now), name: info.name, description: info.description, type: info.type, parentId: info.parentId ?? 'main' },
        ])
      }
      const tokens = contextOf(res.usage)
      await update($, agentsAtom, l => recordStep(l, { id, tokens, t: now, tools: res.toolUses.length }))
      if (id === 'main') await checkMain($, tokens)
      else if (tokens >= cfg.agentThreshold) {
        const r = (await read($, agentsAtom)).find(a => a.id === id)
        const startedAt = r?.samples[0]?.tokens ?? 0
        if (r && r.replaces && startedAt >= cfg.agentThreshold * 0.5) {
          // Its brief and note alone fill half the window: another handover would only loop.
          if (!r.noHandover) {
            await update($, agentsAtom, l => patch(l, id, { noHandover: true }))
            await log(
              $,
              `${label(r)} starts at ${fmtTokens(startedAt)} (≥ half the ${fmtTokens(cfg.agentThreshold)} threshold): not handing it over again`,
              'warn',
            )
          }
        } else if (r && canHandOver(r)) {
          await startHandover($, id, `at ${fmtTokens(tokens)} ≥ ${fmtTokens(cfg.agentThreshold)}`)
        }
      }
      await persist($)
    } catch (err) {
      $.ui.log(`orchestrator: step not recorded: ${String(err)}`)
    }
    return res
  })

  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined || res.deny !== undefined) return res
    try {
      const r = (await read($, agentsAtom)).find(a => a.id === e.agentId)
      if (r?.status !== 'handing-over' || r.handoverVia || !r.notePath) return res
      await update($, agentsAtom, l => patch(l, r.id, { handoverVia: 'tool' }))
      await log($, `${label(r)}: HANDOVER delivered with a tool result`)
      await persist($)
      return { ...res, context: [...(res.context ?? []), handoverMessage(r.notePath, cfg.autoRespawn)] }
    } catch (err) {
      $.ui.log(`orchestrator: HANDOVER not attached: ${String(err)}`)
      return res
    }
  })

  // Raised for main's turns alone: a subagent's run raises no turn.start.
  on('turn.start', ($, e, next) => {
    mainBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main's turn is over whatever happens beneath: a failing `next` must not leave it marked busy.
    if (e.agentId === undefined) mainBusy = false
    const res = await next(e)
    try {
      if (e.agentId !== undefined) await onAgentEnd($, e.agentId, e.answer)
      else {
        const queued = mainHandoverQueued
        mainHandoverQueued = false
        const phase = await read($, phaseAtom)
        if (queued && phase !== 'writing' && phase !== 'clearing') {
          // Asked for mid-turn: started now, before the `writing` check, so this turn's end never looks for a note.
          $.clock.after(0, () => void startMainHandover($))
        } else if (phase === 'offered' && cfg.mainMode === 'auto' && !e.isAborted) {
          $.clock.after(0, () => void startMainHandover($))
        } else if (phase === 'writing') {
          $.clock.after(0, () => void finishMainHandover($))
        }
      }
    } catch (err) {
      $.ui.log(`orchestrator: turn end not handled: ${String(err)}`)
    }
    return res
  })

  on('command.run', { command: 'orch' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    const target = rest.join(' ')
    if (!verb) {
      await $.ui.open({ id: PANE, title: 'Orchestrator' })
      return { text: 'Orchestrator pane opened.' }
    }
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Orchestrator pane closed; /orch opens it again.' }
    }
    if (verb === 'roster') return { text: rosterMarkdown(await read($, agentsAtom)) }
    if (verb === 'handover' && (!target || target === 'main')) {
      $.clock.after(0, () => void startMainHandover($))
      return { text: 'Main thread handover started: it writes a note, then is cleared and resumed.' }
    }
    if (verb === 'handover') {
      const rows = await read($, agentsAtom)
      const live = rows.filter(canHandOver)
      const r = live.find(a => a.id === target) ?? live.filter(a => a.name === target).at(-1)
      if (!r) return { text: `No live agent named or with id "${target}".` }
      const ok = await startHandover($, r.id, 'by /orch')
      return { text: ok ? `HANDOVER sent to ${label(r)} (${r.id}).` : `Could not hand ${label(r)} over.` }
    }
    return { text: 'Usage: /orch [close | roster | handover [name|id|main]]' }
  })

  // ---- drawing ---------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const phase = await read($, phaseAtom)
    if (phase !== 'offered' || cfg.mainMode !== 'ask') return next(e)
    const main = (await read($, agentsAtom)).find(a => a.id === 'main')
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="warning">
          Main context {fmtTokens(main?.tokens ?? 0)} ≥ {fmtTokens(cfg.mainThreshold)}.{' '}
        </Text>
        <Button key="handover" variant="primary" label="Hand over & restart" onPress={() => startMainHandover($)} />
        <Text> </Text>
        <Button key="dismiss" label="Not now" onPress={() => setPhase($, 'cooldown')} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const rows = await read($, agentsAtom)
    const pinned = await read($, pinnedAtom)
    const entries = await read($, logAtom)
    const phase = await read($, phaseAtom)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const now = await $.clock.now()
    const header = paneHeader(rows, {
      agentThreshold: cfg.agentThreshold,
      mainThreshold: cfg.mainThreshold,
      mainMode: cfg.mainMode,
      phase,
    })
    const tone = { ok: 'success', warn: 'warning', hot: 'error' } as const

    if (e.surface !== 'terminal') {
      // Desktop, VS Code, mobile: a vector chart, native buttons, activity that expands in flow.
      const { Box, Button, Text, Svg } = $.ui.resolve(e)
      const selected = liveSelection(rows, await read($, selectedAtom))
      const colors = seriesColors(rows)
      const chart = contextChart({
        rows,
        now,
        width: chartWidthPx(cols),
        height: 180,
        agentThreshold: cfg.agentThreshold,
        mainThreshold: cfg.mainThreshold,
        colors,
        selected,
      })
      const canHandMain = cfg.mainMode !== 'off' && phase !== 'writing' && phase !== 'clearing'
      const fits = cols - 6
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text bold>{header}</Text>
            {canHandMain && (
              <Button
                key="handover:main"
                variant="secondary"
                label="Hand over main"
                onPress={() => startMainHandover($)}
              />
            )}
          </Box>
          {rows.length === 0 ? (
            <Text dimColor>No model requests yet.</Text>
          ) : (
            <Svg key="chart" isInteractive source={chart.source} alt={chart.alt} width={chart.width} height={chart.height} />
          )}
          <Box flexDirection="column">
            {orderRows(rows).map(({ row, depth }) => {
              const ceiling = ceilingOf(row, cfg)
              const pct = Math.round((row.tokens / ceiling) * 100)
              return (
                <Box key={`row:${row.id}`} flexDirection="row" paddingLeft={depth * 2} gap={1}>
                  <Button key={`agent:${row.id}`} plain onPress={() => toggleSelected($, row.id)}>
                    <Text color={colors.get(row.id)}>● </Text>
                    <Text bold={selected === row.id}>{label(row)} </Text>
                    <Text color={tone[level(row.tokens, ceiling)]}>
                      {fmtTokens(row.tokens)}/{fmtTokens(ceiling)} {pct}%{' '}
                    </Text>
                    <Text dimColor>{row.status}</Text>
                  </Button>
                  {canHandOver(row) && (
                    <Button
                      key={`handover:${row.id}`}
                      variant="secondary"
                      label="Hand over"
                      onPress={() => startHandover($, row.id, 'from the pane')}
                    />
                  )}
                </Box>
              )
            })}
          </Box>
          <Box flexDirection="column">
            <Text bold>Activity</Text>
            {entries.length === 0 && <Text dimColor>Nothing yet.</Text>}
            {entries.slice(-50).map((l, i) => {
              const color = l.level === 'warn' ? 'warning' : undefined
              if (l.text.length <= fits) {
                return (
                  <Text key={`l${i}`} color={color} wrap="wrap">
                    <Text dimColor>{hhmm(l.t)} </Text>
                    {l.text}
                  </Text>
                )
              }
              const id = logId(l)
              return (
                <Box key={`l${i}`} flexDirection="column">
                  <Button key={id} plain onPress={() => togglePinned($, id)}>
                    <Text dimColor>{hhmm(l.t)} </Text>
                    <Text color={color}>{cut(l.text, fits)}</Text>
                  </Button>
                  {pinned === id && (
                    <Box key={`full:${id}`} borderStyle="round" flexDirection="column">
                      <Text color={color} wrap="wrap">
                        {l.text}
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const NAME = Math.min(24, Math.max(12, Math.floor(cols * 0.25)))
    const width = Math.max(8, cols - NAME - 7 - 14)
    const t0 = rows.reduce((m, r) => Math.min(m, r.startedAt), now)
    const ordered = orderRows(rows)
    const glyph: Record<AgentStatus, string> = {
      running: '●',
      idle: '○',
      'handing-over': '↻',
      replaced: '⤳',
      done: '✓',
      stalled: '!',
    }
    const room = Math.max(3, (e.viewport?.rows ?? 30) - ordered.length - 8)
    return (
      <Box flexDirection="column">
        <Text bold>{header}</Text>
        {ordered.length === 0 && <Text dimColor>No model requests yet.</Text>}
        {ordered.map(({ row, depth }) => {
          const ceiling = ceilingOf(row, cfg)
          const live = LIVE.includes(row.status)
          const name = `${'  '.repeat(depth)}${glyph[row.status]} ${label(row)}`
          return (
            <Box key={row.id}>
              <Text dimColor={!live} wrap="truncate">
                {name.slice(0, NAME).padEnd(NAME)}
              </Text>
              <Text dimColor={!live}>{fmtTokens(row.tokens).padStart(6)} </Text>
              <Text color={live ? tone[level(row.tokens, ceiling)] : 'subtle'}>
                {timeline(row.samples, width, t0, now, ceiling, live)}
              </Text>
              <Text dimColor> {row.status.padEnd(12)}</Text>
            </Box>
          )
        })}
        <Text dimColor>
          {' '.repeat(NAME + 7)}
          {hhmm(t0).padEnd(Math.max(0, width - 5))}
          {hhmm(now)}
        </Text>
        <Text bold>Activity</Text>
        {entries.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {entries.slice(-room).map((l, i) => {
          const color = l.level === 'warn' ? 'warning' : undefined
          const fits = cols - 6
          if (l.text.length <= fits) {
            return (
              <Text key={`l${i}`} color={color} wrap="truncate">
                <Text dimColor>{hhmm(l.t)} </Text>
                {l.text}
              </Text>
            )
          }
          // Too long: cut with an ellipsis; the full text shows in a card above while hovered, or pinned by a click.
          const id = logId(l)
          // It overlays other lines and paints only the cells it writes: each line is padded to the full width.
          const inner = Math.max(10, cols - 4)
          const wrapped = wrapFill(l.text, inner)
          return (
            <Box key={`l${i}`}>
              <Button key={id} plain onPress={() => togglePinned($, id)}>
                <Text dimColor>{hhmm(l.t)} </Text>
                <Text color={color}>{cut(l.text, fits)}</Text>
              </Button>
              <Box
                position="absolute"
                top={-(wrapped.length + 2)}
                left={0}
                width={cols}
                borderStyle="round"
                flexDirection="column"
                display={pinned === id ? 'flex' : 'none'}
                hover={pinned === id ? undefined : { display: 'flex' }}
              >
                {wrapped.map((w, j) => (
                  <Text key={`w${j}`} color={color} wrap="truncate">{` ${w} `}</Text>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
