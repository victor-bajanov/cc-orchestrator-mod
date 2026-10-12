# Background-shell watcher, idle watchdog, check-ins that survive a teammate's turn ends

Date: 2026-10-12 · Branch: `bg-shell-watcher` · Mod version now: 0.3.7 → **0.3.8** (Task 0) · Engine: 2.1.296

## Goal

The engine sometimes never wakes an idle agent when its own background shell exits. A named teammate in the terminal is never woken. Headless, the wake waits for main's turn end. See [engine-bug-bg-shell-wake.md](../engine-bug-bg-shell-wake.md). This plan adds:

1. The mod tracks every backgrounded Bash call.
2. It polls each output file for the exit marker.
3. If the agent hasn't picked a finished shell up within a grace period, the mod sends it a nudge through the outbox.
4. A shell still running past a ceiling gets one nudge.
5. An idle watchdog nudges an agent that is idle with nothing running.
6. A teammate's check-in survives its turn ends.

## Baseline (run 2026-10-12 on `cfe70fc`, branch `bg-shell-watcher`, clean)

| gate | result |
| --- | --- |
| `claude plugin test .` | **494 pass, 0 fail, 4 files** (core 36 `test(` sites, view 114, detail 30, register 263; loops add the rest) |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0 |
| `claude plugin validate .` | `✔ Validation passed` (with the usual "gating hook without .catch" notes) |

## Global invariants (every task)

- **TDD always, no exceptions.** Write the failing test first, run `claude plugin test .` and watch it fail for the expected reason, then implement until it passes. Pass this rule on to any sub-agent. Only README, SKILL and doc text, and the version bump, are exempt.
- **Commits and PRs:** never put a Claude session link or a `Claude-Session:` trailer in them; keep `Co-Authored-By`. Python scripts, if any, use PEP 723 and run with `uv run`.
- **Don't break existing tests.** Rewrite only the tests this plan names.
- **Hooks never throw.** Guard with try/catch and fall through (`return next(e)` or a harmless default). A new gating registration gets `.catch(($, e, next) => next(e))`.
- **Timers never send or spawn.** Every nudge is `enqueue({ agentId, text, what, liveOnly: true })` (R:1100). `drain` (R:1113) sends it at the next turn end of any agent; `nudgeIfStuck` (R:1192) prompts main when everything is idle. Every send still goes through `sendOwn` (R:746).
- **Carried over:** `$` is passed only to top-level functions in R; no state is written while drawing; every `$.state` key is declared in `PluginState`. **No new `$.state` key.** Shell state lives on `AgentRow`, so `persist` (R:337-344) writes it to `state.json`, and `restore` (R:265-282) brings it back after a `/clear`.
- **Gates after every task:** the test count is the previous count plus the new tests, with 0 fail; tsc exits 0; validate passes.

## Facts (sources)

**T** is `.claude-plugin/types/claude-code/index.d.ts`, **R** `hooks/register.tsx`, **RT** `hooks/register.test.ts`, **C** `hooks/core.ts`, **CT** `hooks/core.test.ts`, **V** `hooks/view.ts`, **VT** `hooks/view.test.ts`, **TY** `types/index.d.ts`, **P** `.claude-plugin/plugin.json`.

