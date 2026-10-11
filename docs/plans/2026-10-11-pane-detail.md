# Pane detail: timestamped transcript, tool-call popups, model and effort, status colours

Date: 2026-10-11 · Branch: `pane-detail` · Mod version now: 0.3.0 → **0.3.4** (amended: items 5 and 6 added) · Engines: terminal 2.1.296, desktop app's bundled 2.1.295

## Goal

1. **Transcript.** Each transcript entry gets a timestamp on its left. A long entry is cut with `…` and opens to its full text the way the activity log does: hover card or click-to-pin on the terminal, click-to-expand inline on the desktop.
2. **Tool calls.** Clicking a tool call in the transcript opens a detailed, well-rendered view: Bash command and output, Edit as a diff, Read path and excerpt, Grep/Glob pattern and results, and a fallback for every other tool.
3. **Model and effort.** Each agent row shows the model and effort, for example `Sonnet 5.5 med`.
4. **Status.** Status colours on the terminal and status emoji on the desktop.

## Baseline (run 2026-10-11 on `a5c0f20`)

| gate | result |
| --- | --- |
| `claude plugin test .` | 155 pass, 0 fail, 3 files |
| `claude plugin validate .` | ✔ Validation passed |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0 |

## Facts (sources)

**T** is `.claude-plugin/types/claude-code/index.d.ts`, written by 2.1.296 (21,293 lines; the same file as the plugin-authoring skill's `types/claude-code.d.ts`). **B295** is the desktop's bundled binary, `~/Library/Application Support/Claude/claude-code/2.1.295/*/claude.app/Contents/MacOS/claude`; it ships no `.d.ts`, so it was checked by grepping its strings. **R** is `hooks/register.tsx`.

### Transcript data

- **F1. Messages carry no timestamps.** `SessionMessage` is `{ role, text, toolUses, toolResults?, handle? }` (T:11142-11166). `ApiMessage` is `{ role, content }` (T:646-660). Nothing in T stamps a message with a time. **Consequence:** the mod stamps times itself (D4).
- **F2. A tool call and its result are already paired.** `ToolUseSummary` is `{ tool_use_id, tool, input, result?, text?, isError?, agentId?, durationMs? }`, "with its outcome once the transcript holds the call's tool_result (paired by `tool_use_id`)" (T:13151-13215). `text` is "the result as the model read it; absent while the call is in flight".
  - `result` (the structured record) is absent in a subagent's transcript: "a subagent's transcript stores none; `text` holds either way" (T:13180-13186; also `ToolResultSummary`, T:13086-13115).
  - **Consequence:** the detail view is built from `input` plus `text`. No separate stdout, stderr or exit code is available for subagents.
- **F3. `$.session.messages({ agentId })` returns the newest 4096 entries or `{ deny }`** (T:2747-2778, T:11171-11285). The read path stays as built in 0.3.0 (agent-focus plan, "Async read"): off the render, one in flight per agent, a 3 s timeout.
- **F4. Where times can be observed:**
  - `tool.call` carries `e.tool_use_id` and `e.agentId` (`ToolUseSummary.tool_use_id`: "as `tool.call` carried it (`e.tool_use_id` there)", T:13157-13160; the test kit passes it, `register.test.ts` `tool()` helper; R:554).
  - `turn.step` carries `e.agentId`, and its result carries `answer` (the step's visible text) and `toolUses` as `{ name, input }`, **without ids** (T:13498-13540, T:13641-13650).
  - `$.clock.now()` gives the time.
- **F5. Tool inputs** (T:16178-16186 Bash `{ command, timeout?, description?, run_in_background? }`; T:16266-16274 Edit `{ file_path, old_string, new_string, replace_all? }`; T:16517-16523 Read `{ file_path, offset?, limit?, pages? }`; T:16792-16795 Write `{ file_path, content }`; T:15996+ Agent).
  - Grep and Glob are not in this build's table: the table is laid per session. Read their fields defensively (`pattern`, `path`, `glob`, `type`, `output_mode`).
  - Edit gives **no line numbers**.

### Popups and dialogs

- **F6. A dialog is a second pane.** `$.ui.open({ id, title, focus, closeOnEscape, holdToasts, rows, columns })` (T:2484-2505, `PaneOpenArgs` T:7398-7465).
  - `closeOnEscape`: Escape closes the pane as the person's own close does, raising `ui.close` with origin `person` (T:7425-7436).
  - `holdToasts`: holds toasts back while the pane shows; meant "for a dialog the person answers and leaves" (T:7437-7447).
  - An open that answers a press is placed at any width (T:7389-7396).
  - It resolves `{ isPlaced: false, reason }` in "a session whose attached surfaces place no panes … (an older desktop)" (`UiOpenResult` T:14142-14166).
  - Panes are "one per id …, one shown, the rest tabs" (T:10312). So the Orchestrator pane becomes a tab while the dialog shows, and is shown again when the dialog closes.
  - `ui.close` gives `e.id` and `e.origin`. A hook must call `next` or the pane stays open (`PaneCloseInput` T:7361-7371).
  - B295 contains `closeOnEscape` and `holdToasts`.
- **F7. No separate hover-card or popover element exists.**
  - **Terminal hover:** a keyed Box holding an absolute Box drawn `display:"none"` with `hover:{display:"flex"}` (T:868-990). That is the activity card at R:895-919: `wrapFill` padding, and a click pins it through `pinnedLog`.
  - **Desktop:** a plain `Button` that toggles `pinnedLog`, with the full text in an in-flow bordered Box keyed `full:<logId>` (R:782-796).
  - A Button's children may only be strings and `Text` (T:1076-1086).

### Elements

- **F8. `Code` and `Markdown` are drawn on every surface.** The tables are at T:3800-3875: terminal T:3810-3830, desktop T:3831+. B295 contains `startLine`, `truncate-end` and `onLinkPress`.
  - **`CodeProps`** (T:1625-1677): `{ source, language?, path?, startLine?, format?: 'source'|'diff', wrap?: 'wrap'|'truncate-end' }`.
    - It is a leaf. The engine highlights it.
    - `format:'diff'` reads unified hunks (`@@ -a,b +c,d @@`); a source that parses as no hunks is drawn as plain code.
    - The limit is 100,000 characters per drawing. Tab and newline are the only control characters allowed.
  - **`MarkdownProps`** (T:5700-5740): `{ key?, text, dimColor?, onLinkPress?, … }`. Same character limit.

### Model and effort

- **F9. `turn.step`'s input has `model`** ("as the engine resolved it for this step") **and `effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number`** (absent for a model without effort) (`TurnStepInput` T:13438-13470, model T:13452, effort T:13457). The answering model id is `res.usage.model` (`TurnUsage` T:13664-13668).
- **F10. Other sources are weaker:**
  - `AgentSpawnInput.model` is an alias or id, or undefined, which means the agent's own default or the parent's. It has no effort field (T:264-310, model T:296-303).
  - `AgentInfo` (`$.agent.list`) has **no model or effort** (T:125-175).
  - The Agent tool input has `model` and `effort` (T:16004-16006). Agent definitions have `model` and `effort` (T:474-479).
  - No API maps a model id to a display name.
  - **Consequence:** record `e.effort` and `res.usage?.model ?? e.model` per step. Before the first step, show `brief.model`'s alias if any. The mod maps ids to names itself.

### Colours

- **F11. Colours.** `Color = ThemeKey | string` (T:1689). `ThemeKey` includes `success`, `warning`, `error`, `suggestion`, `inactive`, `subtle`, `claude`, … (T:12598). `TextProps` has `color`, `backgroundColor`, `dimColor`, `bold`, `inverse`, … (T:12571-12590). A raw colour does not follow the person's theme, and "what a surface draws for one it does not know is its own" (T:1683-1688). No theme key means "bright green".

### Repo facts

- **F12. Repo facts** (desktop-target plan, Fact 13; agent-focus plan):
  - `$` may only be passed to top-level functions in `register.tsx`.
  - State writes are not allowed while drawing.
  - `hhmm` (V:42) draws **UTC**, as the activity log does.

### Wake-ups for a subagent orchestrator (amendment, item 5)

- **F13. `CronCreate` enqueues a prompt into the session's REPL, not into an agent.** Its tool description says: "Schedule a prompt to be enqueued … Jobs only fire while the REPL is idle (not mid-query)". The schema is at T:16196-16209.
  - A subagent can call it: it is in this planner subagent's own tool list.
  - When it fires, the prompt lands in the **main** conversation. It neither reaches nor wakes a subagent, and nothing routes it to one.
  - Its granularity is one minute.
  - **Verdict:** it works for a main-session orchestrator only.
- **F14. `ScheduleWakeup` is not usable.** Its input is `/loop` input (T:16579-16590), it is clamped to 60-3600 s, and it re-enters the `/loop` skill. It is not in a subagent's tool list (absent from this subagent's tools). **Not usable.**
- **F15. Other candidates fail too.**
  - `RemoteTrigger` drives claude.ai cloud routines, which run a separate cloud session (tool description). That is the wrong process and may cost money. **Not usable.**
  - `Monitor` (T:16377-16389) streams a shell command's lines to the agent that started it, while it is live, capped at 30 min. It is not a wake-up for an agent that has ended its turn.
- **F16. What does wake a subagent: `$.session.send({ to: { agentId } })`.**
  - The address type says it "resumes a finished subagent from its transcript with the message, as the tool does", and a live teammate "goes idle between turns and wakes on a message" (`SessionSendAddress` T:11528-11538; T:339).
  - The mod already relies on this for HANDOVER (R:244-259).
  - Mod timers come from `$.clock.after` and `$.clock.every`, with the 30 s `sync` at R:351. Module timers die on reload; deadlines kept in `$.state` survive it.
  - **The only mechanism that wakes a subagent orchestrator is mod-side: a deadline plus `$.session.send` to the parent's agent id.**
- **F17. Engine agent statuses** include `waiting`: "on background work it owns, … in a background subagent, on an Agent call alone" (`AgentStatus` T:537-545). The mod's own `AgentStatus` (types/index.d.ts:13) has no `waiting`. The parent link is `AgentRow.parentId`: `'main'`, an agent id, or undefined for main itself.
- **F18. Reports are not delivered automatically.** The caller reports that in this build a background subagent's final text is not delivered to its parent, and the spawn result says "ended without delivering a report through SubagentHandback". Only `SendMessage` reached the orchestrator.

## Decisions

| # | Decision |
| --- | --- |
| D1 | **Transcript items replace one-line-per-message.** Each message yields a `text` item (when it has text) followed by one `tool` item per tool use. The pane shows the last *n* items: **6 on the terminal, 12 on the desktop**. The `⚙ Bash×2` summary is dropped. Tool-result-only user rows yield no item; their outcome is on the tool item (F2). |
| D2 | **Item layout:** `hh:mm ` (dim), then the content. Assistant text is plain. User text is prefixed `» ` (dim). A tool item reads `⚙ <Tool> <brief>`. A failed call gets a red `✗ ` before `⚙` (`color="error"`). A call in flight gets ` (running)` (dim). **Briefs:** Bash `command`; Read, Edit and Write `file_path`; Grep and Glob `pattern` plus ` in <path>`; Agent `description`; otherwise the first string field of the input. Whitespace is collapsed and the brief is capped at 300 characters. |
| D3 | **Long text items** (longer than the room) are cut with `cut`.<br>**Terminal:** the activity pattern exactly. A keyed Box holds a `plain` Button (key `step-<agentId>-<itemKey>`) that toggles `pinnedLog`, plus the absolute `wrapFill` card revealed on hover or pin.<br>**Desktop:** a `plain` Button toggling `pinnedLog`, with the full text in flow in a `Box key="full:<same id>" borderStyle="round"`.<br>`pinnedLog` is reused (only its doc comment changes): one card is pinned at a time, and the `log-` and `step-` prefixes cannot collide. |
| D4 | **Timestamps.**<br>**Stamp map:** a module-level `stamps: Map<agentId, Map<key, ms>>`, capped at 500 keys per agent with the oldest dropped. The map is lost on reload; the fallback below covers that.<br>**Writes:**<br>• `tool.call` (subagent): `stamps[agent][tool_use_id] = now`, stamped **before** `next(e)`.<br>• `turn.step` (subagent, after the step is recorded): when `res.answer` is non-empty, `stamps[agent][textKey('assistant', answer)] = now`.<br>Both writes are synchronous and wrapped in `try`, so they can never affect the handover path.<br>**Resolution in `transcriptItems`:**<br>1. A tool item takes its `tool_use_id`'s stamp.<br>2. A text item takes its text key's stamp, else the stamp of its message's first tool use.<br>3. Message 0, the brief, takes the row's `startedAt`.<br>4. Otherwise the item stays unstamped and draws `--:--`.<br>The mod never invents a time. |
| D5 | **`textKey(role, text)`** is `txt:` plus the djb2 hash (base 36) of `role + ':' + normalised text`. Normalised means `clean` (from V:48), whitespace collapsed, trimmed, **before** any cap. The same function is used when stamping and when resolving. An item's own key adds `#<occurrence>`; the stamp lookup uses the key without that suffix. |
| D6 | **New state key `transcripts: Record<string, Transcript>`** replaces `peeks`; `Peek`, `peekLines` and `peekView` are removed.<br>`Transcript = { items: TranscriptItem[] } \| { denied: true }`, holding at most 12 items. A text item's text is capped at `STEP_CHARS = 2000`, so the full text survives for expansion.<br>Using a new key means a value in the old shape left in `$.state` after a hot reload is never misread.<br>The read path stays the same: `refreshPeek` becomes `refreshTranscript`, with the same in-flight set, the same reread and the same timeout. |
| D7 | **Tool detail is a dialog pane:** `TOOL_PANE = 'orchestrator-tool'`, opened on a press as `$.ui.open({ id: TOOL_PANE, title: \`${label} · ${tool}\`, focus: true, closeOnEscape: true, holdToasts: true, rows: 20 })`. It is the same on both surfaces.<br>The open is fire-and-forget (`void …then`), so the press never waits.<br>**Fallback:** when the open resolves `isPlaced: false` (an older desktop, F6), `toolView.inline = true` is set and the main pane draws the detail in flow beneath the tool item (`Box key="tooldetail:<toolUseId>" borderStyle="round"`).<br>Pressing the open tool again closes it: `$.ui.close` and state cleared. A `ui.close` hook clears the state when `e.id === TOOL_PANE` and always calls `next(e)`. |
| D8 | **New state key `toolView: ToolView \| null`**, where `ToolView = { agentId, toolUseId, inline: boolean, detail?: ToolDetail, denied?: true }`.<br>The detail is read off the render by `refreshTool($, agentId, toolUseId)`. It uses the same pattern as the transcript (timeout `PEEK_TIMEOUT_MS`, a module-level in-flight set) and writes only when `toolView.toolUseId` still matches.<br>It is reread when the open call's `tool.call` settles: a `toolIfOpen` call, placed last in the `tool.call` hook after `peekIfSelected`, that never throws.<br>A use missing from the transcript is stored as `denied`. |
| D9 | **Pure `toolDetail(use, t?)`** (new `hooks/detail.ts`) gives `ToolDetail = { tool, time: string, isError, isPending, sections: DetailSection[] }`, where `DetailSection = { kind: 'code', label, source, language?, path?, startLine?, diff?: true } \| { kind: 'markdown', label, text } \| { kind: 'text', label, text }`. Per tool:<br>• **Bash:** a `description` text section (when present); a `Command` code section with `language: 'bash'`; an `Output` code section (plain, no language).<br>• **Edit:** a `File` text section (path, plus ` (all occurrences)` with `replace_all`); a `Change` code section with `diff: true` from `editDiff(old, new)`; a `Result` text section.<br>• **MultiEdit** (when `input.edits` is an array): one diff per edit, joined.<br>• **Write:** `File`, then `Content` code with `path` and `startLine: 1`.<br>• **Read:** `File` (path, plus ` lines a–b` from offset and limit); `Excerpt` code with `path` and `startLine`, from `readExcerpt(text)`, which strips the `N→` or `N\t` gutters and takes the first N.<br>• **Grep / Glob:** a `Pattern` text section (pattern, path, glob, type, output mode); `Results` plain code.<br>• **Agent:** `Task` text (description and subagent type); `Prompt` markdown; `Result` markdown.<br>• **Any other tool:** `Input` code (`language: 'json'`, `JSON.stringify(input, null, 2)`); `Result` plain code.<br>**Every section:** control characters other than `\n` and `\t` are stripped (ANSI included); each section is capped at `SECTION_CHARS = 20_000` with `\n… (N more characters)`; the total is capped at 60,000. A diff over its cap falls back to `Old` and `New` code sections, so a hunk is never cut. A call in flight has no `Output` or `Result` section, and `isPending` is set. |
| D10 | **`editDiff(old, new)`**: one hunk. Common leading and trailing lines become context (` `); the rest is `-` and `+`. The header is `@@ -1,a +1,b @@`. Edit gives no line numbers (F5), so the section label reads `Change (line numbers relative to the edit)`. |
| D11 | **The detail pane tree** (all surfaces), from top to bottom:<br>1. Header: `Text bold` reading `<time> ⚙ <Tool>`, with ` failed` (`color="error"`) or ` running…` (dim).<br>2. Each section: a `Text dimColor bold` label, then `Code` (`source`, `language`, `path`, `startLine`, `format: diff ? 'diff' : 'source'`), `Markdown` (`text`) or `Text wrap="wrap"`.<br>3. Last, `Button key="close" role="dismiss" label="Close"`, which runs `$.ui.close({ id: TOOL_PANE })` and clears `toolView`.<br>Before the detail arrives the pane shows `loading…`. When the detail is denied it shows `tool call not readable (teammate in another pane, or finished)`. With `toolView` null it shows `No tool call selected.` |
| D12 | **Model and effort per row.** `AgentRow` gains `model?: string` and `effort?: string`.<br>`turn.step` (main and subagents, inside the existing `try`) patches `model: res.usage?.model ?? e.model` and `effort: e.effort === undefined ? undefined : String(e.effort)`.<br>Before any step, the row shows `brief.model` if the spawn named one.<br>**Pure helpers:** `modelName(id)` and `effortAbbrev(effort)` combine as `modelLabel(model?, effort?)`, which gives `''` when the model is unknown and the model alone when the effort is unknown. |
| D13 | **`modelName` mapping.**<br>1. Strip the `[...]` suffix, provider prefixes (`…anthropic.`), `@…`, `-v\d+(:\d+)?` and an 8-digit date.<br>2. `claude-(opus\|sonnet\|haiku\|fable)-(\d+)(-(\d{1,2}))?` gives `Family M.m` (`claude-sonnet-5-5` → `Sonnet 5.5`; `claude-opus-4-20250514` → `Opus 4`).<br>3. The legacy form `claude-(\d+)(-(\d))?-(family)` gives `Sonnet 3.5`.<br>4. A bare alias gives the family capitalised (`sonnet` → `Sonnet`). `inherit` gives `''`.<br>5. Anything else stays as written, cut to 16 characters.<br>**`effortAbbrev`:** `low`→`low`, `medium`→`med`, `high`→`high`, `xhigh`→`xhigh`, `max`→`max`. A numeric string → `fmtTokens(n)`. Anything else stays as written. |
| D14 | **Where the model shows.**<br>**Desktop:** inside the row Button after the label, as `<Text dimColor>{modelLabel} </Text>` (omitted when it is `''`).<br>**Terminal:** a new fixed cell of `MODEL = 17` columns (16 padded, plus a space) after the tokens. The timeline width becomes `max(8, cols - NAME - 7 - 14 - MODEL)`, and the time-axis row is indented by `NAME + 7 + MODEL`. |
| D15 | **Terminal status colours** come from pure `statusStyle(status)`. They apply to the row's **glyph and status word**; the name keeps today's dim-when-settled.<br>• `running`: `color 'success', bold` (bright green)<br>• `idle`: `color 'warning', dimColor` (faint orange)<br>• `done`: `color 'success', dimColor` (faint green)<br>• `stalled`: `color 'error', bold` (red)<br>• `handing-over`: `color 'suggestion', bold` (accent blue)<br>• `replaced`: `color 'inactive', dimColor`<br>Theme keys are used, not raw colours, so the colours follow the theme (F11). |
| D16 | **Desktop status emoji** come from pure `statusEmoji(status, id)`. The emoji is placed before the dim status word in the row Button.<br>• `running`: `runnerFor(id)`, which is `🏃‍♂️` when `djb2(id)` is even and `🏃‍♀️` when it is odd. The choice is stable per agent and the same on every redraw and reload.<br>• `idle` 😴, `done` ✅, `stalled` 🛑, `handing-over` 📝 (writing its note), `replaced` ♻️.<br>The terminal keeps its single-width glyphs, because emoji widths break cell layout. |
| D17 | **Pure code goes to `view.ts` and the new `detail.ts`. Wiring goes to `register.tsx`**, in three sequential tasks. `core.ts` is untouched. |
| D18 | **`waiting` is a display status only.** Pure `displayStatus(row, rows)` returns `'waiting'` when `row.status === 'idle'` and some row with `parentId === row.id` has status `running`, `idle` or `handing-over`, applied recursively. A child that itself displays `waiting` is idle, so it already counts. Otherwise it returns `row.status`.<br>The type is `DisplayStatus = AgentStatus \| 'waiting'`, and it is **never stored**. Every handover, stall, sync and `canHandOver` check keeps reading `row.status`, so a waiting orchestrator is still `idle` for HANDOVER-as-message.<br>**Terminal:** glyph `◐`, `color 'planMode'` (teal, distinct from idle's faint orange and handing-over's blue), not dim.<br>**Desktop:** ⏳.<br>`statusStyle` and `statusEmoji` take `DisplayStatus`. The status word shows `waiting`. |
| D19 | **Skill brief (item 5).** Orchestrators keep using background agents. Each spawn prompt must end with a persuasive, explicit report-back clause: *"Your final message is NOT delivered to me. Before you end, you MUST call SendMessage to `<orchestrator name>` with your full report; if you skip this, I never learn you finished and the run stalls."* The orchestrator names itself, so it must be spawned with a `name`.<br>For each spawn, the orchestrator estimates the task's duration and adds a buffer (max(10 min, 50%)), then arms a **single-shot check-in**. When the check-in fires and no report has arrived, the orchestrator checks the agent (`/orch roster`, the pane, or a SendMessage nudge). When the report arrives first, the check-in is ignored.<br>**Mechanism per F13 to F16:**<br>• A **main-session** orchestrator uses `CronCreate` with `recurring: false` and a pinned minute, and `CronDelete`s it on the report.<br>• A **subagent** orchestrator has no tool that wakes it. It relies on the mod check-in (D20) when Task 7 is approved. Until then the skill tells it so plainly: set no cron, and keep the report-back clause; the main session's cron is the backstop. |
| D20 | **Mod check-in (optional Task 7; needs the user's design call).**<br>The mod registers a tool `mcp__orchestrator__checkin` `{ agent: name\|id, minutes: number }` in `session.start`, served by a `tool.call` hook. It records `checkinAt = now + minutes` on the child's row, and the parent is the calling loop's `e.agentId ?? 'main'`. Calling it again re-arms; `minutes: 0` cancels.<br>**Disarming:** the check-in is disarmed when the mod sees the child's `SendMessage` whose `to` names the parent (a `tool.call` on `SendMessage` from the child's loop), or when the parent's own report arrives some other way.<br>**Firing:** the existing 30 s `sync` fires a due check-in once.<br>• For a **subagent parent:** `$.session.send({ to: { agentId: parent }, text: '[orchestrator mod] check-in: <label> (id) has not reported after N min; status <displayStatus>, last active <hh:mm>.' })`. This wakes or resumes the parent (F16).<br>• For **main:** a toast plus `$.session.append` (the `tellParent` path).<br>The deadline lives in state (`AgentRow.checkinAt?`, `checkinBy?`), so it survives a reload.<br>**Alternative for the user to weigh:** the mod could forward a child's final answer to its parent automatically, as `onAgentEnd` already does for replacements. That removes the need for the report-back clause but duplicates any report the child did send. |

## File scopes and ordering

| Task | Files | Runs |
| --- | --- | --- |
| 1 | `hooks/view.ts`, `hooks/view.test.ts`, `types/index.d.ts` (types only, no state keys) | **parallel** with 2 and 6 |
| 2 | `hooks/detail.ts` (new), `hooks/detail.test.ts` (new) | **parallel** with 1 and 6 |
| 1b | `hooks/view.ts`, `hooks/view.test.ts` | after 1's polish, before 3 |
| 3 | `hooks/register.tsx`, `hooks/register.test.ts` | after 1b |
| 4 | `hooks/register.tsx`, `hooks/register.test.ts`, `hooks/view.ts`, `hooks/view.test.ts` (legacy removal only), `types/index.d.ts` | after 3 |
| 5 | `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts` | after 4 and 2 |
| 6 | `README.md`, `skills/orchestrated-run/SKILL.md` (D19 brief and the D18 status included), then `.claude-plugin/plugin.json` version **0.3.4** | docs in parallel at any time; the version bump is last, after 5 (and 7, if approved) is green |
| 7 (optional, escalated) | `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts`, plus a D19 wording tweak in SKILL.md and README | after 5, and only on the user's go-ahead (D20) |

**TDD is mandatory for Tasks 1, 1b, 2, 3, 4, 5 and 7.** For every behaviour: write the failing test first, run `claude plugin test .` and watch it fail for the expected reason, then implement until it passes. Pass this rule on to any sub-agent. Task 6 is content and exempt.

**Gates after every task:** `claude plugin test .` (count = previous + new, 0 fail), `claude plugin validate .`, and `npx -p typescript@5.6.3 tsc -p .`.

**Invariants every task keeps:**
- the render never awaits `$.session.messages`;
- the Hand over buttons and Hand over main stay;
- the main button shows only in ask mode (`mainButtonShown`);
- the in-view mark stays;
- the chart's size bounds stay;
- `$` goes only to top-level functions in `register.tsx`;
- no state is written while drawing;
- every `$.state` key is declared in `PluginState`.

### Task 1: pure view helpers (view.ts)

**Types** (`types/index.d.ts`): add `model?: string` and `effort?: string` to `AgentRow`, and:

```ts
export type TranscriptItem =
  | { kind: 'text'; key: string; t?: number; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; key: string; t?: number; toolUseId: string; tool: string; brief: string; isError?: true; isPending?: true }
export type Transcript = { items: TranscriptItem[] } | { denied: true }
```

**Exports to add to `view.ts`:**
- `modelName`, `effortAbbrev` and `modelLabel` (D12, D13);
- `statusStyle(status): { color: string; dimColor?: true; bold?: true }` (D15);
- `statusEmoji(status, id)` and `runnerFor(id)` (D16);
- `hashText(s)` (djb2, base 36);
- `textKey(role, text)` (D5);
- `toolBrief(tool, input)` (D2);
- `transcriptItems(messages, stampOf: (key) => number | undefined, o: { n, chars, startedAt }): TranscriptItem[]` (D1, D4, D6);
- `transcriptView(tr: Transcript | undefined, width, n)`. It returns `{ dim }` (`loading…`, `PEEK_DENIED`, `no messages yet`) or `{ items: { id, time, short, full?, kind, toolUseId?, isError?, isPending?, role? }[] }`. `time` is `hhmm(t)` or `--:--`. `short` is cut to `width - 6`. `full` is present only when the item was cut. `id` is `step-<key>`; the caller prefixes the agent id.

Leave `peekLines`, `peekView` and `Peek` in place; Task 4 removes them.

**Failing tests first** (`view.test.ts`):
1. `modelName`:
   - `claude-sonnet-5-5` → `Sonnet 5.5`;
   - `claude-opus-5-5[1m]` → `Opus 5.5`;
   - `claude-haiku-4-5-20251001` → `Haiku 4.5`;
   - `claude-opus-4-20250514` → `Opus 4`;
   - `us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `Sonnet 4.5`;
   - `claude-3-5-sonnet-20241022` → `Sonnet 3.5`;
   - `sonnet` → `Sonnet`;
   - `inherit` → `''`;
   - `gpt-x` → `gpt-x`.
2. `effortAbbrev`: `medium` → `med`; `xhigh` → `xhigh`; `'32000'` → `32k`. `modelLabel('claude-sonnet-5-5', 'medium')` → `Sonnet 5.5 med`; with no effort → `Sonnet 5.5`; with no model → `''`.
3. `statusStyle`: each of the six statuses matches D15 exactly.
4. `runnerFor`: the same id always gives the same emoji; across `agent1` … `agent20` both runners occur. `statusEmoji('idle','x')` → `😴`; `done` → `✅`; `stalled` → `🛑`; `running` → `runnerFor(id)`.
5. `textKey`: it ignores whitespace differences and ANSI, and differs by role.
6. `toolBrief`: Bash gives its command, with newlines collapsed. Read gives its path. Grep gives `pattern in path`. An unknown tool gives its first string field. The brief is capped at 300.
7. `transcriptItems`:
   - one text item plus one tool item per use, in order;
   - a tool-result-only user row adds nothing;
   - only the last `n` items are kept;
   - text is capped at `chars`;
   - `isError` and `isPending` (no `text`) are carried.
8. `transcriptItems` stamps:
   - a tool item takes its `tool_use_id` stamp;
   - a text item takes its `textKey` stamp, else its first tool use's stamp;
   - message 0 takes `startedAt`;
   - any other item has no `t`;
   - a repeated identical text gets distinct keys (`#0`, `#1`).
9. `transcriptView`:
   - `undefined` → `loading…`; denied → `PEEK_DENIED`; empty → `no messages yet`;
   - an unstamped item's time is `--:--`;
   - a long item is cut with `…`, its `full` holds the whole text, and a short item has no `full`;
   - `n` keeps the last items.

**Acceptance:** pure, with no `$` and only type imports from `claude-code`. All gates are green.

### Task 2: tool detail builder (detail.ts, new)

**Exports:**
- the types `DetailSection` and `ToolDetail` (D9);
- `toolDetail(use: ToolUseSummary, t?: number): ToolDetail`;
- `editDiff(old, new): string`;
- `readExcerpt(text): { source: string; startLine?: number }`;
- `cleanBlock(s)` (strips everything but `\n` and `\t`, ANSI included);
- the constants `SECTION_CHARS` and `TOTAL_CHARS`.

**Failing tests first** (`detail.test.ts`):
1. Bash: the sections are `Command` (`language: 'bash'`, the command) and `Output` (the result text, ANSI stripped). `description` adds a text section. With no `text`: `isPending`, and no `Output`.
2. Edit: the `Change` section has `diff: true`. Its source starts `@@ -1,` and holds `-old line` and `+new line`, with the shared lines prefixed by a space. `replace_all` shows in `File`.
3. `editDiff`: identical leading and trailing lines become context; the counts in the header match the hunk body.
4. A diff over `SECTION_CHARS` falls back to `Old` and `New` code sections; no section has `diff: true`.
5. Read: `readExcerpt('    12→a\n    13→b')` gives `{ source: 'a\nb', startLine: 12 }`; the tab form works the same. `toolDetail` gives an `Excerpt` section with `path` and `startLine`.
6. Grep and Glob: `Pattern` text holds the pattern and path; `Results` is plain code.
7. Write: `Content` code with `path` and `startLine: 1`.
8. Agent: a `Prompt` markdown section and a `Result` markdown section.
9. An unknown tool gives `Input` with `language: 'json'` and pretty JSON, plus `Result`.
10. An error result sets `isError: true`; `time` is `hhmm(t)`, or `--:--` without `t`.
11. Caps: a 50,000-character output gives a section of at most `SECTION_CHARS + 40` characters ending in `more characters)`. The sum of all sources is at most `TOTAL_CHARS`. No control characters other than `\n` and `\t` survive.

**Acceptance:** pure; imports `hhmm` from `./view` and types only. All gates are green.

### Task 1b: waiting display status (view.ts; after Task 1's polish, before Task 3)

**Scope:** `hooks/view.ts`, `hooks/view.test.ts`.

**Exports:**
- `type DisplayStatus = AgentStatus | 'waiting'`;
- `displayStatus(row, rows): DisplayStatus` (D18);
- `statusStyle` and `statusEmoji` widened to `DisplayStatus`.

**Failing tests first:**
1. An idle parent with a running child displays `waiting`. With an idle child it displays `waiting`. With a handing-over child it displays `waiting`.
2. An idle parent whose only child is done, replaced or stalled displays `idle`. A parent with no children displays `idle`.
3. A running parent with a running child displays `running`: only idle becomes waiting.
4. Nesting: main idle, child idle, grandchild running. Both main and the child display `waiting`.
5. Main (`id 'main'`) is the parent of rows with `parentId: 'main'`.
6. `statusStyle('waiting')` is `{ color: 'planMode' }`, and `statusEmoji('waiting', id)` is `⏳`.
7. Purity: the input rows are unchanged (deep-equal before and after).

### Task 3: model, effort and status on the rows (register.tsx)

**Amended:** every status glyph, colour, emoji and status word uses `displayStatus(row, rows)`. All logic (`canHandOver`, `isActive`, `LIVE`, sync, the header counts) keeps reading `row.status`. Extra failing tests:
8. (both) agent1 is idle with a running child agent2 (`parentAgentId: 'agent1'`). The row draws `waiting`: `◐` with `color 'planMode'` on the terminal, `⏳` on the desktop.
9. In that same state, pressing `handover:agent1` still sends the HANDOVER **as a message**, because the stored status is idle (`w.sent` gains it). The `handover:agent1` button is still drawn.

**Implementation:**
- **`turn.step`:** patch `model` and `effort` on the row (D12), inside the existing `try`, beside `recordStep`.
- **Desktop row Button:**
  - add the model `Text` (D14) after the label;
  - replace `<Text dimColor>{row.status}</Text>` with `<Text>{statusEmoji(...)} </Text><Text dimColor>{row.status}</Text>`.
- **Terminal row:**
  - split the name cell into a glyph `Text` styled by `statusStyle` and a name `Text`. The name `Text` keeps `inverse`, `bold` and `dimColor`, and the total cell width stays `NAME`.
  - add the model cell (D14);
  - colour the status word with `statusStyle`.

**Failing tests first** (`register.test.ts`, `describe('model and status')`, looped over terminal and desktop where noted):
1. (both) A step with `model: 'claude-sonnet-5-5', effort: 'medium'` puts `Sonnet 5.5 med` in agent1's row text: the `agent:agent1` Button on the desktop, the row Box keyed `agent1` on the terminal. It is persisted in `state.json` (`row(w,'agent1').model`).
2. (both) A step with no `effort`: the row shows `Opus 5.5` (the world's usage model) and no trailing effort. `res.usage.model` wins over `e.model`.
3. (both) Before any step, a spawn with `model: 'haiku'` shows `Haiku`.
4. (terminal) Walk agent1's row. The glyph `Text` `●` has `color: 'success'` and `bold: true` while running. After `complete` the agent is idle: the glyph is `○`, with `color: 'warning'` and `dimColor: true`. After `sync` with no listing it is done: `color: 'success'` and `dimColor`. The status word's `Text` has the same style.
5. (desktop) Running: the row text contains `runnerFor('agent1')`, and remounting gives the same emoji. Idle shows `😴`; done shows `✅`.
6. (terminal) With `bodyColumns: 100`, the timeline `Text` is 17 characters narrower than before. Assert its length equals `max(8, 100 - NAME - 7 - 14 - 17)`.
7. The existing pane, in-view, transcript and handover tests stay green. Adjust only helpers that walk the name cell (the `names` helper) if the split changes where the text sits; never weaken an assertion.

### Task 4: timestamped, expandable transcript (register.tsx)

**Implementation:**
- **State:** declare `transcripts: Record<string, Transcript>` in `PluginState`, and remove `peeks`, `Peek`, `peekLines`, `peekView` and their tests.
- **The read:** `refreshPeek` becomes `refreshTranscript`, and stores `transcriptItems(messages, key => stamps.get(id)?.get(key), { n: 12, chars: STEP_CHARS, startedAt: row.startedAt })`. The in-flight set, reread and timeout are unchanged, and a denial keeps cached items.
- **Stamping:** the module-level `stamps` map. The `tool.call` stamp goes before `next`, and the `turn.step` answer stamp goes after the record (D4). Both are sync and wrapped in `try`, and `register()` clears the map.
- **Terminal item rows:**
  - a short text item is a `Text` (time dim, content);
  - a long text item uses the D3 hover/pin pattern;
  - a tool item is a `plain` Button with key `tool:<agentId>:<toolUseId>`, which runs `openTool` (a no-op stub until Task 5, keyed so Task 5 only fills it).
- **Desktop item rows:** the same, with in-flow expansion.
- **Row budget:** `peekRows = items + 2` (unchanged).

**Failing tests first** (`describe('timestamped transcript')`, both surfaces unless noted, with `session.messages` stubs as in `agent transcript`):
1. Tool stamps: `tool.call` with `tool_use_id: 'b'` from agent1 at clock T. Then pressing `agent:agent1` and settling draws an item whose text starts with `hhmm(T)` and contains `⚙ Bash`.
2. Text stamps: a `turn.step` for agent1 whose result `answer` is `Tests are red` at time T2 (a per-test stub that answers). The transcript item `Tests are red` shows `hhmm(T2)`.
3. The first user message shows the row's `startedAt` time. An unstamped later message shows `--:--`.
4. (terminal) A long assistant text item is cut with `…`. Its Button key `step-agent1-…` exists, and its card Box is `display: 'none'` until pressed, then `'flex'`; a second press sets it back to `'none'`.
5. (desktop) The same press toggles a `full:step-agent1-…` Box holding the full text. No Box has `position: 'absolute'`.
6. A failed call draws `✗`; a call with no `text` draws `(running)`.
7. A read that never answers still blocks neither the pane nor Hand over (port the `transcript read off the render` (a) test to the new keys). (b) to (d) are ported likewise.
8. With twelve agents logged, opening a transcript of three items leaves `ROOM - 1 - (3 + 2)` activity lines (port the existing P7 test).
9. `claude plugin validate .` lists `orchestrator.transcripts`, and no longer lists `orchestrator.peeks`.

### Task 5: tool detail dialog (register.tsx)

**Implementation:**
- **State:** declare `toolView: ToolView | null` in `PluginState`, with `ToolView` from D8 (`import type { ToolDetail } from '../hooks/detail'` in `types/index.d.ts`).
- **Top-level functions:** `openTool($, agentId, toolUseId, title)` (D7), `refreshTool` and `scheduleTool` (D8), and `toolIfOpen` (D8).
- **Hooks:** a `ui.close` hook (D7); a `ui.render` hook for `{ component: 'Pane', requestId: TOOL_PANE }` drawing the D11 tree.
- **Inline fallback** in the main pane on non-terminal surfaces when `toolView.inline`.

**Failing tests first** (`describe('tool detail')`, both surfaces unless noted):
1. Pressing `tool:agent1:b` adds `orchestrator-tool` to `w.opened` and never awaits the read. With a held `session.messages`, the press resolves, and Hand over is still pressable.
2. After settling, mounting the Pane with `requestId: 'orchestrator-tool'` shows a `Code` with `language: 'bash'` holding the command, and a `Code` holding the output.
3. An Edit use draws a `Code` with `format: 'diff'`. A Read use draws a `Code` with `path` and `startLine`. A Grep use draws its pattern.
4. Before the read settles the pane shows `loading…`. A use that is not in the transcript shows the not-readable line. A use with no `text` shows `running…`, and then, after a `tool.call` for `tool_use_id: 'b'` settles, the output.
5. `close` (role `dismiss`) adds `orchestrator-tool` to `w.closed` and nulls `toolView`: a remount shows `No tool call selected.`
6. `$.ui.close({ id: 'orchestrator-tool' })` from outside (the person's Escape) clears `toolView`. Closing the Orchestrator pane leaves it alone.
7. Pressing the same tool item again closes the dialog.
8. (desktop) With `on('ui.open')` answering `{ isPlaced: false, reason: 'older desktop' }` for `orchestrator-tool`, the main pane draws `tooldetail:b` beneath the item, holding the `Code`.
9. Mounting the detail pane on `vscode` and `mobile` resolves (no refusal).
10. The full detail stays within the Code limit: a 200k-character Bash output gives a mounted tree whose `Code` sources sum to at most 100,000.

### Task 6: docs and version (content, exempt from TDD)

- **README "Visual":**
  - transcript entries carry times (UTC `hh:mm`, `--:--` when the mod did not see them happen);
  - long entries open as the activity log's do;
  - clicking a tool call opens a detail pane, closed by Escape or Close (on an older desktop app it opens in place);
  - each row shows its model and effort;
  - the terminal colours and the desktop emoji are listed.
- **README "Develop":** mention `hooks/detail.ts`.
- **SKILL.md §3 "Tools":** one clause saying that clicking a tool call in a transcript opens its detail. Also add the `waiting` status (idle with live children).
- **SKILL.md, orchestrator brief (§2 checklist) and spawn guidance, per D19:**
  - background agents stay;
  - every spawn names the agent and ends with the persuasive SendMessage report-back clause (give the exact wording);
  - the orchestrator itself must be spawned with a `name`;
  - the single-shot check-in, with the estimate-plus-buffer rule;
  - the mechanism per F13 to F16: main uses `CronCreate` with `recurring: false`; a subagent orchestrator cannot schedule its own wake-up, so it relies on the report-back clause and the main session's backstop, or on `checkin` once Task 7 ships;
  - the check-in is ignored or cancelled (`CronDelete`) once the report arrives.
- **README, "The orchestrated-run skill":** the same points in two or three sentences.
- **Last, after Task 5 is green:** `.claude-plugin/plugin.json` `"version": "0.3.4"`. Rerun all gates.

### Task 7 (optional, escalated): mod check-in for subagent orchestrators (D20)

Run this task only on the user's go-ahead. TDD is mandatory.

**Scope:**
- `hooks/register.tsx` and `hooks/register.test.ts`;
- `types/index.d.ts`: `AgentRow.checkinAt?: number` and `checkinBy?: string`;
- a pure `checkinDue(rows, now)` and the message text in `view.ts` and `view.test.ts`.

**Failing tests first:**
1. Calling `mcp__orchestrator__checkin` from agent1's loop (`agentId: 'agent1'`, `{ agent: 'impl-2', minutes: 30 }`) stores `checkinAt` on agent2 and `checkinBy: 'agent1'`.
2. Advancing 30 minutes and 30 s, the sync sends one `w.sent` entry to agent1 naming impl-2. Further syncs send nothing more.
3. If agent2's `SendMessage` (a `tool.call` from agent2's loop with `to: 'agent1'`, or agent1's name) comes before the deadline, the check-in is disarmed and nothing is sent.
4. With `checkinBy` set to main, the check-in toasts and appends instead of sending.
5. `minutes: 0` cancels. An unknown agent answers an error text, and nothing is stored.
6. A reload (re-register) keeps the deadline, and it still fires.
7. The tool never blocks or alters the HANDOVER path: the existing `tool.call` HANDOVER tests stay green.

## Escalations and degradations

- **Item 5 timer (design call needed).** No agent-callable tool wakes a **subagent** orchestrator. `CronCreate` fires into the main REPL only (F13); `ScheduleWakeup` is `/loop`-only and not available to subagents (F14); `RemoteTrigger` and `Monitor` don't fit (F15). The only working wake-up is mod-side `$.session.send` to the agent id (F16). The choice is between Task 7 (D20, the `checkin` tool) and auto-forwarding a child's final answer to its parent (the alternative in D20). Until the user decides, the skill tells subagent orchestrators to rely on the report-back clause.

- **No message timestamps in the API (F1).**
  - Times are what the mod observed: tool calls while loaded, step answers, and the brief.
  - History from before the mod loaded, or from before a reload (the stamp map is module memory), shows `--:--`.
  - User messages other than the brief, such as SendMessage and HANDOVER, show `--:--`.
  - True per-message times need an engine field (`SessionMessage.t`). This is a feature request.
- **Times are UTC**, matching the existing activity log (`hhmm`). Changing both to local time is a separate decision for the user.
- **Subagent tool output is only what the model read (F2).** There is no separate stdout, stderr or exit code, and Bash output is whatever the tool returned as text.
- **Edit diffs have no real line numbers (F5).** The hunk is numbered from 1 and labelled as such.
- **The desktop dialog is unverified on 2.1.295.** B295 has the option strings, but whether the app places a second pane (as a tab) is untested. The inline fallback (D7) covers `isPlaced: false`. The manual desktop check records which happens.
- **Effort on 2.1.295 is unverified** (no `.d.ts`). If `e.effort` is absent, the row shows the model alone (D12). Agents spawned before a reload show their model only after their next step.
- **"Bright green" has no theme key (F11).** Running is `success` + bold, and done is `success` + dim. Raw colours (`greenBright`) would ignore the person's theme, so they were rejected.
- **The dialog takes the shown slot (F6):** the Orchestrator pane becomes a tab until the dialog closes.

## Manual check (final reviewer)

**Terminal:** `claude --plugin-dir /Users/victorb/code/cc-orchestrator-mod`.
1. Spawn two agents (one with `model: sonnet`, `effort: low`). Rows show `Sonnet 5.5 low` (or the current id's name) with coloured glyphs.
2. Click an agent: its timestamped items appear. Hover or click a long item to see its card.
3. Click a Bash item: the dialog shows the command and output, and Escape closes it. Click an Edit item: a coloured diff.

**Desktop:** the same steps, using `CLAUDE_CODE_PLUGIN_DIRS` as in the desktop-target plan. Also check:
- emoji per status, with each running agent's runner unchanged across redraws;
- long items expand in place;
- the tool dialog opens as a pane, or inline on an app that places no second pane. Record which.
