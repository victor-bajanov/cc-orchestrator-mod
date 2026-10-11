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

### Check-in and auto-forward (amendment, decided D20 + D21)

- **F19. A mod tool can be registered and served.**
  - **Registering:** `$.tool.register({ name, description, inputSchema?, isDeferred? })` declares `mcp__<plugin>__<name>` "from the next prompt on". It "rejects until the session binds, at `session.start`" (T:3049-3058; `ToolSpec` T:13125-13150).
  - **Deferral:** left out, `isDeferred` places the tool behind ToolSearch. `false` puts it in the prompt's tool list.
  - **Serving:** a `tool.call` hook on `{ tool: 'mcp__orchestrator__checkin' }` returns the result; "a call no hook answers fails". That hook's `e.agentId` is the calling loop, or absent on main.
  - **Versions:** the op `"tool.register"` is present in both B295 and B296 (8 occurrences each), as are `"session.send"` and `"session.append"`.
  - **Subagent access is unverified:** that a subagent's tool list includes plugin tools is not stated in T. An agent with no restricted `tools` gets "every tool the parent has" (`AgentSpec.tools` T:461-465). See Escalations.
- **F20. How an agent's end exposes its final answer.** `turn.complete` fires once per run of a subagent's loop. `e.agentId` identifies the subagent and is absent on main. `e.answer` is "the assistant's final visible text … For a subagent's run that handed its report back to its spawner, the report delivered". `e.reason` is `'answer'`, `'aborted'`, `'refusal'` or `'error'`. Sources: `TurnCompleteFields` T:13284-13320, and the event doc at T:4462-4471. The mod already routes this through `onAgentEnd($, id, answer)`.
- **F21. Parent, main and teammates.**
  - **Parent:** the mod stores `AgentRow.parentId = e.parentAgentId ?? 'main'` at `agent.spawn` (R, the `agent.spawn` hook). `parentAgentId` is "the id of the loop the spawn happens in …; absent from main" (T:313-321). So `parentId === 'main'` means the main thread is the parent.
  - **Teammate:** `AgentSpawnInput.isTeammate?: true` is "present, and true, when the call starts a teammate" (T:336-342). `AgentInfo.teammateId` is set only for teammates (T:132-139). Today the mod sets `isTeammate` only on respawn (R `respawn`), so the `agent.spawn` hook must also record `e.isTeammate`.
  - **Foreground versus background:** `AgentSpawnInput.background: boolean` (T:323-331). A foreground child's answer is the parent's Agent tool result, so it is delivered already.
  - **SubagentHandback:** a report handed back through it is delivered to the spawner. The internal `handback: 'send'|'flagged'|'withheld'` on the Agent result is marked `@internal` (T:16814-16822), so the mod treats an observed `SubagentHandback` `tool.call` from the child with a successful result as reported.