- **F1. Bash result.** Results come from live probes and T:20195-20214. `res.result.backgroundTaskId` is set for every kind of backgrounding. `backgroundEndsWithFinalResponse: true` (T:20212-20214) means the command dies with its caller's final response, so no notice can follow: don't track it. `res.text` (T:12750-12756) names the output path: `/Output is being written to: (.+?\.output)\.(?:\s|$)/`. `e.description` and `e.command` sit flat beside `tool`. `e.agentId` is absent on main.
- **F2. TaskStop.** The input is `{ task_id?, shell_id? }`; `shell_id` is the deprecated alias (T:16716-16721). The result is `{ message, task_id, task_type: 'local_bash', command }`.
- **F3. Output file.** It is 0 bytes when the command is backgrounded. On exit the engine appends `\n[exited with code N]\n`. TaskStop, or claude ending gracefully on SIGTERM, appends `\n[killed]\n`. A hard crash appends nothing. Read the marker anchored at EOF, over the last 256 characters.
- **F4. `$.fs`.** `read` rejects a missing file or one over 4 MiB, and there is no partial read (T:3230-3249). `stat` gives `{ kind, size, mtimeMs, isLink }` and rejects a missing file (T:3328, T:4995-5013). So poll by `stat` and `read` only when the size has changed.
- **F5. Main thread vs subagent runs.** A subagent's run raises no `turn.start` (T:13302-13306; R:1684 comment), so "the agent ran again" is its first `turn.step` after its `turn.complete`. That end sets `idle` (R:1268-1269), and `recordStep` revives `idle`/`done` to `running` (C:40-60). Main's row never leaves `running` (main's ends don't go through `onAgentEnd`; R:1722).
- **F6. Classic hooks.** `on('classic.Stop')` and `on('classic.SubagentStop')` exist (T:1237-1259). Tests call `$.classic.SubagentStop({...})` (`EngineClassic`, T:15042-15044). Both inputs carry `background_tasks?: BackgroundTaskSummary[]` (T:12125-12139, T:12252-12269; summary at T:799-822). The list is session-wide, with no owner, and a finished shell drops out. TeammateIdle has none.
- **F7. Engine agent status.** `$.agent.list()` entries carry `status`: `idle` means between turns until a message wakes it; `waiting` means held on its own background work; `completed`, `failed` and `killed` mean ended (T:156-163, T:537-545). The engine keeps an entry until it drops the task: a teammate's as it ends, a subagent's later (T:3186-3194). `sync` keeps only the ids (R:1288) and marks an unlisted active row `done` (R:1299-1301).
- **F8. Check-ins.** `checkin` (R:1025-1057) arms `checkinAt/Mins/By`. It is disarmed by a SendMessage report (`noteReport` R:1073-1080), by every turn end of an active row (`onAgentEnd` R:1268-1269, `{ status: 'idle', ...DISARMED }`), and by handover endings (R:1254, R:1265). `sync` marks a row `done` without disarming it (R:1300). Check-ins fire from `sync`, through `fireCheckins` (R:1201-1224). The loop: R:1287-1320, every `SYNC_MS` = 30 s (R:71, R:1454).
- **F9. Config.** `cfg` sits at R:100-107 and is read in `register` at R:1396-1401. `userConfig` is in P.
- **F10. Hook wiring points.** In `tool.call` (R:1572-1646), main returns at R:1624, so shell tracking goes before it, right after `out` is built at R:1623. `argsOf` is at R:1013. `turn.step` records at R:1537. Session start ends with `$.clock.every(SYNC_MS, …)` at R:1454. `register()` resets module state at R:1402-1421. The classic registrations go after R:1682.
- **F11. The test world** is RT:14-279. `fs.read` and `fs.exists` read `w.files` (RT:200-205), and there is no `fs.stat`. `w.agents` (RT:30) feeds `agent.list`, without status. `toolAnswer` (RT:47, RT:276) answers tool calls beneath the plugin. The clock is `mock.clock` (`w.clock.advance(ms)`, `w.clock.settle()`). Options are passed as `test(name, { options: {...} }, fn)` (RT:353). Helpers: `call` (RT:2304), `family` (RT:2311: agent1 `impl-1` under main, agent2 `impl-2` under agent1, both listed), `complete` (RT:314), `step` (RT:304), `row` (RT:327).

## Decisions

