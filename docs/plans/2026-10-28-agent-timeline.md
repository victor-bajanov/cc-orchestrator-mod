# Agent Timeline view

Date: 2026-10-28 · Branch: `agent-timeline` · Mod version now: 0.3.11 (the orchestrator bumps it to **0.3.12** at the end; no task owns the bump) · Engine: 2.1.312

## Goal

Replace the per-agent transcript peek (the box under a selected row) with a **Timeline**: a view that takes over the whole Orchestrator pane for one agent, one row per turn, each expandable in place, each with a jump control to that turn in the agent's transcript. A `← agents` button returns to the list and chart as they are today. The tool-detail dialog (`TOOL_PANE`, `hooks/register.tsx:89`, `:2178`) is unchanged.

## Sources

- **T**: the fresh API types written by 2.1.312, `/private/tmp/claude-501/bundled-skills/2.1.312/63291c02590bf028a1e9aaa87ddb7038/plugin-authoring/types/claude-code.d.ts` (22,676 lines). The repo's copy `.claude-plugin/types/claude-code/index.d.ts` is 2.1.296 (15,990 lines) and is **git-ignored** (`.gitignore:1`); the engine rewrites it when it loads the plugin.
- **R** `hooks/register.tsx`, **RT** `hooks/register.test.ts`, **V** `hooks/view.ts`, **types** `types/index.d.ts`.

## Type diff 2.1.296 → 2.1.312, relevant parts only

- **New `$.ui.view(view: SiteView): Promise<{ deny? }>`** (T:2624-2640, result T:15565-15580). Puts an agent's transcript in the main view "as the person's own switch from the tasks list does"; `{}` goes back to main. Only while the call answers the person's own input (a press counts). Denies: not person-initiated, unknown id or not in the tasks list, teammate stopped or in a pane of its own, the view moved meanwhile, no surface. Also new events `ui.view` in/out (T:7239, T:7485). **This makes the brief's premise 1 false.** It does not exist on 2.1.296, so the code must feature-detect (`typeof $.ui.view === 'function'`).
- `$.ui.scroll` (T:2566-2579) is unchanged: `{ to: { requestId } | { key } | 'start' | 'end', in?, block? }`; a site of this plugin moves freely, a transcript row "only while this call answers the person's own input" (`{ deny: 'not person-initiated' }` otherwise). A row's `requestId` is "a transcript message's, a tool row's tool_use_id" (T:15537, T:15468-15475). Unchanged.
- `Pane` props (T:10950-11010): `isFocused`, `bodyColumns`, `placement`, `scroll: SiteScroll` (engine-owned, read-only; "moved by the person's keys while the pane is focused"), `view: SiteView` (read-only). Unchanged in kind. Docs now say a switch re-renders the same pane instance with the new view.
- `Button.hotkey` (T:1117-1124) is "one digit or one lowercase letter ... anything else is refused", armed only while the plugin's pane holds focus. Not new, but it decides premise 3 below. `Button.key` doc now insists every Button in a list has its own key.
- `Box` spacing props are now `Space` (a number or step name); numbers still work. No other change touches transcript ops, `SessionMessage` (T:11853) or `session.messages`.
- Everything else in the 1,000-line diff (agent.spawn docs, `session.identity`, `prompt.media/paint`, `settings` key reads) is irrelevant here.

## Premises checked

| # | Brief premise | Verdict | Decision |
| --- | --- | --- | --- |
| 1 | No op can change which transcript is on screen; `view.agentId` is read-only | **Half false.** `props.view` is still read-only, but 2.1.312 adds `$.ui.view`. | The jump control **switches the view itself** when the row's agent is not in view, then scrolls. If `$.ui.view` is not a function (engine older than 2.1.312) or denies, the inline note applies (D6). |
| 2 | `scroll({ to: { requestId }, block: 'start' })` works only while answering the person's input; row id is a tool_use_id; messages carry no ids | **True** (T:15452-15462, `SessionMessage` T:11853 has no id). | A turn jumps to its first tool call; a turn with no tool call has the jump control dim and inert. |
| 3 | An Esc or backspace hotkey goes back | **False.** `hotkey` accepts a digit or lowercase letter only (T:1117). Esc in a pane belongs to the host: it closes the pane (T:10950, "keyed by the person (ctrl+x tab, Esc)"). An `action` chord for Esc is unverified. | Back is the `← agents` button plus `hotkey="b"` (pane focused). Esc keeps its host meaning (closes the pane; `/orch` reopens it). README says so. |
| 4 | The pane scrolls a long list by wheel and keys | **True** for a tree taller than the body (T:10990-10997; band note T:10902). | No own windowing. A list is one tall column; the pane scrolls it. |

