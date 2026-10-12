# Handover fixes: respawn under auto mode, loud respawn failure, remap to the replacement, persisted activity

Date: 2026-10-12 · Branch: `handover-fixes` · Mod version now: 0.3.6 → **0.3.7** (Task 6) · Found live: desktop app, auto mode, engine 2.1.295

## Goal

1. **Respawn under auto mode.** A pane Hand over delivered HANDOVER, the note was written and the row went `replaced`, but the respawn failed: `respawn refused (The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one...)`. The mod's own `$.agent.spawn` is judged as an Agent call no request asked for. Allow exactly the mod's own spawns while they are in flight, as PR #4 did for its sends.
2. **Loud respawn failure.** Today a refused respawn is one activity line: the old row stays `replaced` with no replacement, and the parent is never told. Worse, the scripted final reply already says "The orchestrator mod has spawned the replacement…; no action needed". Tell the parent, toast and notify, show the gap in the pane and roster, and stop the reply claiming a spawn that has not happened.
3. **Remap to the replacement.** Children briefed to SendMessage the old name keep messaging it, which wakes the old agent, which then acts. Redirect such messages to the latest replacement, stop the old agent once its replacement has started, and draw the old agent's children under the replacement.
4. **Persist the activity log.** `logAtom` is in memory (200 entries). Write every line to `<run>/activity.log` (capped), and record every pane press and every refused Hand over start, so a lost press shows up.

## Baseline (run 2026-10-12 on `28d303e`, branch `handover-fixes`, clean)

| gate | result |
| --- | --- |
| `claude plugin test .` | **424 pass, 0 fail, 4 files** |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0 (re-run at the start of Task 1) |
| `claude plugin validate .` | passes (re-run at the start of Task 1) |

## Global invariants (every task)

- **TDD always, no exceptions.** Write the failing test first, run `claude plugin test .` and watch it fail for the expected reason, then implement until it passes. Pass this rule on to any sub-agent. Only README/SKILL text and the version bump are exempt.
- **Commits:** never put a Claude session link or a `Claude-Session:` trailer in a commit message or PR text (keep `Co-Authored-By`). Python scripts, if any, use PEP 723 and `uv run`.
- **Don't break existing tests.** The only tests that may be rewritten are the ones this plan names.
- **Hooks never throw.** Guard with try/catch and fall through (`return next(e)` or a harmless default). Press closures never reject unhandled.
- **Carried over:** `$` is passed only to top-level functions in `register.tsx`; no state is written while drawing; the render never awaits `$.session.messages`; every `$.state` key is declared in `PluginState`; existing keys (`agent:<id>`, `handover:<id>`, `row:<id>`, `fold:`, `copy:` …) stay. **No new `$.state` key** in this plan.
- **Every mod send still goes through `sendOwn`** (`grep -n 'session.send' hooks/register.tsx` shows only the line inside it).
- **Gates after every task:** `claude plugin test .` (count = previous + new, 0 fail), `npx -p typescript@5.6.3 tsc -p .` (exit 0), `claude plugin validate .` (passes).

## Facts (sources)

**T** is `.claude-plugin/types/claude-code/index.d.ts` (21,293 lines). **R** `hooks/register.tsx`, **RT** `hooks/register.test.ts`, **C** `hooks/core.ts`, **CT** `hooks/core.test.ts`, **V** `hooks/view.ts`, **VT** `hooks/view.test.ts`, **TY** `types/index.d.ts`.

### Spawns and checks

- **F1. `$.agent.spawn`** "runs every hook but the calling one, then the Agent tool in the background under this call's origin" (T:3174-3185). `respawn` is called from `drain` (R:893-897), inside the drain-only `turn.complete` registration (R:1399-1405), so the mod's own `agent.spawn` hook (R:1202-1241) runs on it and appends `HANDOVER_CLAUSE` (C:157-164) when `injectClause` is on. The prompt a `tool.check` for that spawn sees is therefore `replacementPrompt(brief, notePath)` (C:174-175), or that plus `HANDOVER_CLAUSE`.
- **F2. `respawn`** (R:702-759): `$.agent.spawn({ prompt, subagentType, description, model, name })` at R:709-715; `res.deny` or no id logs `respawn refused (…)` as a warn and returns (R:717-720). A throw propagates to `drain`'s `.catch`, which logs `<what>: <err>` (R:895). The parent is told through `tellParent($, old.parentId, …)` (R:752-758), which names `old.parentId`, not its `latest`.
- **F3. `tool.check`** fires "after the `tool.call` and PreToolUse hooks and before the mode settles an ask" (T:3963-3976). `ToolCheckInput = { tool, input, tool_use_id?, agentId?, ceiling? }` (T:12820-12858); "a matcher on any name the host declares for the tool admits it", so `{ tool: 'Agent' }` covers the legacy `Task` alias. PR #4's SendMessage allow is R:1359-1386 with `ownSends`/`sendOwn` (R:180, R:630-650), `isOwnSend` (R:122-137), the in-flight bound `DRAIN_TIMEOUT_MS` = 10 s (R:170).
- **F4. `AgentSpawnInput.tool_use_id`** is "the Agent tool call this spawn belongs to"; `$.agent.spawn`'s input "may leave out what the engine fills (`tool_use_id`…)" (T:264-271, T:4706-4710). RT's `spawn` helper always passes `tool_use_id: 'tu1'` (RT:219-236); the mod's `respawn` passes none.
- **F5. TaskStop** input `{ task_id?: string, shell_id?: string }`: "Agent-team teammates and named background agents are also accepted by agent ID or name" (T:16716-16721). Result `{ message, task_id, task_type, command? }` (T:21142-21151). `$.tool.call(input)` takes the tool's arguments flat beside `tool` (`ToolCallArgs`, T:12652) and raises `tool.check` with the plugin as origin (T:12836-12840), so under auto mode it needs the same allow.
- **F6. Rewriting a call.** `ToolCallInput` carries the tool's arguments spread beside the envelope, "a rewrite is checked against [the tool's] schema"; only `tool`, `tool_use_id`, `agentId` are reserved (T:12673, T:12660-12672). So `next({ ...e, to })` rewrites SendMessage's `to`, and the `tool.check` that follows judges the rewritten input (F3).
- **F7. The test world** (RT:14-213): `agent.spawn` stub (RT:130-141) is synchronous and never asks `tool.check`; `session.send` (RT:96-116) does, when `checkSends`; `autoMode` (RT:254-258) sets `checkSends`, `engine`, and an `ask` base verdict beneath the plugin. `tool.call` stub (RT:208-211) answers `toolAnswer?.(e) ?? { result: 'ok' }`. This is why "a respawn tells the parent through an allowed send" (RT:3245) passed while the real engine refused the spawn.

### Failure, status, display

- **F8. `handoverMessage`** (C:166-172) with `isRespawned` scripts "The orchestrator mod has spawned the replacement with my brief; no action needed." before any spawn is attempted. CT:230-239 asserts it contains `no action needed`.
- **F9. Status.** `AgentStatus` (TY:13). Exhaustive switches: `statusStyle` (V:114-131), `statusEmoji` (V:147-164); the terminal `glyph: Record<DisplayStatus, string>` (R:1784-1792). `LIVE` (V:13), `BUSY` (V:100), `FINISHED = ['done','replaced']` (V:620, collapse). `paneHeader` (V:16-24). `recordStep` revives only `idle`/`done` (C:51-52). `resumePrompt` lists every non-`done`, non-`replaced` agent (C:189). `rosterMarkdown` prints `r.status` (C:207-216).
- **F10. Main is woken by a submitted prompt**, as a replacement's report is: `$.clock.after(0, () => void $.prompt.submit({ text }))` (R:1022-1024, also R:965). `tellParent` appends to main (R:653-654), which does not wake it.
- **F11. Tree.** `orderRows` puts each row under `parentId` (C:127-144); `displayStatus` (V:108-111) and `childrenOf` (V:601-602) read `parentId` too. Check-ins resolve parents with `latest` (R:786, R:962), `noteReport` accepts `parentId` or `latest(parentId)` (R:821), `forwardTarget` sends to `latest(parent)` (V:599). `latest` (V:546-557) follows `replacedBy`; `namesAgent` (V:508-518) matches id, name, teammate address, ignoring a trailing ` [ref]`.
- **F12. tool.call hook** (R:1298-1355): passes `e` to `next` unchanged (R:1326); `noteReport` gets `argsOf(e)` (R:1330, R:1347).