- **Main's shells are tracked, never nudged.** The engine wakes main itself: interactive main isn't in the bug's table, and headless delivery happens at main's turn end. A mod nudge to main would be a `$.prompt.submit` the user sees. Main's shells are logged. They are dropped at main's next step after they end. Past the ceiling, main gets a `warn` log line (a toast), not a prompt.
- **"Picked up" means one of two things.** (a) The agent's first step of a new run after the shell finished. The bug doc shows a woken run absorbs the held notice (`absorbed_mid_turn`). (b) Any tool call by the agent whose args contain the shell's id or output path (Read, TaskOutput, `cat`). A step in the same busy run doesn't count: it's unknown whether a busy teammate gets the notice. So grace runs from `max(shellsDoneAt, lastActive)`, which is the busy agent's turn end. A duplicate costs less than a lost wake.
- **Grace and the ceiling only nudge rows with status `idle`** (grace) or a live status (ceiling). Messages are `liveOnly`, so `drain` drops them once the agent isn't live. Both also skip a row the engine lists as `completed`, `failed` or `killed`, or doesn't list at all (main excepted). `shellDeadlines` settles such a row's shells without a nudge. If the agent list fails, every row stays eligible.
- **Watchdog eligibility.** A row qualifies when all of these hold:
  - its id isn't `main`;
  - its mod status is `idle`;
  - the engine lists it with status `idle` (F7). That excludes finished one-shot subagents (`completed`), agents held on their own work (`waiting`), and unlisted agents;
  - its `displayStatus` is `idle`, not `waiting` (no running, idle or handing-over children);
  - it has no `shells` (open or unread);
  - `now - lastActive ≥ idleWatchdogMinutes`.

  Once per idle stretch: the nudge sets `watchdog = { t, ends: 0 }`, and each `onAgentEnd` adds one to `ends`. It is re-armed when `ends ≥ 2`: a run besides the nudge's own. Tracking a new shell also re-arms it (`addShell` clears it). In practice this targets idle teammates and background agents the engine keeps `idle`. Main is never nagged.
- **Reconciliation is in (Task B).** It's cheap: two classic registrations with no sends. At a `Stop` or `SubagentStop` whose `background_tasks` is an array, any tracked open shell whose id isn't listed is ended: the stopping agent's (main at `Stop`) at once, another agent's once it started at least 30 s before the turn end. The code comes from its file, and with no marker it is `unknown`. A missing field (an older engine) does nothing.
- **A teammate's check-in survives its turn ends (Task C).** It's small and safe: a SendMessage report still disarms it, and so does ending, now including `sync`'s `done` (R:1300 gets `...DISARMED`). A teammate ends a turn every time it waits for its children. Today that disarms main's check-in on a teammate orchestrator at its first turn end, so it can never fire. Plain subagents keep today's rule: a run end is their report (forwarded or told to main).
- **Pane display of open shells goes to the backlog.** Both pane trees (R:1847+) are large render code that every task would collide in. The activity log and `state.json` carry the information.
- **Ownership on handover goes to the backlog.** A replaced agent's open shells stay on its row and are never nudged, since it isn't `idle`.

## Order and file scopes

**Task 0 first (serial).** Then **A, B, C and D in parallel**, each in its own worktree from Task 0's commit.

| Task | Files | Regions (so merges are small) |
| --- | --- | --- |
| 0 | TY, P, C, CT, R, RT | TY `AgentRow` and new types; P userConfig and version; C appends section `// ---- background shells`; R core import block (R:7-30), `cfg` (R:100-107), new section `// ---- background shells` between `sync` (ends R:1320) and `// ---- main thread` (R:1322), cfg reads (R:1396-1401), reset (after R:1421), `$.clock.every` after R:1454, `tool.call` insert after R:1623; RT world (`fs.stat`, `reads`, `agents[].status`), helpers after `family` (RT:2316), describe at EOF |
| A | R, RT | R: `turn.step` R:1537; `noteShell` (Task 0's); `shellDeadlines`, appended at the end of the shells section; one call in `shellTick`. RT: describe at EOF (after Task 0's) |
| B | R, RT | R: `reconcileShells` just above `// ---- delivery from timers` (R:1091); two `on('classic.…')` after R:1682. RT: describe inserted before `describe('delivery from timers'` (RT:2977) |
| C | V, VT, R, RT | V: `watchdogDue` after `checkinDue` (V:616-617); R: view import block (R:31-64), `fireWatchdog` after `fireCheckins` (R:1224), `onAgentEnd` R:1268-1269, `sync` R:1288 and R:1300, plus one call after the check-in block (R:1311-1315). RT: describes inserted before `describe('auto-forward'` (RT:2526) |
| D | `README.md`, `skills/orchestrated-run/SKILL.md`, `docs/engine-bug-bg-shell-wake.md` | text only |

---

### Task 0: types, settings, pure logic, tracking and polling (foundation)