## Current code

- Selection: `selectedAtom` (R:104) holds the clicked agent; `toggleSelected` (R:394-398) flips it and calls `schedulePeek`. `liveSelection(visible, id)` drops a selection that left the list.
- Desktop pane render: `peek` from `transcriptView(...)` (R:2271-2272), the `item(agentId, it)` closure for one transcript line (R:2282-2321), and the peek drawn under the selected row (R:2378-2380). Terminal: `peek` (R:2443-2447), `peekRows`/`terminalBase` (R:2447-2453), `item` closure (R:2480-2515), peek drawn under the row (R:2590-2597). `TRANSCRIPT_MAX = 12` and `TRANSCRIPT_TERMINAL = 6` (R:442-444).
- Cache: `refreshTranscript` (R:468-484) stores `transcriptItems(messages, stampOf, { n: TRANSCRIPT_MAX, chars: STEP_CHARS, startedAt })` into `transcriptsAtom` (R:112). `transcriptItems` (V:239-290) already yields, per message, its text then one item per tool call, with `t` stamps; user rows of tool results add nothing. `transcriptView(tr, width, n)` (V:334-367) slices the last `n` and shortens lines; `PEEK_DENIED` is V:68. `TranscriptItem`/`Transcript` are in `types/index.d.ts:104-113`; atoms are declared in `PluginState` (`types/index.d.ts:156-175`), and validate holds every atom key to it.
- Tests: RT mounts the pane with `$.ui.mount({ plugin: 'orchestrator', surface, component: 'Pane', requestId: 'orchestrator', props: { bodyColumns } })` (`mountPane`, RT:358-359; `mountViewed` with `props.view`, RT:1082-1083), looks up elements with `ui.find({ key | text })`, presses them with `ui.press`, seeds a world with `world(on)` and `running($, w)` (RT:362). Transcript reads are answered by the world's `session.messages` stub; check the existing peek tests (`grep -n "transcript\|DENIED" hooks/register.test.ts`, e.g. RT:1425) for how a message list is seeded. Pure helpers are tested in `hooks/view.test.ts` with plain data. Ops (`$.ui.view`, `$.ui.scroll`) raise events of the same name, so a test observes or answers them with `on('ui.view', ...)` / `on('ui.scroll', ...)` hooks that record the argument and return `{}` or `{ deny }`.

## Decisions