### Activity and presses

- **F13. `log`** (R:239-243): appends `{ t, text, level }` to `logAtom`, `.slice(-200)`, and toasts a warn. `$.fs` has `read`, `write`, `exists`, `list`, no append (T:3230-3276).
- **F14. `ui.press` hook** (R:1510-1519) handles only `handover:<id>` in `PANE`; it ignores `startHandover`'s `false` (R:1514). `startHandover` (R:567-581) returns `false` silently when the row is missing or `!canHandOver(r)` (R:569), and reads the row, then awaits `runDir` and `clock.now` before writing `handing-over`: two presses in the same tick both pass the check.
- **F15. The desktop row** (R:1705-1735): `Box key="row:<id>"` holds the fold cell, the `agent:<id>` Button (Text children only), `copy:agent:<id>`, then `handover:<id>` (`onPress={() => undefined}`, the send is in the hook). The transcript is a **sibling** `Box key="transcript:<id>"` after the row Box, not a wrapper. Nothing in the row differs between selected and unselected except `bold` on the name. Transcript item keys are unique (`step-<key>` with an `nth` suffix, V:280-293, V:332).
- **F16. Redraws.** With an agent's transcript open, `peekIfSelected` (R:415-421) schedules a read on every `turn.step` and `tool.call` of that agent (R:1293, R:1352), and `refreshTranscript` writes `transcriptsAtom` on every read, changed or not (R:361-363). The pane reads that atom, so it redraws on each. A Button's `onPress` handle is held "for the drawing's life" (T:1159).

## Finding: the lost Hand over press

No cause in the mod's code is proven:

- The Hand over Button sits in the row Box, beside the transcript rather than inside it. Its key is stable, and no transcript key can collide with it (F15).
- The press is taken in the `ui.press` hook, which matches on `e.element` alone (F14).
- `$` calls don't count against a hook's budget (T:6231), so a busy mod should not make the hook overrun.

The one difference an open transcript makes is redraw rate (F16). While that agent works, the pane is redrawn on every one of its steps and tool calls. A press that lands while the desktop app swaps drawings may be dropped by the host before `ui.press` fires. That is a host-side hypothesis and cannot be tested from the mod.

One real mod defect sits nearby: two presses in one tick can both start a handover (F14), and a refused start is silent.

The fix is Task 4:
- log every press the mod receives, to `activity.log`;
- log every refused start, with its reason;
- guard `startHandover` against concurrent starts.

**Manual check M4 then decides:**
- A lost press with **no** `press handover:<id>` line in the log never reached the mod: report it to the app, with the open-transcript redraw rate as the trigger.
- A `press` line followed by `Hand over not started (…)` is the mod's, and the reason is in the log.

A follow-up could skip unchanged transcript writes to cut redraws. It is not in this plan: it is speculative until M4 shows the press never arrives.

## Order

**Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6**, serially: every task touches R and RT. (Task 1 is committed as `bc2b080`.)
- Task 2 builds on Task 1's `spawnOwn`, and on its world `spawnChecks`/`spawnDeny`.
- Task 3 builds on Task 1's `callOwn`/`ownCalls` for TaskStop, and on Task 2's `respawn-failed` status: the redirect skips it.
- Task 4 is independent in logic, but it edits `log`, `startHandover` and `ui.press` in R, so it comes after.

| Task | Files |
| --- | --- |
| 1 | `hooks/register.tsx`, `hooks/register.test.ts`, `README.md` |
| 2 | `types/index.d.ts`, `hooks/core.ts`, `hooks/core.test.ts`, `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md`, `skills/orchestrated-run/SKILL.md` |
| 3 | `hooks/core.ts`, `hooks/core.test.ts`, `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md`, `skills/orchestrated-run/SKILL.md` |
| 4 | `hooks/core.ts`, `hooks/core.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md` |
| 5 | `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md` |
| 6 | `.claude-plugin/plugin.json` (0.3.6 → 0.3.7), after 1-5 are green |

---

### Task 1: allow the mod's own spawn (and, for Task 3, stop) under auto mode (register.tsx)

**Design.**
- Next to `OwnSend` (R:113-137), exported for unit tests:
  ```ts
  /** One of the mod's own tool calls in flight, other than a send: a respawn's Agent call, or a TaskStop of a replaced agent. */
  export type OwnCall = { tool: 'Agent'; prompt: string } | { tool: 'TaskStop'; taskId: string }

  /**
   * Whether a tool.check input is one of the mod's own calls in flight: an Agent call with the exact prompt the mod
   * spawned with, or that prompt with the HANDOVER clause the mod's own agent.spawn hook appends; a TaskStop of
   * exactly the agent it is stopping. Anything malformed is not.
   */
  export const isOwnCall = (input: unknown, inFlight: readonly OwnCall[]): boolean => {
    if (typeof input !== 'object' || input === null) return false
    const i = input as { prompt?: unknown; task_id?: unknown; shell_id?: unknown }
    return inFlight.some(c =>
      c.tool === 'Agent'
        ? typeof i.prompt === 'string' && (i.prompt === c.prompt || i.prompt === c.prompt + HANDOVER_CLAUSE)
        : i.task_id === c.taskId || i.shell_id === c.taskId,
    )
  }
  ```
  - `HANDOVER_CLAUSE` is imported from `./core`.
  - No origin or `agentId` test: the prompt carries the unique note path, and TaskStop's id is exact.
- Module state after `ownSends` (R:180): `const ownCalls: OwnCall[] = []` and `let callMissLogged = false`. Reset both in `register` beside `ownSends.length = 0` (R:1162).
- One top-level helper, the same shape as `sendOwn` (R:630-650):
  ```ts
  /** Runs one of the mod's own calls, marked for tool.check while in flight (at most DRAIN_TIMEOUT_MS). */
  async function callOwn<T>($: $, mark: OwnCall, run: () => Promise<T>): Promise<T> {
    const unmark = () => { const i = ownCalls.indexOf(mark); if (i >= 0) ownCalls.splice(i, 1) }
    ownCalls.push(mark) // synchronously, before any await
    let timer: { cancel: () => void } | undefined
    try { timer = $.clock.after(DRAIN_TIMEOUT_MS, unmark) } catch { /* the mark lasts as long as the call */ }
    try { return await run() } finally { timer?.cancel(); unmark() }
  }
  ```
- `respawn` R:709: `const args = { prompt: replacementPrompt(brief, old.notePath), subagentType: …, description: …, model: …, name: … }`, then `const res = await callOwn($, { tool: 'Agent', prompt: args.prompt }, () => $.agent.spawn(args))`.
- Hooks in `register`, after the SendMessage `tool.check` (R:1386):
  ```ts
  // The mod's own respawn (Agent) and its stop of a replaced agent (TaskStop) are tool calls no request asked for;
  // under auto mode the classifier refuses them. Allow exactly those, while in flight.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => ownCallCheck($, e, next))
  on('tool.check', { tool: 'TaskStop' }, async ($, e, next) => ownCallCheck($, e, next))
  ```
  with top-level
  ```ts
  async function ownCallCheck($: $, e: ToolCheckInput, next: (e: ToolCheckInput) => Promise<ToolCheckResult>) {
    try {
      if (ownCalls.length > 0) {
        if (isOwnCall(e.input, ownCalls)) return { decision: 'allow' as const, reason: 'orchestrator mod: its own call' }
        if (!callMissLogged) {
          callMissLogged = true
          const p = (e.input as { prompt?: unknown } | null)?.prompt
          $.ui.log(`orchestrator: ${e.tool} check not matched: prompt=${typeof p === 'string' ? `${p.length} chars` : typeof p}`, { to: 'debug' })
        }
      }
    } catch { /* fall through */ }
    return next(e)
  }
  ```
  Use the engine's own exported types for `e` and `next`, as the SendMessage hook infers them. If the `next` type cannot be named, inline the body in each registration rather than widening to `any`.
  - The debug line gives a length only, never text: an unmatched real-engine prompt shape shows up there. See deviation 1.