**Goal.** Track backgrounded shells per agent, drop them on TaskStop, poll their files, and record exit code and time. Ship every pure function A, B and C need.

**TY.** Add these before `AgentRow`:

```ts
/** How a background shell ended: its exit code, `killed` (TaskStop, or claude's graceful exit), or `unknown` (the engine stopped listing it and its file has no marker). */
export type ShellExit = number | 'killed' | 'unknown'
/** A Bash command an agent sent to the background, as the mod tracks it. */
export type Shell = {
  id: string            // the result's backgroundTaskId
  outputPath: string    // from the result's text; '' when it names none
  description: string
  command: string
  startedAt: number
  endedAt?: number
  exit?: ShellExit
  /** The one ceiling nudge (or main's warning) was given. */
  ceilingNudged?: true
}
```

Add to `AgentRow`:

- `shells?: Shell[]`: open shells, and finished ones not yet picked up;
- `shellsDoneAt?: number`: when its last open shell ended;
- `watchdog?: { t: number; ends: number }`: the idle watchdog's nudge, and how many turns have ended since.

**P.** Bump `version` to `0.3.8`. Add four `userConfig` entries, each `"type": "number"` with a title, a description and a default:

- `shellPollSeconds` 15 ("How often background command output files are checked for their exit; 0: never");
- `shellGraceSeconds` 60 ("An idle agent that hasn't picked up its finished background commands within this is nudged; 0: never");
- `idleWatchdogMinutes` 5 ("An idle agent with no running children or background commands this long is nudged once; 0: never");
- `shellCeilingMinutes` 60 ("A background command still running this long gets its agent one nudge; 0: never").

**C.** Append a section with these exports:

- `numberSetting(v: unknown, d: number): number`: `Number(v ?? d)` when it is finite and ≥ 0, else `d`.
- `OUTPUT_PATH = /Output is being written to: (.+?\.output)\.(?:\s|$)/`
- `backgroundedShell(res: unknown): { id: string; outputPath: string } | undefined`: undefined when `res.deny` or `res.isError` is set, when `result.backgroundTaskId` isn't a non-empty string, or when `result.backgroundEndsWithFinalResponse === true`. The path comes from `OUTPUT_PATH` on `res.text`, else `''`.
- `shellExit(text: string): number | 'killed' | undefined`: `/\n\[(?:exited with code (\d+)|killed)\]\n$/` on `text.slice(-256)`.
- `shellEndWords(exit: ShellExit): string`: `exited with code N`, `was killed` or `finished (exit code unknown)`.
- `openShells(r: AgentRow): Shell[]`: the shells with no `exit`.
- `addShell(rows, agentId, shell): AgentRow[]`: replaces any shell with the same id and clears `watchdog`. An unknown agent leaves `rows` unchanged.
- `endShell(rows, shellId, exit, t): AgentRow[]`: finds the shell in any row. Only an open one changes: it gets `endedAt = t` and `exit`. When that row has no open shell left, `shellsDoneAt = t`.
- `dropShell(rows, shellId): AgentRow[]`: removes the shell from any row, and clears `shellsDoneAt` when no finished shell remains there.
- `pickUpShells(rows, agentId, mention?: string, endedBy?: number): AgentRow[]`: drops the agent's finished shells: all of them, or with `mention` only those whose `id` or non-empty `outputPath` occurs in it. With `endedBy`, a shell that ended after it is kept. It clears `shellsDoneAt` when none remain.
- `graceDue(rows, now, graceMs): AgentRow[]`: returns `[]` when `graceMs <= 0`. Otherwise it returns rows where all of these hold:
  - the id isn't `main`;
  - the status is `idle`;
  - `shellsDoneAt` is set;
  - no shell is open, and at least one has finished;
  - `now - max(shellsDoneAt, lastActive) ≥ graceMs`.