- **F22. A message reaches its addressee by name or id.** The `SendMessage` input is `{ to, message, summary? }`, where `to` is "a name from ListAgents, a teammate name, "main", or a background agent's agentId" (T:16625-16628). The mod sees a child's `SendMessage` as a `tool.call` with `e.tool === 'SendMessage'` and `e.agentId` set to the child.

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
| D19 | **Skill brief (item 5).** Orchestrators keep using background agents. Each spawn prompt must end with a persuasive, explicit report-back clause: *"Your final message is NOT delivered to me. Before you end, you MUST call SendMessage to `<orchestrator name>` with your full report; if you skip this, I never learn you finished and the run stalls."* The orchestrator names itself, so it must be spawned with a `name`.<br>For each spawn, the orchestrator estimates the task's duration and adds a buffer (max(10 min, 50%)), then arms a **single-shot check-in**. When the check-in fires and no report has arrived, the orchestrator checks the agent (`/orch roster`, the pane, or a SendMessage nudge). When the report arrives first, the check-in is ignored.<br>**Mechanism per F13 to F16:**<br>• A **main-session** orchestrator uses `CronCreate` with `recurring: false` and a pinned minute, and `CronDelete`s it on the report.<br>• A **subagent** orchestrator has no tool that wakes it. It relies on the mod: the `checkin` tool (D20, Task 7a) and auto-forward (D21, Task 7b). Amended per the user's decision; see Task 6. |
| D20 | **Mod check-in: DECIDED, built in Task 7a.** The details below stand. Cancellation happens on an observed child→parent `SendMessage` (F22), on a delivered `SubagentHandback`, or when the child's turn ends. One deadline is kept per child, and calling again re-arms it. The ending "Alternative" is superseded by D21, which is also built.<br>(original text:) **Mod check-in.**<br>The mod registers a tool `mcp__orchestrator__checkin` `{ agent: name\|id, minutes: number }` in `session.start`, served by a `tool.call` hook. It records `checkinAt = now + minutes` on the child's row, and the parent is the calling loop's `e.agentId ?? 'main'`. Calling it again re-arms; `minutes: 0` cancels.<br>**Disarming:** the check-in is disarmed when the mod sees the child's `SendMessage` whose `to` names the parent (a `tool.call` on `SendMessage` from the child's loop), or when the parent's own report arrives some other way.<br>**Firing:** the existing 30 s `sync` fires a due check-in once.<br>• For a **subagent parent:** `$.session.send({ to: { agentId: parent }, text: '[orchestrator mod] check-in: <label> (id) has not reported after N min; status <displayStatus>, last active <hh:mm>.' })`. This wakes or resumes the parent (F16).<br>• For **main:** a toast plus `$.session.append` (the `tellParent` path).<br>The deadline lives in state (`AgentRow.checkinAt?`, `checkinBy?`), so it survives a reload.<br>**Alternative for the user to weigh:** the mod could forward a child's final answer to its parent automatically, as `onAgentEnd` already does for replacements. That removes the need for the report-back clause but duplicates any report the child did send. |
| D21 | **Auto-forward (built in Task 7b).** When a child's run ends, `forwardTarget(row, rows)` decides whether the mod forwards `e.answer` to the child's **parent agent**. It skips when:<br>• the parent is `main` or undefined: the engine already notifies main of its background agents, and a mod-spawned replacement under main keeps today's `prompt.submit` path;<br>• the child is a teammate (`isTeammate`): the engine delivers its reply;<br>• the child is foreground (`background === false`): the answer is the parent's tool result;<br>• `reportedSince(row)`: the child sent `SendMessage` to its parent, or handed back successfully, after its spawn or after the parent's latest message to it;<br>• `e.reason !== 'answer'`, or the answer is empty after trimming;<br>• the row is `handing-over`: that branch of `onAgentEnd` never forwards.<br>Otherwise it forwards with `$.session.send({ to: { agentId: parentId } })`, which wakes or resumes the parent (F16), and stamps `reportedAt`. A failure is logged as a warning and never thrown.<br>The current replacement forward to a subagent parent is folded into this rule, so a replacement is forwarded once. |

## File scopes and ordering

| Task | Files | Runs |
| --- | --- | --- |
| 1 | `hooks/view.ts`, `hooks/view.test.ts`, `types/index.d.ts` (types only, no state keys) | **parallel** with 2 and 6 |
| 2 | `hooks/detail.ts` (new), `hooks/detail.test.ts` (new) | **parallel** with 1 and 6 |
| 1b | `hooks/view.ts`, `hooks/view.test.ts` | after 1's polish, before 3 |
| 3 | `hooks/register.tsx`, `hooks/register.test.ts` | after 1b |
| 4 | `hooks/register.tsx`, `hooks/register.test.ts`, `hooks/view.ts`, `hooks/view.test.ts` (legacy removal only), `types/index.d.ts` | after 3 |
| 5 | `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts` | after 4 and 2 |
| 6 | `README.md`, `skills/orchestrated-run/SKILL.md` (D19 brief and the D18 status included), then `.claude-plugin/plugin.json` version **0.3.4** | docs in parallel at any time; the version bump is last, after 8 is green |
| 7a | `hooks/register.tsx`, `hooks/register.test.ts`, `hooks/view.ts`, `hooks/view.test.ts` (the 7a/7b helpers only), `types/index.d.ts` | after 5 |
| 7b | the same files | after 7a |
| 8 | `hooks/view.ts`, `hooks/view.test.ts` (the collapse helpers), `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts` | after 7b |

**TDD is mandatory for Tasks 1, 1b, 2, 3, 4, 5, 7a, 7b and 8 (and 8F if triggered).** For every behaviour: write the failing test first, run `claude plugin test .` and watch it fail for the expected reason, then implement until it passes. Pass this rule on to any sub-agent. Task 6 is content and exempt.

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
- **SKILL.md, orchestrator brief (§2 checklist) and spawn guidance, per D19 as amended:**
  - Background agents stay.
  - Every spawn names the agent. The orchestrator itself is spawned with a `name`.
  - Each spawn prompt ends with the persuasive SendMessage report-back clause, kept as belt-and-braces. Give the exact wording, and have it say "message the orchestrator by name or id".
  - After each spawn the orchestrator calls the mod's check-in tool, `mcp__orchestrator__checkin { agent, minutes }`. The minutes are its estimate of the task's duration plus a buffer of max(10 min, 50%). Calling it again re-arms the check-in. When the check-in message arrives, the orchestrator checks the agent.
  - Note that the mod auto-forwards a background child's final answer to its parent when the child did not message the parent itself (D21), so no report is lost.
  - A main-session orchestrator may also set a one-shot `CronCreate` with `recurring: false`, and `CronDelete` it on the report.
- **README, "The orchestrated-run skill" and "What it does":** the same points in a few sentences: the check-in tool, auto-forwarding to the parent, and that reports no longer land in main.
- **README "Visual" and SKILL.md §3:** double-click a row with children to collapse its finished descendants into `+N done`; live agents always stay visible.
- **Last, after Task 8 is green:** `.claude-plugin/plugin.json` `"version": "0.3.4"`. Rerun all gates.

### Tasks 7a and 7b: check-in and auto-forward (register.tsx; after Task 5, sequential, 7a then 7b)

**Shared record (7a introduces it, 7b reuses it).** `AgentRow` gains these fields:
- `background?: boolean`, from `agent.spawn`'s `e.background`;
- `isTeammate` is now also set at spawn, from `e.isTeammate` (today it is set only on a respawn);
- `instructedAt?: number`: the time of the spawn, or of the latest message from the parent to this child (an observed parent `SendMessage` whose `to` names the child, or the mod's own `$.session.send` to it);
- `reportedAt?: number`: the time of the child's latest observed `SendMessage` to its parent, or of a delivered `SubagentHandback`;
- `checkinAt?: number`, `checkinMins?: number` and `checkinBy?: string`.

**Pure helpers (`view.ts`):**
- `namesAgent(to: unknown, row): boolean` is true when `to` equals the row's id, its name or its `teammateId`, or is `'main'` for main;
- `reportedSince(row) = (row.reportedAt ?? -1) >= (row.instructedAt ?? 0)`;
- `checkinDue(rows, now)`;
- `forwardTarget(row, rows)`, which returns `'skip'` or `{ agentId }` (D21).

### Task 7a: the check-in tool (D20, firm)

**Implementation:**
- In `session.start`: `await $.tool.register({ name: 'checkin', description, inputSchema: { agent: string, minutes: number }, isDeferred: false })`.
- Serve it in a `tool.call` hook on `{ tool: 'mcp__orchestrator__checkin' }`. The hook returns its own result and never calls `next` (F19).
- The caller is the parent: `e.agentId ?? 'main'`.
- It resolves `agent` among that parent's children (by id, then by the latest live row with that name). It sets `checkinAt = now + minutes*60_000`, `checkinMins` and `checkinBy`. With `minutes <= 0` it clears them.
- It answers in one line. An unknown agent answers an error, and nothing is stored.

**Cancel:**
- In the existing `tool.call` hook, after `next`, for `e.tool === 'SendMessage'` from a child's loop where `namesAgent(input.to, parentRow)`: set `reportedAt = now` and clear the check-in.
- When the parent's loop sends `SendMessage` to a child, set the child's `instructedAt = now`.
- When the child's turn ends (`onAgentEnd`), clear its check-in.
- All of this runs inside a `try`, after HANDOVER attachment, and never alters `out`.

**Fire:** in `sync`, for each `checkinDue` row, clear the check-in first, then:
- if the parent is a subagent: `$.session.send({ to: { agentId: parent }, text })`;
- if the parent is main: `tellParent`, which appends, plus a toast.

The text is `[orchestrator mod] check-in: <label> (id <id>) has not reported after <N> min; status <displayStatus>, last active <hh:mm>. Check on it, or call checkin again to re-arm.`

**Failing tests first** (`describe('check-in')`; stub `tool.register` in `world`):
1. `session.start` registers `checkin` (the stub records it).
2. A `$.tool.call` of `mcp__orchestrator__checkin` with `agentId: 'agent1'` and `{ agent: 'impl-2', minutes: 30 }`, where agent2 is a child of agent1, stores `checkinAt`, `checkinMins: 30` and `checkinBy: 'agent1'` in `state.json`. The result text names impl-2.
3. After `clock.advance(30 min + SYNC_MS)`, `w.sent` gains exactly one entry to agent1 containing `check-in` and `impl-2`. Another sync adds none.
4. agent2's `SendMessage` (`tool.call` from `agentId: 'agent2'` with `{ to: 'agent1' }`, and again with the parent's name) before the deadline means nothing is sent and `reportedAt` is set.
5. agent2's `turn.complete` before the deadline means nothing is sent.
6. Calling it again re-arms, so only the later deadline fires. `minutes: 0` cancels. An unknown agent gives an error result and no state change.
7. A check-in set by main (no `agentId`) appends a session message and toasts instead of sending.
8. A reload (a new `register`) keeps the deadline, and it still fires.
9. The `tool.call` HANDOVER tests and the "never touches the handover path" tests stay green unmodified.

### Task 7b: auto-forward a child's final answer to its parent (D21)

**Implementation:** in `onAgentEnd`'s active branch, replace the replacement-only forward with `forwardTarget`. When it is not `'skip'`, send `[orchestrator mod] <label> (id <id>) finished; its final answer (auto-forwarded):\n\n<answer>` with `$.session.send({ to: { agentId: parentId } })`, then set `instructedAt = reportedAt = now`, so a resumed child's next answer is judged afresh.
- The existing replacement path is the precedent (R `onAgentEnd`: `isOurs && !isTeammate && parentId !== undefined`). A replacement whose parent is **main** keeps today's `prompt.submit` forward, because the engine does not deliver a mod-spawned agent's answer to main. Its tests stay unchanged.
- The handing-over branch is unchanged: a HANDOVER-ending answer is never forwarded.

**Failing tests first** (`describe('auto-forward')`; spawn a child with `parentAgentId: 'agent1'` and `background: true`):
1. A child ends with answer `R`, with no SendMessage seen: `w.sent` gains one entry to agent1 containing `R` and `auto-forwarded`.
2. A child that sent `SendMessage` to agent1 after its spawn: nothing is forwarded.
3. Then agent1 messages the child again (a `tool.call` SendMessage from agent1 naming the child), and the child ends again without reporting: it **is** forwarded.
4. A child whose parent is main: nothing is sent (`w.sent` and `w.prompts` unchanged).
5. A teammate child (spawn with `isTeammate: true`): nothing is forwarded.
6. A foreground child (`background: false`): nothing is forwarded.
7. A child with status `handing-over`: nothing is forwarded, and today's handover handling is unchanged.
8. An empty answer, or `reason` other than `answer` (aborted or error): nothing is forwarded.
9. A delivered `SubagentHandback` (a `tool.call` from the child with a result whose `success` is true): nothing is forwarded.
10. A replacement whose parent is main still gets today's `prompt.submit` forward. A replacement under agent1 is forwarded exactly once (no double send from the old and new paths).
11. A forward that fails (a `session.send` stub that throws or answers undelivered) is logged as a warning and does not throw out of `turn.complete`.

### Task 8: collapse finished descendants on a double-click (after 7b)

**Facts:**
- **F23. There is no double-press API.**
  - `Button.onPress` is `(e: UiPressArgument) => void` (T:1157-1167).
  - `UiPressArgument` is `{ plugin, element, component, requestId, surface, link? }` (T:14210-14250). It has no click count, no detail and no timestamp.
  - A grep of T for `double`, `clickCount` and `detail:` finds only one double-click mention. It is for Markdown links: "a press is a plain single click where the surface reports clicks (the fullscreen terminal): it … lands once no double-click followed" (T:5728-5730).
  - That proves the engine knows about double-clicks on the terminal, but it says nothing about whether a Button's double-click arrives as two presses.
  - **Consequence:** detect a double press in the mod, as two presses on the same key within 400 ms of `$.clock.now()`.
- **F24. Main's children are rows with `parentId === 'main'`.** `orderRows` draws them as roots at depth 0, beside main (core.ts `orderRows`). The terminal draws main's name as plain `Text`, not a Button (agent-focus P5). The desktop draws it as `Button agent:main`.

**Decisions:**
- **D22. Collapse rule** (pure, `view.ts`):
  - `childrenOf(rows, id)` returns the rows whose `parentId === id`. For main it also includes non-main rows with `parentId` undefined.
  - `collapseHidden(rows, collapsed: readonly string[]): Set<string>`. For each collapsed id that names a present row, hide every descendant whose stored status is `done` or `replaced`, unless that descendant has a visible descendant. A finished agent with a live child stays, so the tree never orphans a live row.
  - Nothing live (running, idle, waiting, handing-over, stalled) is ever hidden.
  - A collapsed row inside a hidden subtree has no effect of its own.
  - `hiddenCount(rows, id, hidden)` counts that row's hidden descendants.
  - The `collapsed` state key lists row ids.
  - Display only: `paneHeader`, sync, the roster, persistence and handover logic all read the full rows.
- **D23. Drawing.**
  - The tree and the chart use `visible = rows.filter(r => !hidden.has(r.id))`.
  - `contextChart` gets `rows: visible`, but `colors: seriesColors(rows)` over all rows, so colours stay stable. The chart's time axis `t0` comes from all rows, so collapsing does not rescale it. `contextChart`'s `t0` reads `i.rows`, so add an optional `t0?: number` to `ChartInput` (a pure change with a `view.test.ts` test).
  - The terminal timeline's `t0` is unchanged (all rows).
  - A collapsed row with N > 0 hidden appends `+N done`. It is dim, inside the row Button on the desktop and after the name on the terminal.
  - A selection or in-view id that names a hidden row draws nothing: `liveSelection(visible, …)`.
- **D24. The trigger is a double-click, detected by the mod.**
  - Pure `isDoublePress(last: { key, t } | undefined, key, now, ms = 400)`.
  - Module-level `lastPress = { key, t, prevSelected }`. A reload resets it, which is harmless.
  - The row Button's press runs top-level `pressAgent($, id)`:
    1. `now = await $.clock.now()`.
    2. **Double:** if `isDoublePress(lastPress, id, now)`, restore `selectedAgent` to `lastPress.prevSelected`, undoing the first click's toggle. If `childrenOf(rows, id)` is non-empty, toggle `id` in `collapsed`. Clear `lastPress`.
    3. **Single:** otherwise remember `{ key: id, t: now, prevSelected: <selected before> }`, then run today's `toggleSelected($, id)`.
  - So a single click still opens or closes the transcript at once. A double-click briefly opens it and the second click undoes it, so it nets to collapse only.
  - A double-click on a row with no children nets to nothing.
  - Two Enter presses within 400 ms count as a double. That is accepted.
  - The **terminal main row becomes a `plain` Button** `agent:main`, holding the same cell, so main can be collapsed. A single click on main selects it, which only bolds it; no transcript opens for main, as today (P5).
- **D25. Fallback, if the manual check shows a surface delivers no second press** (for example, the terminal swallows a double-click):
  - On that surface only, a chevron `Button plain key="collapse:<id>"` labelled `▸` (collapsed) or `▾` (expanded) is drawn before every row that has children. It toggles `collapsed` directly.
  - This is a follow-up commit with its own tests, listed below as 8F, and flagged in the PR.

**Pure tests first** (`view.test.ts`, `describe('collapse')`):
1. `childrenOf`: main's children are the `parentId: 'main'` rows. An orchestrator's are its own.
2. `collapseHidden`:
   - an orchestrator with two done children and one running child, collapsed, hides exactly the two done ones;
   - not collapsed, it hides none;
   - replaced children are hidden too.
3. A done child with a running grandchild stays visible, and its own done children are hidden.
4. A fully finished orchestrator (all descendants done or replaced), collapsed, hides all of them, leaving one row.
5. Main collapsed hides done top-level agents, and keeps running and stalled ones.
6. A stale collapsed id, or an id with no children, hides nothing. `hiddenCount` matches the hidden set.
7. `isDoublePress`:
   - the same key at 399 ms is true;
   - the same key at 401 ms is false;
   - a different key is false;
   - `undefined` is false.
8. `contextChart` with `t0` given uses it for the left axis label. Without it, it behaves as today.

**Wiring tests first** (`register.test.ts`, `describe('collapse')`, both surfaces). Setup: agent1 (orchestrator, `parentId: 'main'`) with children agent2 done, agent3 done, and agent4 running (spawned with `parentAgentId: 'agent1'`). Presses go through `ui.press({ key: 'agent:agent1' })`, with `w.clock.advance` controlling the gap.
1. Two presses with no clock advance:
   - `agent2` and `agent3` rows are gone (`find({ key: 'agent:agent2' })` is undefined on the desktop, and the row Box is absent on the terminal), and `agent4` remains;
   - agent1's row text contains `+2 done`;
   - on the desktop, the Svg `source` has no path in agent2's or agent3's colour, and agent4's colour is unchanged;
   - `selectedAgent` is back to `''`, and no `peek:agent1` is drawn.
2. Two more presses with no advance expand it again: all rows are back and `+2 done` is gone.
3. Two presses 500 ms apart act as two single clicks: the transcript opens, then closes, and nothing collapses.
4. With a transcript already open on agent4, a double-click on agent1 collapses it and leaves agent4's transcript open: the selection is restored to its previous value.
5. A double-click on childless agent4: no change in the rows, and the selection is unchanged.
6. Main:
   - on the terminal, `agent:main` exists;
   - a double-click on main with all top-level agents done (the agent1 subtree finished) collapses the pane to the main row plus `+N done`;
   - a running top-level agent stays visible.
7. Finishing: once agent4 completes and sync marks it done, a collapsed agent1 shows `+3 done` and draws a single row.
8. Display only:
   - with agent1 collapsed, `paneHeader` counts are unchanged;
   - `roster.md` and `state.json` still list agent2 and agent3;
   - `handover:agent4` is still drawn and pressable.
9. `collapsed` persists across a remount. `claude plugin validate .` lists `orchestrator.collapsed`.
10. Existing tests stay green: the in-view, transcript, handover and chart-bounds tests.

**8F (only if D25 triggers), failing tests first:**
- on the affected surface, `collapse:agent1` exists only for rows with children;
- its label is `▾`, and `▸` once pressed;
- one press collapses;
- the `agent:` press is single-click only there.

## Escalations and degradations

- **Double-click delivery is unverified (F23).** No API reports a double press, so the mod times two presses itself (D24). Whether the fullscreen terminal and the desktop's native buttons deliver both presses of a double-click is only known by hand. The manual check must try a double-click on both surfaces. If one fails, ship 8F (the chevron) for that surface and flag it.

- **Item 5 timer: decided.** No agent-callable tool wakes a **subagent** orchestrator: `CronCreate` fires into the main REPL only (F13), `ScheduleWakeup` is `/loop`-only (F14), and `RemoteTrigger` and `Monitor` don't fit (F15). So the mod does it: Task 7a's `checkin` tool and Task 7b's auto-forward, both through `$.session.send` (F16).
- **Plugin tools inside subagents are unverified (F19).** If a subagent orchestrator's tool list lacks `mcp__orchestrator__checkin` (for example, when its agent definition restricts `tools`), the auto-forward still covers reports, but there is no check-in. The manual check records whether a background orchestrator can call it. The skill says to add the tool to restricted `tools` lists.
- **Main still gets the engine's own notifications** for its background agents (D21 skips them). "Reports stop landing in main" therefore holds for grandchildren: they now go to their orchestrator.

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