**Test world (RT `world`):**
- New fields:
  ```ts
  /** The verdict of each mod spawn's Agent check (auto mode), in order. */
  spawnChecks: [] as string[],
  /** Runs inside the mod's spawn, after its check: `check` asks tool.check about any Agent input. */
  duringSpawn: undefined as ((check: (input: Record<string, unknown>) => Promise<string>) => Promise<unknown>) | undefined,
  /** The next spawn is refused with this reason ('' none); 'throw' makes it throw. Refused spawns are not recorded. */
  spawnDeny: '' as string,
  ```
- The `agent.spawn` stub (RT:130) becomes `async`. At its top:
  ```ts
  // Auto mode judges a spawn with no Agent tool call behind it (the mod's own; the model's carry a tool_use_id).
  if (w.checkSends && !e.tool_use_id) {
    const check = async (input: Record<string, unknown>) => (await w.engine!.tool.check({ tool: 'Agent', input } as never)).decision
    const verdict = await check({ prompt: e.prompt, description: e.description, subagent_type: e.subagentType, name: e.name, model: e.model })
    w.spawnChecks.push(verdict)
    await w.duringSpawn?.(check)
    if (verdict !== 'allow') return { deny: 'The server-side auto mode classifier gave no verdict for Agent' } as never
  }
  if (w.spawnDeny === 'throw') { w.spawnDeny = ''; throw new Error('spawn broke') }
  if (w.spawnDeny) { const deny = w.spawnDeny; w.spawnDeny = ''; return { deny } as never }
  ```
  The rest is unchanged. Write test 1 first, and check that the kit leaves `tool_use_id` empty on the plugin's `$.agent.spawn`. If the kit fills one, switch the condition to `e.tool_use_id !== 'tu1'`: `tu1` is the only id the `spawn` helper uses (F4). Note that in this plan.

**Failing tests first** (`describe("auto mode: the mod's own spawn")` in RT):
1. `a respawn under auto mode is allowed and spawned`:
   - `autoMode($, on, w)`, `start`, `spawn` impl-1, tokens 460k, `step`, `tool`, then write the note `${RUN_DIR}/handover/impl-1-agent1-1.md`, `complete($,'agent1','HANDED OVER')`, `w.clock.settle()`.
   - Expect `w.spawnChecks` equals `['allow']`, `w.spawns` has length 2, and `row(w,'agent2')!.replaces` is `'agent1'`.
   - Expect no toast containing `respawn refused`.
   - **Watch it fail first:** without the hook the verdict is `ask`, and the toast says `respawn refused (… no verdict for Agent)`.
2. `the prompt with and without the HANDOVER clause is the mod's; anything else is not` (unit, `isOwnCall` imported from `./register`). With `P = 'Do it.\n\n---\nYou replace…'` and `inFlight = [{ tool: 'Agent', prompt: P }]`:
   - true: `{ prompt: P }`, `{ prompt: P + HANDOVER_CLAUSE }`;
   - false: `{ prompt: P + ' ' }`, `{ prompt: 'other' }`, `{ prompt: 42 }`, `null`, `42`, and `{ prompt: P }` against `[]`;
   - TaskStop: `{ task_id: 'agent1' }` and `{ shell_id: 'agent1' }` against `[{ tool: 'TaskStop', taskId: 'agent1' }]` are true; `{ task_id: 'agent2' }` is false.