- `shellNudge(shells: readonly Shell[]): string`. For one shell: `[orchestrator mod] your background command "<d>" (id <id>) <words> at <hh:mm> UTC and you haven't picked it up; output: <path>`. For several: `[orchestrator mod] your background commands finished and you haven't picked them up:` followed by one `- "<d>" (id …) <words> at hh:mm UTC; output: <path>` line each. `<d>` is the description, else the command cut to 80 characters. `; output: …` is left out when the path is `''`. hh:mm is `new Date(t).toISOString().slice(11, 16)`, inline: C must not import V, which imports C.
- `ceilingDue(rows, now, ceilingMs): { row: AgentRow; shell: Shell }[]`: returns `[]` when `ceilingMs <= 0`. Otherwise: open shells without `ceilingNudged` where `now - startedAt ≥ ceilingMs`, on rows whose status is `running`, `idle` or `handing-over` (main included).
- `markCeiling(rows, shellId): AgentRow[]`
- `ceilingNudge(shell, minutes): string`: `[orchestrator mod] your background command "<d>" (id <id>) is still running after N min; check it (e.g. a suspended process) or stop it (TaskStop). Output: <path>`
- `goneShells(rows, tasks: unknown): { agentId: string; shell: Shell }[]`: `[]` unless `tasks` is an array. Otherwise every open tracked shell whose id is in no entry's `id`.
- `watchdogNudge(minutes: number): string`: `[orchestrator mod] you've been idle N min with no running children or background commands; if you're waiting on something, check it; otherwise carry on or report.`

**R.**

- Import all of the above in the core block. tsc has no `noUnusedLocals`, so A, B and C add no core imports.
- Add the four keys to `cfg`, with the defaults above, read through `numberSetting(options.x, default)`.
- New section `// ---- background shells`, holding:
  - `const FULL_READ_MAX = 64 * 1024` (shipped as `FS_READ_MAX = 4 * 1024 * 1024`, lowered in review: a bigger file is checked through `tail -c 256`), `const shellSizes = new Map<string, number>()` and `let shellTicking = false`, all reset in `register()`;
  - `async function readExit($: $, path: string): Promise<number | 'killed' | undefined>`: `''` gives undefined. It calls `stat`, takes the marker from `tail -c 256` when the size is over `FULL_READ_MAX` (64 KiB), else `read`s and returns `shellExit`. Any rejection gives undefined.
  - `async function shellEnded($: $, shellId: string, exit: ShellExit)`: does nothing unless the shell is open. It applies `endShell(…, await $.clock.now())`, logs `<label>: background command "<d>" (<id>) <shellEndWords>` and persists.
  - `async function noteShell($: $, agentId: string, tool: string, args: Record<string, unknown>, res: object)`:
    - Bash with `backgroundedShell(res)`: `addShell` with `description: String(args.description ?? '')`, `command: String(args.command ?? '')` and `startedAt` now. Log `<label>: background command "<d>" (<id>) started`, then persist.
    - TaskStop with `args.task_id ?? args.shell_id` naming a tracked shell (any row), and no deny or error: `dropShell`, log `… stopped (TaskStop)`, then persist.
  - `async function shellTick($: $)`: guarded by `shellTicking`. When `cfg.shellPollSeconds > 0`, for each open shell with a path, it `stat`s the file; when the size differs from `shellSizes`, it records the size and calls `readExit`. A defined exit goes to `shellEnded`. It does nothing (no read, no write) when no row has shells. Never throws.
- In `tool.call`, after R:1623: `try { await noteShell($, e.agentId ?? 'main', e.tool, argsOf(call), res) } catch (err) { $.ui.log(\`orchestrator: shell not tracked: ${String(err)}\`) }`.
- In `session.start`, after R:1454: `$.clock.every((cfg.shellPollSeconds || 30) * 1000, () => void shellTick($))`. The tick runs even with polling off, for A's deadlines.

**RT.**

- World:
  - `on('fs.stat', …)` answers `{ kind: 'file', size: text.length, mtimeMs: 0, isLink: false }` from `w.files`, and throws ENOENT otherwise;
  - `reads: [] as string[]`, which `fs.read` pushes;
  - `w.agents` gets the type `{ id; name?; teammateId?; status?: string }[]`.
- Helpers, after `family`:
  - `TASKS = '/private/tmp/claude-501/-repo/S1/tasks'`;
  - `bgBash($, w, agentId, id, o?: { description?; command?; auto?; endsWithFinal?; isError? })`: creates the empty output file and answers the Bash call with F1's shape, using the explicit text or, with `auto`, the "did not complete within its 3s timeout" text. It restores `toolAnswer` afterwards.
  - `endOutput(w, id, code: number | 'killed')`: appends the marker.