| # | Decision |
| --- | --- |
| D1 | **Cache.** No new atom for transcript data. `refreshTranscript` keeps the last `TIMELINE_ITEMS = 200` items (rename `TRANSCRIPT_MAX`; delete `TRANSCRIPT_TERMINAL`). The builder works on `TranscriptItem[]`. Numbering and the first turn are relative to the cached window. |
| D2 | **Turn.** A turn starts at a `role: 'user'` text item whose text, trimmed, is non-empty and is not wholly a `<system-reminder>…</system-reminder>` block. It holds the following items until the next such item. Items before the first start (window cut) form a leading turn with preview `earlier steps` and no start text. |
| D3 | **Outcome**, first match: distinct `brief` (the path) of `Edit`/`Write`/`MultiEdit` tool items, N≥1 → `✎ N files` (`✎ 1 file`); else `Bash` count N≥1 → `› N cmds` (`› 1 cmd`); else any tool items N≥1 → `N tools` (`1 tool`); else `reply`. |
| D4 | **Row** (`timelineRow`): right-aligned number, preview cut to fill, outcome, `• here` on the last turn, `hh:mm` dim at the right end (`--:--` when the turn's first item has no `t`; `hhmm` from V:45), then the jump control `↗`. Header `Timeline · <name> · N turns` (`1 turn`). |
| D5 | **Takeover.** In both surface branches of the `PANE` render, when `liveSelection(visible, selected)` is a subagent (not `main`), return the timeline tree instead of the header, chart and list. The `ui.render` for the pane stays one hook. The header's own `Hand over main` button and fold hotkey are not drawn in the timeline (the list returns with `← agents`). Opening a timeline is the existing row press (`toggleSelected`); `← agents` clears `selectedAtom`, `expandedAtom` and `jumpNoteAtom`. Main's row press is unchanged (bolds it, opens nothing). |
| D6 | **Jump** (a Button `key="jump:<agentId>:<turn.key>"`, label `↗`; inert dim `Text` when the turn has no tool call). On press, in one handler, so it counts as the person's input: if `e.props.view?.agentId !== agentId` and `typeof $.ui.view === 'function'`, `await $.ui.view({ agentId })`; on `{ deny }` set `jumpNoteAtom` to the deny text and stop. If `$.ui.view` is not a function, set the note `Open <name> from /tasks to jump there` and stop. Then `await $.ui.scroll({ to: { requestId: turn.jumpTo }, block: 'start' })`; on `{ deny }` set the note to the deny text. `props.view` is a render prop, so the handler reads it from the closure of the render. The note is drawn under the header as dim text plus a `dismiss` Button (`key="jump-note-dismiss"`), and clears on the next jump, on back, and on dismiss. |
| D7 | **Expand.** Pressing a turn's row toggles its `turn.key` in `expandedAtom` (`string[]`). An expanded turn draws its items beneath the row through the existing `item(agentId, it)` closure of that surface (tool call → `openTool`; cut text → `togglePinned` card), so those behaviours are unchanged. |
| D8 | **States.** `transcriptsAtom[agent]` absent → dim `loading…`; `{ denied }` → one dim line `PEEK_DENIED` (V:68); no turns → dim `no messages yet`. `timelineOf(tr)` returns `{ dim } \| { turns }`. |
| D9 | **Peek removed.** Delete `peek`, `peekRows`, the box under the row on both surfaces, `TRANSCRIPT_TERMINAL`, and the terminal `terminalBase` `peekRows` input only if nothing else uses it (keep `terminalBase`'s signature; pass `peekRows: 0`). Tests that assert the old box are rewritten against the timeline, not left skipped. The desktop "in view" mark and chart highlight stay. |
| D10 | **New atoms** declared in `types/index.d.ts` `PluginState`: `expandedTurns: string[]`, `jumpNote: string`. |
| D11 | **Types for tsc.** The repo's ignored types are 2.1.296, so `$.ui.view` fails `tsc -p .`. Task 2 starts by overwriting `.claude-plugin/types/claude-code/index.d.ts` with the 2.1.312 file (path under Sources). Untracked, never committed; the engine does the same on load. |

## Tasks

TDD is mandatory for both: write the failing test first, run it, watch it fail for the right reason, implement until it passes. Pass this rule on to any sub-agent. Gates after each task:

```
claude plugin test .
claude plugin validate .
npx -p typescript@5.6.3 tsc -p .
```

**Ordering: Task 2 runs after Task 1 is committed.** The interface below is fixed, so Task 2 could be written in parallel, but it imports `hooks/timeline.ts`; sequential is safer and Task 1 is small.

### Task 1: pure builder

**Scope (only):** `hooks/timeline.ts` (new), `hooks/timeline.test.ts` (new). Imports `TranscriptItem`/`Transcript` from `../types`, and `cut`, `hhmm`, `PEEK_DENIED` from `./view` (V:45-48, V:68). Edits no other file.

**Exact exports of `hooks/timeline.ts`:**

```ts
import type { Transcript, TranscriptItem } from '../types'

export type TimelineTurn = {
  /** Stable across rereads: the opening item's `key`, or 'earlier' for the leading orphan turn. */
  key: string
  /** 1-based, within the cached window. */
  number: number
  /** The opening user text on one line, uncut ('earlier steps' for the orphan turn). */
  preview: string
  /** '✎ 2 files' | '› 3 cmds' | '4 tools' | 'reply' (D3). */
  outcome: string
  /** The opening item's `t`, when known. */
  t?: number
  /** toolUseId of the turn's first tool item; absent when it has none (no jump possible). */
  jumpTo?: string
  /** True for the last turn. */
  isCurrent: boolean
  /** The opening text item (absent on the orphan turn) then every later item up to the next turn. */
  items: TranscriptItem[]
}

export const buildTimeline: (items: readonly TranscriptItem[]) => TimelineTurn[]

/** `{ dim }` for undefined (`loading…`), denied (PEEK_DENIED) and no turns (`no messages yet`); else the turns. */
export const timelineOf: (tr: Transcript | undefined) => { dim: string } | { turns: TimelineTurn[] }

/** `Timeline · <name> · N turns` (`1 turn`). */
export const timelineHeader: (name: string, turns: number) => string

export type TimelineRow = {
  num: string       // right-aligned to numW
  preview: string   // cut with `cut` so the whole row fits `width`
  outcome: string
  here: boolean     // draw '• here'
  time: string      // hhmm(t) or '--:--'
}
/** One row's cells. Fixed cells: num (numW) + outcome + 5 (time) + 2 (jump) + 7 (here) when `here`, joined by single spaces; the preview gets the rest, never under 8 columns. */
export const timelineRow: (turn: TimelineTurn, width: number, numW: number) => TimelineRow
```

**Failing tests to write first** (`hooks/timeline.test.ts`, plain data, no mounting):
1. `buildTimeline`: `[]` → `[]`; one user text then two assistant texts → one turn, outcome `reply`, `isCurrent`, `jumpTo` undefined.
2. Two user texts with tool items between → two turns, numbered 1 and 2, only the second `isCurrent`; each holds its own items; `key` is the opening item's key.
3. `jumpTo` is the first tool item's `toolUseId` (a text-first assistant step does not matter); a turn with no tool has none.
4. Outcome: Edit + Write + Edit of the same `brief` + Bash → `✎ 2 files`; `Edit` of one path → `✎ 1 file`; three Bash → `› 3 cmds`; one Bash → `› 1 cmd`; Read + Grep → `2 tools`; one Read → `1 tool`; MultiEdit counts as a file.
5. A user item whose text is only a `<system-reminder>…</system-reminder>` block does not start a turn (its text is not in any turn's `preview`).
6. Items starting with assistant steps → leading turn, `key: 'earlier'`, `preview: 'earlier steps'`, number 1; the next user text is turn 2.
7. `preview` collapses internal whitespace/newlines to single spaces.
8. `timelineOf`: `undefined` → `{ dim: 'loading…' }`; `{ denied: true }` → `{ dim: PEEK_DENIED }`; `{ items: [] }` and an items list of tools only with no user text but steps → the orphan turn (not `no messages yet`); only truly empty → `{ dim: 'no messages yet' }`.
9. `timelineHeader('impl-1', 3)` → `Timeline · impl-1 · 3 turns`; with 1 → `1 turn`; with 0 → `0 turns`.
10. `timelineRow`: numbers right-aligned to `numW`; `time` is `--:--` without `t` and `hhmm(t)` with it; `here` mirrors `isCurrent`; a long preview is cut with `…` so `num + preview + outcome + 5 + 2 (+7 if here)` plus separators is ≤ `width`; a tiny width keeps an 8-column preview floor.

### Task 2: wiring for both surfaces, tests, docs

**Scope (only):** `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts` (the two atoms, D10), `README.md`, `skills/orchestrated-run/SKILL.md`. First step: refresh the ignored types (D11). Do **not** touch `hooks/timeline.ts`, `hooks/view.ts` or `.claude-plugin/plugin.json` (the orchestrator bumps the version).

**Failing tests to write first** (RT, loop `['terminal', 'desktop'] as const`, using `mountPane`/`running`, `world`, a seeded `session.messages` transcript with two user turns, the second containing a Bash tool use with a known `tool_use_id`):
1. Pressing `agent:<id>` (desktop) / the row (terminal) takes over the pane: the header reads `Timeline · impl-1 · 2 turns`, no agent row key remains (`find({ key: 'agent:agent1' })` undefined), and on desktop no chart (`find({ key: 'chart' })` undefined).
2. Rows: each turn shows its number, preview, outcome and `hh:mm`; the last shows `• here`; the first does not.
3. `← agents` (`key="timeline-back"`, `hotkey="b"`) returns to the list: the agent row key exists again, and a second open shows the timeline fresh (expanded set cleared).
4. Pressing a turn row expands it: its items (a tool line with `key="tool:agent1:<id>"`, a cut-text card) appear; pressing again collapses it. Pressing the tool line opens the detail (`TOOL_PANE` open, as today's tool tests assert).
5. Jump, row's agent already in view (`props.view = { agentId: 'agent1' }`): pressing `jump:agent1:<key>` raises `ui.scroll` once with `{ to: { requestId: '<tool_use_id>' }, block: 'start' }`, and `ui.view` is not raised.
6. Jump, main in view: `ui.view` is raised with `{ agentId: 'agent1' }` first, then `ui.scroll`; order asserted.
7. `ui.scroll` answers `{ deny: 'not person-initiated' }` → the note shows that text with a `jump-note-dismiss` button; pressing dismiss removes it. Same for a `ui.view` deny (and then no scroll).
8. `$.ui.view` absent (delete or shadow it on the engine in the test) → the note `Open impl-1 from /tasks to jump there`, no scroll.
9. A turn with no tool call: no `jump:` Button for it (a dim `↗` Text only).
10. Denied transcript (world answers `session.messages` with `{ deny }`) → the single dim `PEEK_DENIED` line (`DENIED` in RT), no turns.
11. Rewrite or delete the existing peek tests (the "last six/twelve entries" box assertions, e.g. around RT:1425 and the peek describe blocks) to match: cut-text expansion and `pinned` behaviour are now asserted inside an expanded turn.
12. A long list (30 turns) renders every row in one column; no row-count cap is applied by the mod (the pane scrolls it).

**Implementation notes:**
- New module-level atoms `expandedAtom` (`expandedTurns`) and `jumpNoteAtom` (`jumpNote`), defined beside R:104-115 in the same style, declared in `types/index.d.ts`.
- One top-level function `timelineBody($, ui, e, { row, tr, expanded, note, cols, item })` returns the shared tree; each surface branch calls it with its own `item` closure, then returns early (D5). `$` is only passed to top-level functions (README:147 explains why). Press handlers are top-level `toggleTurn($, key)`, `jumpTo($, view, row, turn)` and `leaveTimeline($)`.
- `refreshTranscript` (R:468-484): replace `TRANSCRIPT_MAX` with `TIMELINE_ITEMS = 200`. `transcriptItems` already yields what the builder needs.
- Docs: README lines 50, 58 and 67 and the terminal/desktop bullet lists (README:42-60, 67-71) now describe the Timeline instead of the box beneath a row: clicking a subagent opens its Timeline over the pane; turn rows, outcome cells, `• here`, expand in place, `↗` jump (it switches the main view to the agent on engine 2.1.312 and later, then scrolls to the turn's first tool call; on older engines it says to open the agent from `/tasks`), `← agents` and the `b` hotkey with the pane focused; Esc closes the pane (host behaviour) and `/orch` reopens it. Remove the sentence "The host gives mods no way to switch the main view to an agent". Keep the times paragraph. `skills/orchestrated-run/SKILL.md:74`: replace "clicking a subagent shows its timestamped transcript there" with the Timeline wording in one clause.

## Final steps (orchestrator, not a task)

Bump `.claude-plugin/plugin.json` `"version"` (line 3) from 0.3.11 to 0.3.12 in the same PR, run the three gates, then commit.