3. `the same spawn checked after it settled is ask`: after test 1's flow, `$.tool.check({ tool: 'Agent', input: { prompt: w.spawns[1]!.prompt } })` gives `ask`.
4. `a different prompt during the mod's spawn is ask; the mod's own is allow`:
   - `const mine = replacementPrompt({ prompt: 'P', subagentType: 'general-purpose', description: 'implement task', name: 'impl-1' }, note) + HANDOVER_CLAUSE` (both imported from `./core`; `note` is test 1's path);
   - `w.duringSpawn = async check => { probes.push(await check({ prompt: 'P' }), await check({ prompt: mine })) }`;
   - run test 1's flow; `probes` equals `['ask', 'allow']`.
5. `a spawn that never answers allows nothing past the drain timeout`: `autoMode`, set `w.duringSpawn` to capture the checked prompt, `w.hangSpawn = true`, run the flow without awaiting the `complete`, then `w.clock.advance(11_000)`. `$.tool.check({ tool: 'Agent', input: { prompt: captured } })` is `ask`.
6. `the Agent check hook never throws`: `$.tool.check({ tool: 'Agent', input: null })` and `input: { prompt: 7 }` are both `ask` (with `autoMode`'s base).
- Existing RT:3245 (`a respawn tells the parent through an allowed send`) must now also show `w.spawnChecks` equals `['allow']`: add that one assertion there. It is the test that should have caught this.

**Docs (README, after the `**HANDOVER clause.**` paragraph, R-exempt):**
> **Auto mode.** The mod's own messages, its spawn of a replacement, and its stop of a replaced agent are tool calls no request of yours asked for, so auto mode's classifier would refuse them. The mod allows exactly those calls while they are in flight (10 seconds at most), and nothing else.

**Acceptance:** all tests pass; `grep -n 'agent.spawn(' hooks/register.tsx` shows only the call inside `respawn`'s `callOwn`; gates green.

#### Decisions taken

| question | choice | rejected |
| --- | --- | --- |
| What identifies the mod's spawn | the exact prompt, bare or plus `HANDOVER_CLAUSE` | origin (also covers the model inside a mod-spawned agent, PR #4 decision 1); a prefix match |
| One mechanism for sends and calls? | a second list, `ownCalls`, beside `ownSends`; `sendOwn` is untouched | folding `sendOwn` into `callOwn`, which would churn PR #4's tested code for no gain |
| Expiry | `DRAIN_TIMEOUT_MS`, as for sends | none |

---

### Task 2: a failed respawn is loud, and the reply doesn't claim it happened

**Design.**
- **Status.** Add `'respawn-failed'` to `AgentStatus` (TY:13). Meaning: handed over, note written, no replacement carries its work. It is shown by the pane, the roster and `resumePrompt`, since that function lists every non-`done`, non-`replaced` agent (C:189). It is not `LIVE`, not `BUSY`, and not `FINISHED`, so a collapse never hides it.
  - `statusStyle('respawn-failed')` → `{ color: 'error', bold: true }`.
  - `statusEmoji('respawn-failed', id)` → `'⚠️'`.
  - Terminal `glyph['respawn-failed']` → `'✗'` (R:1784).
  - `paneHeader` appends ` · N not replaced` when N > 0, before ` · limits` (`… · 1 handed over · 1 not replaced · limits …`). With N = 0 the string is unchanged, so the existing header tests stay green.
  - `recordStep` (C:51) revives `respawn-failed` as it revives `done`: status `running`, plus `resumedAt`. A parent may message the old agent to carry on.
- **The scripted reply** (`handoverMessage`, C:170), with autoRespawn on, becomes:
  > `Then end with this final reply and nothing else: "HANDED OVER: note at ${notePath}. The orchestrator mod will spawn the replacement with my brief and tell you; no action needed unless it reports that none started."`
- **The notice** is a pure function in C, after `nameNotice`:
  ```ts
  /** Tells a parent that its child handed over but no replacement started, and how to start one itself. */
  export const respawnFailedNotice = (o: {
    label: string; id: string; notePath: string; reason: string; brief?: Brief; briefPath?: string
  }): string => {
    const head =
      `[orchestrator mod] Agent ${o.label} (id ${o.id}) handed over (note at ${o.notePath}), but no replacement started: ${o.reason}. ` +
      `Nothing is carrying its work now. Spawn the replacement yourself`
    if (!o.brief) {
      return `${head} with its original brief plus: "Start from the handover note at ${o.notePath}: read it first and continue from its next concrete step." No brief was recorded for it.`
    }
    const b = o.brief
    const opts = [
      b.name && `name "${b.name}"`,
      `subagent_type "${b.subagentType}"`,
      b.model && `model "${b.model}"`,
      `description "${b.description}"`,
    ].filter(Boolean).join(', ')
    return o.briefPath
      ? `${head}: the Agent tool with ${opts}, and as its prompt the text of ${o.briefPath} (its original brief plus the line to start from the note).`
      : `${head}: the Agent tool with ${opts}, and its original brief plus: "Start from the handover note at ${o.notePath}: read it first and continue from its next concrete step."`
  }
  ```
  - The brief file is at `briefPathFor(notePath) = notePath.replace(/\.md$/, '') + '.brief.md'` (C, exported).
- **One top-level failure path in R:**
  ```ts
  /** A respawn that did not start a replacement: marks the gap, saves the brief, and tells the parent, the person and the log. Never throws. */
  async function respawnFailed($: $, old: AgentRow, reason: string) {
    try {
      await update($, agentsAtom, l => patch(l, old.id, { status: 'respawn-failed', ...DISARMED }))
      let briefPath: string | undefined
      if (old.brief && old.notePath) {
        try {
          briefPath = briefPathFor(old.notePath)
          await $.fs.write(briefPath, replacementPrompt(old.brief, old.notePath))
        } catch { briefPath = undefined }
      }
      const rows = await read($, agentsAtom)
      const to = latest(rows, old.parentId ?? 'main')
      const text = respawnFailedNotice({ label: label(old), id: old.id, notePath: old.notePath ?? '(none)', reason, brief: old.brief, briefPath })
      await log($, `${label(old)}: no replacement started (${reason}); told ${to === 'main' ? 'main' : label(rows.find(r => r.id === to) ?? { id: to } as AgentRow)}`, 'warn')
      try { void $.ui.notify(`${label(old)} handed over, but no replacement started`, { title: 'orchestrator' }) } catch { /* the toast said it */ }
      if (to === 'main') $.clock.after(0, () => void $.prompt.submit({ text }))
      else {
        const sent = await sendOwn($, to, text)
        if (!sent.isDelivered) await log($, `${label(old)}: parent not told of the failed respawn (${sent.reason})`, 'warn')
      }
      await persist($)
    } catch (err) {
      try { $.ui.log(`orchestrator: failed respawn not reported: ${String(err)}`) } catch { /* nothing more */ }
    }
  }
  ```
- **`respawn` (R:702-720) calls it on every failure:**
  - no brief or no note: `return respawnFailed($, old, 'no brief recorded')`. This replaces the `cannot respawn` warn.
  - the spawn throws: wrap only the `callOwn(… $.agent.spawn …)` call, and `catch (err) { return respawnFailed($, old, \`spawn failed: ${String(err)}\`) }`.
  - `res.deny !== undefined || !newId`: `return respawnFailed($, old, res.deny ?? 'no agent id')`. This replaces the `respawn refused` warn.
  - A spawn still pending at the drain timeout is not a failure: the drain already warns `still running`, and a late deny lands in `respawnFailed` when it settles.
- **The parent's own replacement is linked.** In the `agent.spawn` hook (R:1202-1241), after the new row is written:
  1. find `rows.find(r => r.status === 'respawn-failed' && r.notePath && e.prompt.includes(r.notePath))`;
  2. when found, patch the old row `{ status: 'replaced', replacedBy: id }` and the new row `{ replaces: old.id }`;
  3. log `${label(old)}: ${name ?? id} (${id}) takes over from its note`.
  - Inside the hook's existing try path. Task 3 adds the re-parent and stop here too.

**Failing tests first.**
- CT, `describe('handoverMessage')`: rename the first test to `tells the agent the mod will spawn its replacement, without claiming it has`. Keep its assertions, and add `toContain('will spawn the replacement')` and `not.toContain('has spawned')`.
- CT, `describe('respawnFailedNotice')`:
  1. `names the note, the brief file and how to spawn`: with a brief `{ prompt:'P', subagentType:'general-purpose', description:'impl', model:'opus', name:'impl-2' }` and `briefPath: '/r/h/impl-2-agent2-1.brief.md'`, the text contains `no replacement started: nope`, `note at /n.md`, `name "impl-2"`, `subagent_type "general-purpose"`, `model "opus"` and `/r/h/impl-2-agent2-1.brief.md`.
  2. `with no brief file, it quotes the start line`: no `briefPath`; contains `Start from the handover note at /n.md`.
  3. `with no brief, it says so`: contains `No brief was recorded`.
  4. `briefPathFor`: `/r/h/x-1.md` → `/r/h/x-1.brief.md`.
- CT, `recordStep`: `a step revives a respawn-failed row as running, marked resumed`.
- VT:
  - `statusStyle('respawn-failed')` equals `{ color: 'error', bold: true }`;
  - `statusEmoji('respawn-failed','x')` is `⚠️`;
  - `paneHeader` with one `respawn-failed` row contains `· 1 not replaced ·`, and with none has no `not replaced`;
  - `collapseHidden` never hides a `respawn-failed` descendant.
- RT, `describe('a respawn that fails')`:
  1. `a refused respawn marks the gap and tells the parent agent how to respawn`:
     - setup: `family`, `w.spawnDeny = 'nope'`, agent2 at 460k, `step`, `tool`, note `${RUN_DIR}/handover/impl-2-agent2-1.md`, `complete($,'agent2','HANDED OVER')`, `settle`;
     - `row(w,'agent2')!.status` is `respawn-failed`;
     - one `w.sent` to agent1 contains `no replacement started: nope`, the note path, `name "impl-2"` and `.brief.md`;
     - `w.files.get(\`${RUN_DIR}/handover/impl-2-agent2-1.brief.md\`)` starts with `P2` and contains the note path;
     - a toast contains `no replacement started`.
     - **Fails today:** status `replaced`, no message.
  2. `main's child: the failure is submitted to main as a prompt`: `running`, `w.spawnDeny = 'nope'`, hand agent1 over as above, `settle`. `w.prompts` has one entry containing `no replacement started` and `agent1`, and `w.sent` has no message with it.
  3. `a spawn that throws is a failed respawn`: `w.spawnDeny = 'throw'`; the status is `respawn-failed`, and the parent's message contains `spawn failed: Error: spawn broke`.
  4. `an agent with no brief is a failed respawn`:
     - setup: `start`, `w.agents = [{ id: 'agent9', name: 'x' }]`, tokens 460k, `step($,'agent9')` (adopted, no brief), `tool`, write the note `${RUN_DIR}/handover/x-agent9-1.md`, `complete`, `settle`;
     - status `respawn-failed`; `w.prompts` contains `No brief was recorded`.
  5. `the gap shows in both panes and the roster`: after test 1's flow:
     - desktop: `rowText` of `row:agent2` contains `⚠️` and `respawn-failed`;
     - terminal: it contains `✗`;
     - `$.command.run({ command:'orch', args:'roster' })` text contains `| respawn-failed |`.
  6. `the parent's own spawn from the brief file is linked as the replacement`: after test 1's flow, `spawn($, { prompt: w.files.get(briefPath)!, name: 'impl-2', parentAgentId: 'agent1' })`. `row(w,'agent2')` has `{ status: 'replaced', replacedBy: 'agent3' }`, and `row(w,'agent3')!.replaces` is `'agent2'`. (A refused spawn is not recorded, so the next id is `agent3`.)
  7. `the scripted reply no longer claims the spawn`: `tool($,'agent1')` after crossing gives a `context` whose HANDOVER contains `will spawn the replacement`.
  8. `under auto mode with the allow in place, a respawn is not reported as failed`: Task 1's test 1 flow; no toast or prompt contains `no replacement started`.

**Docs.**
- README:16, after the `stalled` sentence:
  > If the replacement can't be started (the engine refuses the spawn, or no brief was recorded), the old agent is marked `respawn-failed`. Its parent is told that nothing is carrying the work, with the note path, the brief's name, type and model, and a file holding the full replacement prompt (`handover/<…>.brief.md`). An agent parent gets a message, and main gets a prompt that wakes it. You get a toast and a notification. When the parent spawns an agent whose prompt names that note, the mod links it as the replacement.
- README:13: replace "The note says no action is needed, so the parent doesn't spawn a second replacement." with "The note says no action is needed, so the parent doesn't spawn a second replacement. The agent's own final reply says the mod *will* spawn it, and that the parent should act only if the mod reports that none started."
- README:41 (terminal glyphs): add `respawn failed \`✗\` red`. README:50 (desktop emoji): add `respawn failed ⚠️`.
- SKILL.md:64: after "**don't spawn a replacement**", add: "unless the notice says `no replacement started`: then spawn one as it says (same name, type and model, the brief file as the prompt), and record the new name and id".
- SKILL.md:61: add a line 5, "If the spawn fails: `[orchestrator mod] Agent <name> … handed over …, but no replacement started: <reason>. … Spawn the replacement yourself …`".

**Acceptance:** all tests pass; `grep -n "respawn refused\|cannot respawn" hooks/` is empty; validate lists no new state key; gates green.

#### Decisions taken

| question | choice | rejected |
| --- | --- | --- |
| Status word | `respawn-failed` (`✗` red / `⚠️`) | `orphaned` (unclear); reusing `stalled` (means "hasn't handed over"); keeping `replaced` with a flag (the pane shows status) |
| How the parent gets the brief | a `.brief.md` file beside the note, named in the notice | the whole brief inline (it can be long and would flood a parent's context) |
| Main's notice | submitted prompt + toast + `ui.notify` | `session.append`, which doesn't wake main (F10) |
| Recipient | `latest(parentId)`: a replaced parent's replacement | `old.parentId` as is |
| Link a manual replacement | yes, by its prompt naming the note path | leaving the gap row forever |
| A pending spawn at the drain timeout | not a failure (it may still land); a late deny is reported then | marking it failed at the timeout |

---

### Task 3: redirect messages to the replacement, stop the old agent, adopt its children

**Design.**
- **Pure in V, after `latest`:**
  ```ts
  /**
   * The agent a SendMessage `to` should reach when it names a replaced agent: the newest row `to` names
   * (by id, name or teammate address, as namesAgent does) that is `replaced` with a `replacedBy`, followed
   * to its `latest`. Undefined, so the message goes as addressed, when `to` also names a live agent (the
   * engine routes a name to its live holder), when nothing replaced matches, or when the sender is that
   * replacement itself.
   */
  export const redirectTarget = (rows: readonly AgentRow[], to: unknown, sender?: string): AgentRow | undefined => {
    if (typeof to !== 'string') return undefined
    if (rows.some(r => LIVE.includes(r.status) && namesAgent(to, r))) return undefined
    const old = rows.filter(r => r.status === 'replaced' && r.replacedBy !== undefined && namesAgent(to, r))
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!old) return undefined
    const dest = rows.find(r => r.id === latest(rows, old.id))
    if (!dest || dest.id === old.id || dest.id === sender) return undefined
    return dest
  }
  /** How to address `dest` in place of `to`: its teammate address when `to` was one, else its registered name, else its id. */
  export const addressFor = (dest: AgentRow, to: string): string =>
    to.includes('@') && dest.teammateId ? dest.teammateId : (dest.name ?? dest.id)
  ```
- **Pure in C:**
  ```ts
  /** The old agent's children now hang under its replacement (display, waiting, collapse and check-ins follow parentId). */
  export const adoptChildren = (rows: AgentRow[], oldId: string, newId: string): AgentRow[] =>
    rows.map(r => (r.parentId === oldId && r.id !== newId ? { ...r, parentId: newId } : r))
  ```
- **The tool.call hook (R:1298-1355).** Before the stamp block, for `e.tool === 'SendMessage'`:
  ```ts
  let call = e
  let redirected: string | undefined
  if (e.tool === 'SendMessage') {
    try {
      const to = (e as { to?: unknown }).to
      const dest = redirectTarget(await read($, agentsAtom), to, e.agentId)
      if (dest && typeof to === 'string') {
        const addr = addressFor(dest, to)
        call = { ...e, to: addr } as typeof e
        redirected = `[orchestrator mod] ${to} was replaced by ${addr} (id ${dest.id}); this message went to ${addr}. Use that name from now on.`
        await log($, `SendMessage to ${to} from ${e.agentId ?? 'main'} redirected to ${addr} (${dest.id}): ${to} was replaced`)
      }
    } catch (err) { $.ui.log(`orchestrator: SendMessage not redirected: ${String(err)}`) }
  }
  ```
  - `next(call)` replaces `next(e)` (R:1326).
  - Both `noteReport` calls take `argsOf(call)` (R:1330, R:1347), so a child's report to its parent's old name still counts as a report to the replacement.
  - When `redirected` is set and the result has no `deny`, append it to `out.context`, as the HANDOVER is (R:1340). Do this for main and for agents alike, since main's tool.call also comes through here.
  - The early `if (e.agentId === undefined) return res` (R:1327) moves below the context append.
- **`tellParent` gets the latest parent.** `respawn` passes `latest(await read($, agentsAtom), old.parentId ?? 'main')` (R:752-754), so the mod's own notice never addresses a replaced parent.
  - Every other mod send already targets a live row or a `latest`: the HANDOVER (a `handing-over` row), check-ins (R:962), forwards (V:599), and name notices (live-only).
- **Stop the old agent.** Top-level:
  ```ts
  /** Stops a replaced agent once its replacement has started, so a late message can't wake it to act. Logged, never thrown. */
  async function stopReplaced($: $, old: AgentRow) {
    try {
      const res = await callOwn($, { tool: 'TaskStop', taskId: old.id }, () =>
        $.tool.call({ tool: 'TaskStop', task_id: old.id }),
      )
      const bad = res.deny ?? ((res as { isError?: boolean }).isError ? String((res as { text?: unknown }).text ?? 'error') : undefined)
      await log($, bad === undefined ? `${label(old)} (${old.id}) stopped` : `${label(old)} (${old.id}) not stopped (${bad})`)
    } catch (err) {
      await log($, `${label(old)} (${old.id}) not stopped (${String(err)})`).catch(() => undefined)
    }
  }
  ```
- **One link helper, used by `respawn` and Task 2's manual link:**
  ```ts
  /** Links a replacement: the old row points at it, its children move under it, and the old agent is stopped. */
  async function linkReplacement($: $, old: AgentRow, newId: string) {
    await update($, agentsAtom, l => adoptChildren(l, old.id, newId))
    await stopReplaced($, old)
  }
  ```
  - In `respawn`, call `linkReplacement($, old, newId)` after its row update (R:726-749), before `tellParent`. Also make `respawn`'s update use `adoptChildren` in the same `update` if that is simpler. Either way, `replacedBy`, `replaces` and the re-parent land before the first `persist`.
  - In the `agent.spawn` hook's manual link (Task 2), call it after the patch.
  - The stop is awaited inside the drain, which bounds it by `DRAIN_TIMEOUT_MS` (R:918-930). Its allow expires with it (Task 1).
- **The hook for TaskStop's check** is already registered in Task 1.

**Test world (RT `world`):** new fields `stops: [] as string[]`, `stopChecks: [] as string[]`, `stopFails: '' as '' | 'throw' | string`. At the top of the `tool.call` stub (RT:208):
```ts
if (e.tool === 'TaskStop') {
  const id = String((e as { task_id?: unknown }).task_id)
  if (w.checkSends) {
    const verdict = (await w.engine!.tool.check({ tool: 'TaskStop', input: { task_id: id } } as never)).decision
    w.stopChecks.push(verdict)
    if (verdict !== 'allow') return { deny: 'The server-side auto mode classifier gave no verdict for TaskStop' } as never
  }
  if (w.stopFails === 'throw') throw new Error('stop broke')
  if (w.stopFails) return { deny: w.stopFails } as never
  w.stops.push(id)
  return { result: { message: 'stopped', task_id: id, task_type: 'local_agent' } } as never
}
```

**Failing tests first.**
- VT, `describe('redirectTarget')`. Fixture: r1 `{ id:'a1', name:'probe', status:'replaced', replacedBy:'a2', startedAt:1 }`, r2 `{ id:'a2', name:'probe-2', status:'running', startedAt:2 }`.
  1. `'probe'`, `'a1'` and `'probe [ref]'` give r2.
  2. A chain a1→a2→a3, with a2 `replaced`, gives a3 for `'probe'`.
  3. A live row also named `probe` gives undefined.
  4. Sender `'a2'` gives undefined.
  5. A `respawn-failed` a1 with no `replacedBy` gives undefined. So do a non-string `to` and `'nobody'`.
  6. `addressFor`: `addressFor(r2, 'probe')` is `'probe-2'`; with `teammateId: 'probe-2@team'`, `addressFor(r2, 'probe@team')` is `'probe-2@team'`; with no name, it is the id.
- CT: `adoptChildren moves only the old agent's children and never the replacement itself`.
- RT, `describe('after a handover, the replacement takes over')`. Helper `swap`:
  - `family`, `w.agents.push({ id: 'agent3', name: 'impl-1-2' })`;
  - agent1 at 460k, `step`, `tool`, note `${RUN_DIR}/handover/impl-1-agent1-1.md`, `complete($,'agent1','HANDED OVER')`, `settle`;
  - agent3 is impl-1's replacement, registered `impl-1-2`.

  Tests:
  1. `a child's SendMessage to its replaced parent goes to the replacement, and the child is told`:
     - `swap`; `w.toolAnswer = e => { if (e.tool === 'SendMessage') seen.push(String(e.to)) }`;
     - `const res = await call($, 'agent2', 'SendMessage', { to: 'impl-1', message: 'R: green' })`;
     - `seen` equals `['impl-1-2']`, and `(res as any).context` has one entry containing `impl-1 was replaced by impl-1-2`;
     - the activity log has `redirected to impl-1-2`.
     - **Fails today:** `seen` is `['impl-1']`.
  2. `by id too`: `to: 'agent1'` is delivered as `impl-1-2`.
  3. `the redirected report counts as the child's report`: `call($,'agent3','mcp__orchestrator__checkin',{ agent:'impl-2', minutes: 30 })`, then test 1's send. `row(w,'agent2')!.checkinAt` is undefined and `.report?.ok` is true.
  4. `a chain goes to the newest replacement`:
     - `swap`, then hand agent3 over the same way (`w.agents.push({ id:'agent4', name:'impl-1-3' })`, note `${RUN_DIR}/handover/impl-1-2-agent3-1.md`);
     - `to: 'impl-1'` is delivered as `impl-1-3`.
  5. `left as addressed`:
     - a send to live `impl-2`;
     - a send from agent3 to `impl-1`;
     - after a refused respawn (`w.spawnDeny = 'nope'`), a send to `impl-1`, the row being `respawn-failed`.
     - In all three, `seen` holds the original `to`, and no context is added.
  6. `main's SendMessage is redirected too`: `call($, undefined, 'SendMessage', { to: 'impl-1', message: 'x' })` is delivered as `impl-1-2`.
  7. `the old agent is stopped once its replacement started`: after `swap`, `w.stops` equals `['agent1']` and the log has `impl-1 (agent1) stopped`.
  8. `a failed stop is logged and the swap still completes`:
     - with `w.stopFails = 'not running'`: the log has `not stopped (not running)`, `row(w,'agent3')!.replaces` is `'agent1'`, `row(w,'agent2')!.parentId` is `'agent3'`, and the log still has `impl-1 replaced by agent3`;
     - again with `'throw'`: the log has `not stopped (Error: stop broke)`, and nothing throws.
  9. `under auto mode the stop is allowed, and only while in flight`:
     - `autoMode` then `swap`: `w.stopChecks` equals `['allow']` and `w.stops` equals `['agent1']`;
     - afterwards, `$.tool.check({ tool:'TaskStop', input:{ task_id:'agent1' } })` is `ask`, and so is `input: 42`.
  10. `the old agent's children show under the replacement`:
      - after `swap`, `row(w,'agent2')!.parentId` is `'agent3'`;
      - desktop pane: `row:agent2` comes after `row:agent3` in `findAll` order, and has `paddingLeft` 2;
      - with agent3 idle (`complete($,'agent3')`) and agent2 running, agent3's row text contains `waiting`.
  11. `a parent replaced earlier is the one told of its child's swap`:
      - `swap`, then hand agent2 over (note `${RUN_DIR}/handover/impl-2-agent2-1.md`);
      - the `handed over` notice goes to agent3, and none goes to agent1.
  12. `a manual replacement after a failed respawn is linked, adopts the children and stops the old agent`:
      - Task 2's test 6 flow, with a child spawned under agent2 first;
      - the child's `parentId` becomes the new id, and `w.stops` contains `'agent2'`.
- The existing check-in tests RT:2305-2350 and forward tests RT:2480-2500 must stay green unchanged.

**Docs.**
- README:13, new step after 3:
  > Once the replacement has started, the mod stops the old agent (TaskStop), and moves its children under the replacement in the pane, the roster and check-ins. A SendMessage that still names the old agent, by name or id, from any agent or main, is sent to the newest replacement instead, and the sender reads `[orchestrator mod] <old> was replaced by <new> …; use that name from now on.` A name a live agent holds is never redirected, and a replacement messaging its predecessor goes as addressed.
- SKILL.md:64: "Messages sent to the old name are redirected to the replacement, and the sender is told the new name. Use the new name anyway."

**Acceptance:** all tests pass; gates green; `grep -n "next(e)" hooks/register.tsx` in the tool.call hook shows `next(call)`.

#### Decisions taken

| question | choice | rejected |
| --- | --- | --- |
| Which `to` is redirected | one naming a `replaced` row with `replacedBy`, by id, name or teammate address, unless a live row has that name | a name match on `brief.name` (would steal a fresh agent's requested name) |
| Rewrite to | the replacement's teammate address when `to` was one, else its registered name, else its id | always the id (a teammate is addressed by name, T:11514-11521) |
| Tell the sender | yes, as tool-result context | silent (children keep the stale name forever) |
| Children in the tree | re-parent the rows (`parentId` → replacement) | display-only mapping, which would need `orderRows`, `displayStatus`, `childrenOf` and collapse all taught it |
| Stop timing | right after the replacement's row is linked, inside the drain | before the spawn (leaves nobody if the spawn fails) |
| Failed stop | an info line in the log | a warn toast (TaskStop on a finished subagent may refuse routinely, deviation 2) |

---

### Task 4: activity log to the run folder; presses and refused starts recorded

**Design.**
- **Pure in C:**
  ```ts
  /** The most lines activity.log keeps; the oldest go first. */
  export const ACTIVITY_MAX = 2000
  /** One activity.log line: UTC ISO time, level, the text on one line. */
  export const activityLine = (t: number, level: 'info' | 'warn', text: string): string =>
    `${new Date(t).toISOString()} ${level === 'warn' ? 'WARN' : 'info'} ${text.replace(/\r?\n/g, ' ⏎ ')}`
  ```
- **In R, module state:** `let activity: string[] | undefined` (loaded lazily) and `let activityChain: Promise<void> = Promise.resolve()`. Reset both in `register`.
- **One top-level writer:**
  ```ts
  /** Appends a line to <run>/activity.log, keeping the last ACTIVITY_MAX (earlier lines read back once per load). Never throws. */
  async function writeActivity($: $, line: string) {
    const run = activityChain.then(async () => {
      try {
        const path = `${await runDir($)}/activity.log`
        if (activity === undefined) {
          activity = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
        }
        activity.push(line)
        activity.splice(0, Math.max(0, activity.length - ACTIVITY_MAX))
        await $.fs.write(path, `${activity.join('\n')}\n`)
      } catch (err) {
        try { $.ui.log(`orchestrator: activity.log not written: ${String(err)}`, { to: 'debug' }) } catch { /* nothing more */ }
      }
    })
    activityChain = run
    return run
  }
  ```
  - `log` (R:239-243) awaits `writeActivity($, activityLine(t, lvl, text))` after the atom update, then toasts as before.
  - `trace($, text)` = `writeActivity($, activityLine(await $.clock.now(), 'info', text))`, wrapped in try/catch. It writes to the file only, not to the pane.
- **Presses.** At the top of the `ui.press` hook (R:1510), for `e.plugin === 'orchestrator'` (any `requestId`):
  - `await trace($, \`press ${e.element} (${e.surface}, ${e.requestId})\`)` in a try;
  - then the existing logic.
  - Every Button's press raises `ui.press`, closure-pressed ones included (T:4001-4006), so row, fold, copy, tool and Close presses are all recorded.
- **Refused starts.** In `startHandover` (R:567-581):
  - Module `const handoverStarting = new Set<string>()`, reset in `register`.
  - First line, synchronous: `if (handoverStarting.has(id)) { await log($, \`${id}: Hand over not started (already starting; ${why})\`); return false }`, then `handoverStarting.add(id)`. Wrap the rest in `try { … } finally { handoverStarting.delete(id) }`.
  - On `!r`: `await log($, \`${id}: Hand over not started (no such agent; ${why})\`)`.
  - On `!canHandOver(r)`: `await log($, \`${label(r)}: Hand over not started (status ${r.status}; ${why})\`)`.
  - Both are info, not warn: the pane already hides the button for these.
  - `deliverHandover`'s silent early return (R:604): log `${label(r)}: HANDOVER not sent (status ${r?.status ?? 'gone'}${r?.handoverVia ? \`, already via ${r.handoverVia}\` : ''})`.

**Failing tests first.**
- CT, `activityLine`:
  - `activityLine(Date.UTC(2026,9,12,10,0,0), 'warn', 'a\nb')` is `2026-10-12T10:00:00.000Z WARN a ⏎ b`;
  - the info level prints `info`.
- RT, `describe('activity.log')` (`const ACT = \`${RUN_DIR}/activity.log\``):
  1. `every activity line is written to the run folder`: `running`; `w.files.get(ACT)` contains `info spawned impl-1 (agent1)`.
     - **Fails today:** the file is undefined.
  2. `a warn is marked WARN`: Task 2's test 1 flow (`w.spawnDeny = 'nope'`); the file has a `WARN` line containing `no replacement started (nope)`.
  3. `the file keeps the last ACTIVITY_MAX lines, earlier lines read back after a reload`:
     - before `start`, `w.files.set(ACT, Array.from({ length: ACTIVITY_MAX }, (_, i) => \`old ${i}\`).join('\n') + '\n')`;
     - then `running`. The file has `ACTIVITY_MAX` lines; the first is `old 1`, and the last contains `spawned impl-1`.
  4. `a pane press is recorded in the file, not the pane`:
     - mount desktop, `ui.press({ key: 'agent:agent1' })`;
     - the file contains `press agent:agent1 (desktop, orchestrator)`;
     - the drawn activity (`rowText`/`findAll` texts) contains no `press agent:`.
  5. `two Hand over presses at once start one handover, and the second says why`:
     - `running`, mount desktop, `Promise.all([ui.press({ key:'handover:agent1' }), ui.press({ key:'handover:agent1' })])`;
     - `row(w,'agent1')!.handovers` is 1;
     - the file has two `press handover:agent1 (desktop` lines, one `Hand over not started (` line, and exactly one `HANDOVER goes with its next tool result` line.
     - **Fails today:** there is no file. Without the guard, both presses can pass `canHandOver` and log two `HANDOVER goes with` lines.
  6. `a failing write never breaks logging`:
     - add `fsFails: ''` to the world (a path whose `fs.write` throws), checked first in the `fs.write` stub;
     - with `w.fsFails = ACT`, `running` still records the row (`row(w,'agent1')` is defined), and `w.logSinks` has a `debug` line containing `activity.log not written`.
  - The "status not live" refusal branch is reached only through a stale button, which the kit redraws away. It is covered by code review and M4, not by a test.

**Docs.** README:68 (**Records.**):
- after `handover/*.md`, add:
  > , and `activity.log`: every activity line with its UTC time and level, plus every press on the mod's panes (element, surface) and every Hand over that could not start, with the reason. It keeps the last 2,000 lines and survives a reload.
- add one sentence:
  > If a Hand over press seems lost, look there: no `press handover:<id>` line means the press never reached the mod.

**Acceptance:** all tests pass; gates green; validate lists no new state key.

#### Decisions taken

| question | choice | rejected |
| --- | --- | --- |
| File format | one plain line per entry: `ISO LEVEL text`, newlines as ` ⏎ ` | JSONL (harder to read by eye; nothing parses it) |
| Cap | 2,000 lines, rewritten whole (no `fs.append`, F13) | uncapped |
| Presses in the pane's Activity | no: file only (`trace`) | in the pane, where a row click would add a line and a redraw |
| Refusals | info lines in the pane and the file | warn toasts (the button is usually gone already) |
| Concurrent starts | a synchronous per-id guard in `startHandover` | none (two same-tick presses both start, F14) |
| Lost-press hardening (skip unchanged transcript writes) | not in this plan; decided after M4 | doing it now on a hypothesis |

---

### Task 5: terminal pane: full text expands in flow, no hover cards (view.ts, register.tsx)

**Problem (R as of `bc2b080`; line numbers move with Tasks 2-4).**

The transcript's full-text card:
- **Where it is.** R:1911-1938. It is an absolute Box with `top={1}`, `left={-1}`, `width={cols}`, and `hover={{ display: 'flex' }}` unless pinned.
- **It blocks clicks.** It opens downward over the transcript rows beneath the hovered line. Because the card is part of the hovered area, it stays open while the pointer moves onto those rows, so their `tool:` Buttons can't be clicked.
- **Its height comes from the wrong number.** Its line cap `fit = room` (R:1915) is the *activity* line count (R:1942). That is not the space below the line. The card is also `lines + 2` tall (its border), and the rest of the transcript box, the axis line and the `Activity` header sit between it and the activity. So it runs past the pane's bottom and overprints the axis and the header (the `03:0200:29code` and `Activitylf:` residue).

The activity card has the same faults:
- **Where it is.** R:2040-2065. It opens upward with `top={-(wrapped.length + 2)}`.
- **It isn't capped at all.** A long line, such as Task 3's redirect line or Task 2's failure line, draws above the pane's top.
- **It also blocks clicks.** It covers the lines and tree rows above it while hovered.

**Decision: no hover cards on the terminal.**
- A press on a cut line toggles an **in-flow** expansion directly beneath it, as the desktop pane does (R:1662-1675, R:1753-1767). This applies to both transcript text items and activity lines.
- One expansion at a time, through the existing `pinnedAtom`. The same press keys stay: `step-<agentId>-…` and `log-…`.
- The expansion is a bordered `Box key="full:<id>"` in flow, never `position="absolute"`. It pushes the rows beneath it down, so it can never cover them.
- Its lines are capped from the pane's real row budget, and the activity gives up exactly the rows the expansion takes. So nothing draws outside the pane.
- Rejected: a card placed where it can't overlap the rows below. A terminal pane has no free space beside or above the line that is reliably large enough. Any absolute card still covers some rows, and it needs geometry the render doesn't have (the hovered line's own row).

**Pure helpers (V; R can't be avoided: the drawing lives there):**
```ts
/** The terminal pane's rows left for an open expansion and the activity: viewport rows less the agent rows, the open transcript box and the frame (header, axis line, `Activity`, slack). */
export const terminalBase = (o: { rows: number; agents: number; peekRows: number; buttonRow: boolean }): number =>
  o.rows - o.agents - 8 - (o.buttonRow ? 1 : 0) - o.peekRows
/** The most text lines an expansion may show: it and its border leave the activity at least 3 lines. */
export const expandCap = (base: number): number => Math.max(1, base - 3 - 2)
/** At most `max` lines; when cut, the last kept line is `…`. */
export const capLines = (lines: readonly string[], max: number): string[] =>
  lines.length <= max ? [...lines] : [...lines.slice(0, Math.max(0, max - 1)), '…']
```
- In R, `room` is today's formula (R:1942). Keep it identical when nothing is expanded, so the RT:1450-1470 `crowded` tests stay green.

**Wiring (R, terminal branch only; the desktop is untouched):**
1. `const base = terminalBase({ rows: e.viewport?.rows ?? 30, agents: ordered.length, peekRows, buttonRow: shown })`. Compute it before `item` is defined: move the `room` line above `item`, since `room` is read inside `item` today.
2. **Transcript text item** with `full`, replacing R:1911-1938:
   ```tsx
   const inner = Math.max(10, cols - 8) // transcript box border (2) + expansion border (2) + its padding spaces (2) + slack
   const lines = capLines(wrapFill(it.full, inner), expandCap(base))
   return (
     <Box key={it.id} flexDirection="column">
       <Button key={pin} plain onPress={() => togglePinned($, pin)}>{time}{who}<Text>{it.short}</Text></Button>
       {pinned === pin && (
         <Box key={`full:${pin}`} borderStyle="round" flexDirection="column" width={cols - 2}>
           {lines.map((w, j) => <Text key={`w${j}`} wrap="truncate">{` ${w}`}</Text>)}
         </Box>
       )}
     </Box>
   )
   ```
3. **Activity line**, replacing R:2045-2065: the same shape. Use `key={\`l${i}\`}` on the column Box, the `log-…` Button, and `full:<logId>` with `width={cols}`, `inner = Math.max(10, cols - 6)`, and `color` on its Texts.
4. **The expansion's rows come off the activity:**
   - `expRows` is the pinned expansion's `lines.length + 2`, when the pinned id is a visible transcript text item with `full`, or an entry among `entries.slice(-Math.max(3, base))` that is cut (`text.length > cols - 6`). Otherwise it is 0.
   - Compute it before drawing, from the same `transcriptView` items and entries.
   - Then `room = Math.max(3, base - expRows)`.
   - If the pinned activity entry falls outside `entries.slice(-room)` once `room` shrinks, it is not drawn. Its `expRows` still counts, which keeps the arithmetic one-pass, and the pane only shows fewer lines.
5. Remove `position="absolute"` and `hover` from the terminal branch entirely. Afterwards, `grep -n 'position="absolute"\|hover=' hooks/register.tsx` returns nothing.
6. Update the comments at R:1879, R:1912-1913 and R:2040-2042 to say "a press shows the full text beneath it, in flow".

**Failing tests first.**
- VT, `describe('terminal budget')`:
  1. `terminalBase({ rows: 30, agents: 2, peekRows: 5, buttonRow: true })` is `14`.
  2. `expandCap(14)` is `9`; `expandCap(4)` is `1`.
  3. `capLines(['a','b'], 3)` is `['a','b']`; `capLines(['a','b','c','d'], 3)` is `['a','b','…']`; `capLines(['a','b'], 1)` is `['…']`.
- RT. These are rewrites of three existing tests, and the plan names them.
  - **RT:644** `a truncated activity line shows its full text in a card on hover, pinned by a click` → `terminal: a truncated activity line expands in flow beneath it on a press; no card covers other lines`. Same setup (cols 40, the long agent name). Then:
    - no drawn node has `props.position === 'absolute'`, and none has a `hover` key;
    - `full:<line.key>` is absent;
    - press the line: `full:<line.key>` exists, is the next sibling of the line's Button inside the same column Box, and its text contains `will-not-fit`;
    - the number of drawn activity lines (Texts and Buttons after the `Activity` Text) dropped by `full`'s line count plus 2, but not below 3;
    - press again: `full:` is gone, and the count is restored.
  - **RT:1731** `terminal: a long text is cut, and its card shows on hover, pinned by a press` → `terminal: a long transcript text expands in flow on a press, and no card covers the rows beneath`, with `longStub`, cols 80:
    - before the press, no absolute Box and no `hover`;
    - press `button.key`: `full:<button.key>` exists, holds `END`, and is not absolute;
    - press again: it is gone.
  - **RT:1751** `terminal: a long text card opens downward inside the border, its lines capped to the room` → `terminal: an expansion never outgrows the pane` (HUGE text, cols 40, default 30 rows):
    - press it;
    - `full:`'s Text lines number at most `expandCap(terminalBase({ rows: 30, agents: 2, peekRows, buttonRow: true }))`, where `peekRows` is the transcript box's item count + 2;
    - the last line is `…`, and `END` is absent;
    - the whole drawn pane's line count (header + agent rows + transcript box with its expansion + axis + `Activity` + activity lines) is at most 30.
  - New: `terminal: with a text expanded, the tool call beneath it still presses to its detail`:
    - stub `session.messages` with `[brief, { role: 'assistant', text: long, toolUses: [] }, <a Bash tool use and its result>]`, the shape the `tool detail` suite (RT:1774) uses;
    - open agent1's transcript and press the text: `full:` is drawn;
    - press `tool:agent1:<id>`: `w.opened` contains `orchestrator-tool`, and `full:` is still drawn.
  - New: `desktop is unchanged`. The existing desktop tests (RT:1738, RT:925) stay green unchanged; no new test is needed.
- **Watch them fail first:** today the tree holds absolute Boxes with `hover`, and no `full:` key on the terminal.

**Docs (README, terminal bullets):**
- README:43:
  > click a subagent's name to show its transcript in a box beneath it: its last six entries, each with its time. A long entry ends in `…`; a click shows its full text beneath it, pushing the rest down (as many lines as the pane has room for), and a second click hides it. Click the name again to close the box. The box takes its rows from the activity log
- README:46:
  > an activity log; a line too long for the pane ends in `…`, and a click shows its full text beneath it (a second click hides it); the log gives up the rows it takes

**Acceptance:**
- All tests pass, and the `crowded` tests are unchanged.
- No `position="absolute"` or `hover=` remains in R.
- No new state key.
- Gates green.
- Manual check M5.

#### Decisions taken

| question | choice | rejected |
| --- | --- | --- |
| Hover card or in-flow | an in-flow expansion on a press, for both transcript and activity, as on the desktop | a card placed so it can't overlap (no reliable free space; needs the line's row, which the render lacks) |
| Row budget | one pure budget, `terminalBase`; the expansion is capped so the activity keeps 3 lines, and the activity gives up exactly its rows | capping by the activity count (today's bug) |
| Activity card too | yes, same treatment: today it's uncapped upward and covers the tree | leaving it as is |
| view.ts only? | no: the helpers are in V, the drawing in R | |

---

### Task 6: version (content, exempt)

`.claude-plugin/plugin.json` `version` goes from `0.3.6` to `0.3.7`, after Tasks 1-5 are green.

## Deviations and open risks

1. **The real Agent check's input shape is unverified.** F1 says the prompt the check sees is the hooked one (with the clause). If M1 still refuses, read the debug line `Agent check not matched: prompt=N chars`, compare N with the replacement prompt's length (bare and with the clause), and widen the match in a follow-up. Do not widen it in advance.
2. **TaskStop on a finished background subagent** may answer an error (it is not running). The mod logs `not stopped (…)` at info and goes on. Whether TaskStop stops a *finished but resumable* subagent, and so prevents a later wake, is engine behaviour that only M3 shows. The redirect (Task 3) is the main defence: the stop is belt and braces.
3. **The classifier and a rewritten `to`.** Under auto mode, the classifier judges the model's SendMessage after the rewrite (F3, F6). It is the model's own request, so it should pass; M3 confirms it.
4. **The lost press** remains a hypothesis (see Finding). Task 4 makes it diagnosable.
5. **The test kit's `tool_use_id` on a plugin spawn** (F4): if it is filled, the world condition becomes `!== 'tu1'` (Task 1).

## Manual checks (final reviewer)

- **M1 (Task 1)**, desktop app, auto mode:
  1. Have an orchestrator spawn a child, then press its `Hand over`.
  2. After the note, the activity log shows `replaced by …` and no `respawn refused`.
- **M2 (Task 2)**:
  1. With `autoRespawn` on, force a failure: temporarily set the agent's brief type to a non-existent agent in `state.json`, or run before Task 1's fix.
  2. The row shows `respawn-failed` (⚠️ / `✗`), the parent gets the `no replacement started` notice, the `.brief.md` file exists, and a toast shows.
- **M3 (Task 3)**:
  1. After a swap, have a grandchild SendMessage the old orchestrator name.
  2. The new orchestrator receives it, and the grandchild's tool result carries the redirect notice.
  3. The log says `… stopped` or `not stopped (…)`. Record which.
  4. The old row's children are drawn under the replacement.
- **M5 (Task 5)**, terminal, 80 and 40 columns:
  1. Open a transcript with a long `» <teammate-message …>` brief and tool calls beneath it.
  2. Click the brief: its full text shows beneath it, and the tool calls move down. Click one: its detail opens.
  3. No characters show outside the pane's border.
  4. Click a long activity line: its text expands in place, and the tree is never covered.
- **M4 (Task 4)**:
  1. On the desktop, open a running agent's transcript and press `Hand over` a few times while it works.
  2. In `.orchestrator/<run>/activity.log`, each press should have a `press handover:<id> (desktop, orchestrator)` line.
  3. A press you made with no such line is lost before the mod (see Finding): report it with the time.