**TDD.** Write these, watch them fail, then implement.

- CT: `numberSetting: defaults, 0 kept, negatives and junk fall back`; `backgroundedShell: explicit, auto-background, missing path, foreground, error, ends with final response`; `shellExit: 0, 137, killed, none, marker not at EOF, empty file, marker only`; `shellEndWords`; `addShell replaces by id and clears watchdog; unknown agent unchanged`; `endShell sets exit once and shellsDoneAt only when the last open ends`; `dropShell`; `pickUpShells all vs mention by id or path`; `graceDue: idle only, not main, waits on the later of shellsDoneAt and lastActive, 0 disables, none while one is open`; `shellNudge one and several, path omitted, command fallback`; `ceilingDue and markCeiling, 0 disables, done rows skipped`; `ceilingNudge`; `goneShells: non-array, listed, unlisted`; `watchdogNudge`.
- RT `describe('background shells: tracking')`:
  - `a subagent's backgrounded Bash call is tracked on its row and logged`;
  - `a command the engine moved to the background is tracked too`;
  - `main's backgrounded call is tracked on main's row`;
  - `foreground, failed and ends-with-final-response calls are not tracked`;
  - `TaskStop of a tracked shell (task_id or shell_id) drops it and logs the stop; an unknown id changes nothing`;
  - `the poll records the exit code and its time from the output file and logs it`;
  - `a killed marker is recorded as killed; no marker or a marker mid-file leaves it open`;
  - `an unchanged file is not read again` (counts `w.reads`);
  - `shellPollSeconds 0 polls nothing`, with options `{ shellPollSeconds: 0 }`;
  - `tracked shells survive in state.json` (`row(w, 'agent2').shells`).

**Acceptance.** Gates are green. `grep -n 'session.send' hooks/register.tsx` still shows only `sendOwn`.

---

### Task A: picked up, grace nudge, ceiling nudge (R, RT)

**Goal.** A finished shell the agent doesn't pick up gets one nudge after the grace period. A shell past the ceiling gets one nudge.

**R.**

- `turn.step` at R:1537: read the row before `recordStep`. Let `newRun = before && before.status` is `idle`, `done` or `respawn-failed` (the statuses `recordStep` revives). When `id === 'main' || newRun` and the row has a finished shell, apply `pickUpShells(…, id, undefined, newRun ? stepStart : undefined)` in the same `update`.
- `noteShell` (from Task 0): when the agent's row has a finished shell, apply `pickUpShells(rows, agentId, JSON.stringify(args))` and persist on a change.
- `async function shellDeadlines($: $, now: number)`, appended to the shells section:
  - For each `graceDue(rows, now, cfg.shellGraceSeconds * 1000)` row: take its finished shells, `enqueue({ agentId: r.id, text: shellNudge(finished), what: \`shell nudge for ${label(r)} not delivered\`, liveOnly: true })`, then apply `pickUpShells(rows, r.id)` so the nudge is sent once. Log `<label>: nudged about finished background command(s) <ids>`.
  - For each `ceilingDue(rows, now, cfg.shellCeilingMinutes * 60_000)` entry: `markCeiling`. Main gets `log(…, 'warn')` with `background command "<d>" (<id>) still running after N min`. Any other agent gets `enqueue(ceilingNudge(…), liveOnly)` and a log line.
  - Persist only on a change. Never throws.
- Call it at the end of `shellTick`, as `await shellDeadlines($, await $.clock.now())`, inside its own try.

**TDD.** `describe('background shells: grace and ceiling nudges')` at RT EOF. "Drained" means `complete($, undefined)` then `w.clock.settle()`.

- `an idle agent whose last shell exited is nudged once after the grace, with the code, time and output path`
- `a step that starts a new run within the grace picks it up: no nudge`
- `a busy agent's steps don't pick it up; the grace runs from its turn end`
- `a tool call naming the shell's id or output path picks it up`
- `with another shell still open, no nudge; when that one ends too, one nudge lists both`
- `a killed shell's nudge says it was killed`
- `main is never nudged; its finished shells are dropped at its next step`
- `shellGraceSeconds 0 never nudges`
- `a shell open past shellCeilingMinutes nudges its agent once` (options `{ shellCeilingMinutes: 2 }`)
- `main's shell past the ceiling is a warning toast, not a prompt`
- `shellCeilingMinutes 0 never nudges`
- `a nudge for an agent no longer live is dropped unsent` (liveOnly)

**Acceptance.** Gates are green. Every nudge goes through the outbox: test that nothing is sent before a turn end.

---

### Task B: reconcile at turn ends via `background_tasks` (R, RT)

**Goal.** A shell the engine no longer lists is ended, even when polling missed it (polling off, a file whose tail can't be read, a missing file).

**R.**

- `async function reconcileShells($: $, tasks: unknown)`, just above `// ---- delivery from timers` (R:1091). For each `goneShells(rows, tasks)` entry, call `shellEnded($, shell.id, (await readExit($, shell.outputPath)) ?? 'unknown')`. Never throws.
- After R:1682:
  - `on('classic.SubagentStop', async ($, e, next) => { const res = await next(e); try { await reconcileShells($, e.background_tasks) } catch {} return res }).catch(($, e, next) => next(e))`;
  - the same for `classic.Stop`.

  No sends here.

**TDD.** `describe('background shells: reconciled at turn ends')` before RT:2977. Use options `{ shellPollSeconds: 0 }`. A helper `subagentStop($, agentId, tasks?)` builds the input with base fields, cast `as never`.

- `a tracked shell missing from SubagentStop's background_tasks is ended with the code its file holds`
- `with no marker it is ended as unknown`
- `a shell still listed stays open`
- `main's Stop reconciles too`
- `no background_tasks field changes nothing`
- `an unreadable file still ends it as unknown, and the hook answers next's result`

**Acceptance.** Gates are green. Validate shows no new "gating hook without .catch" lines for these two registrations.

---

### Task C: idle watchdog; a teammate's check-in survives its turn ends (V, VT, R, RT)

**V.** After `checkinDue`:

```ts
/** Idle agents the watchdog nudges (see the plan's eligibility): never main, only when the engine too lists it idle. */
export const watchdogDue = (rows: readonly AgentRow[], engine: ReadonlyMap<string, string>, now: number, idleMs: number): AgentRow[]
```

It returns `[]` when `idleMs <= 0`. Otherwise every row where all of these hold:

- `r.id !== 'main'` and `r.status === 'idle'`;
- `engine.get(r.id) === 'idle'`;
- `displayStatus(r, rows) === 'idle'`;
- `!r.shells?.length`;
- `now - r.lastActive >= idleMs`;
- `(r.watchdog === undefined || r.watchdog.ends >= 2)`.

**R.**

- `sync` R:1288: keep `const listedAgents = await $.agent.list()`, `listed = new Set(ids)` and `engineStatus = new Map(listedAgents.map(a => [a.id, String(a.status)]))`.
- `sync` R:1300: `{ status: 'done', ...DISARMED }`.
- After the check-in try block (R:1311-1315): `try { await fireWatchdog($, now, engineStatus) } catch (err) { $.ui.log(…) }`.
- `async function fireWatchdog($, now, engine)` after `fireCheckins`. For each due row:
  1. patch `watchdog: { t: now, ends: 0 }`;
  2. `enqueue({ agentId, text: watchdogNudge(cfg.idleWatchdogMinutes), what: \`idle nudge for ${label(r)} not delivered\`, liveOnly: true })`;
  3. log `<label>: idle N min with nothing running: nudged`;
  4. persist.
- `onAgentEnd` R:1268-1269:
  - `{ status: 'idle', ...(r.isTeammate ? {} : DISARMED), ...(r.watchdog && { watchdog: { ...r.watchdog, ends: r.watchdog.ends + 1 } }) }`.
  - Bump `ends` in the handing-over branches too: put it in one `patch` before the branch.

**TDD.**

- VT `describe('watchdogDue')`:
  - `an idle row the engine lists idle, past idleMs, is due`;
  - `not main, not engine completed/waiting/unlisted, not with busy children, not with shells, not before idleMs`;
  - `nudged: not due until two turns have ended`;
  - `idleMs 0: none`.
- RT `describe('idle watchdog')`, before RT:2526, with `w.agents` statuses set:
  - `an idle teammate with nothing running is nudged once after idleWatchdogMinutes`;
  - `after the nudge's run ends, not again; after another run and the idle time, again`;
  - `a completed one-shot subagent, an agent waiting on children and an agent with a background shell are never nudged`;
  - `idleWatchdogMinutes 0 never nudges`.
- RT `describe('check-in on a teammate')`:
  - `main's check-in on a teammate survives its turn ends and fires`;
  - `its SendMessage to main disarms it`;
  - `sync marking it done disarms it`.

  The existing `the child's turn ending disarms it` (RT:2389) still passes unchanged.

**Acceptance.** Gates are green, and no existing check-in test was rewritten.

---

### Task D: docs (exempt from TDD)

- **README.**
  - New paragraph **Background commands.** after **Check-ins.** (README:21). It covers tracking (explicit and engine-moved), the poll, the grace nudge text, the ceiling nudge, main being tracked but never prompted, reconciliation at turn ends, and that a nudge rides the outbox like a check-in (the delay of "Some messages wait…"). Link `docs/engine-bug-bg-shell-wake.md`.
  - **Idle watchdog.** paragraph with the eligibility in plain words.
  - In **Check-ins.**: "A teammate's turn end doesn't disarm it: a teammate ends a turn whenever it waits."
  - Add the four rows to the Settings table (README:93-100).
- **SKILL.md.**
  - §2 Process step 4: background long commands freely; the mod nudges an agent its shell's notice didn't wake.
  - Check-ins bullet: a check-in on a teammate survives its turn ends.
  - §4: main may get no nudges; an `[orchestrator mod] … background command …` or `… idle …` message to an agent is the mod's.
- **docs/engine-bug-bg-shell-wake.md.** Rewrite the Workaround section in the present tense, to match the code: picked up, grace, ceiling, reconciliation.

## Deviations and open risks

- There is no `turn.start` for subagents (F5): the first step of a new run stands in.
- A busy agent whose notice was absorbed mid-run but who never named the shell gets one possibly redundant nudge.
- A file over 64 KiB is checked through `tail -c 256`. One whose tail fails, or a hard crash with no marker, is caught only by reconciliation (`unknown`) or the ceiling.
- Teammates running in their own terminal pane make no `tool.call` in this process: their shells aren't tracked.
- Reconciliation (code-review #2): a turn end ends the stopping agent's unlisted shells at once (`SubagentStop` that agent's, `Stop` main's), and another agent's only when it started at least 30 s (`RECONCILE_MARGIN_MS`) before the turn end. The session-wide `background_tasks` is a snapshot that can predate another agent's new shell, so ending a just-started one from it could end a running shell. The trade-off: another agent's shell gone at a turn end less than 30 s after it started is left to the poll or a later turn end; if the poll can't read its file (polling off, or the file is missing or unreadable) and no turn end comes, only the ceiling nudge catches it.
- Backlog: pane display of open shells; moving open shells to a replacement on handover; a duplicate grace nudge when the engine wakes an agent before the poll sees the exit, since `endedAt` is when the poll noticed it. Fix idea: take `endedAt` from the output file's stat `mtimeMs`, and record `runStartedAt` on the row.

## Manual checks (final reviewer)

- **M1.** `uv run docs/repro/bg_shell_wake.py --interactive --teammate --keep-user-settings --main-sleep 2 --idle 150`, with this checkout as the loaded plugin (user settings must load it). `RESUMED` appears within about poll + grace + 30 s. `activity.log` shows `started`, `exited with code 0` and `nudged about finished background command(s)`.
- **M2.** In a live session, a teammate runs `perl -e 'sleep 20'` with `run_in_background` and ends its turn. Expect the same lines. A `sleep` command is never auto-backgrounded.
- **M3.** A teammate left idle for 5 minutes gets one watchdog nudge, then none after its reply.
