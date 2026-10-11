# Pane fixes: fold control, Hand over under auto mode, desktop copy

Date: 2026-10-12 · Branch: `pane-fixes` · Mod version now: 0.3.4 → **0.3.5** (Task 4) · Engines: terminal 2.1.296, desktop app's bundled 2.1.295

## Goal

1. **Collapse that works.** Double-click can never work: the host turns a second click into a word-select multi-click, and `UiPressArgument` has no click count. Remove it. Add a disclosure glyph (`▾` expanded, `▸` collapsed) on every row that can fold, plus a `c` hotkey in the header that folds the selected row (or main).
2. **Hand over under auto mode.** A Hand over press fails with `HANDOVER could not be delivered (The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one. …)`. The mod's own `$.session.send` is judged as a SendMessage tool call that no user request asked for. Fix: a `tool.check` hook that allows exactly the sends the mod is making at that moment.
3. **Copy on the desktop.** Nothing in a desktop plugin pane can be selected. Add one shared copy control beside each agent row, in each expanded activity card and transcript card, and on each tool-detail section.

## Baseline (run 2026-10-12 on `f85cf7f`, branch `pane-fixes`, clean)

| gate | result |
| --- | --- |
| `claude plugin test .` | **362 pass, 0 fail, 4 files** |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0 |
| `claude plugin validate .` | ✔ Validation passed (state keys: agents, collapsed, log, mainPhase, mainQueued, outbox, pinnedLog, runId, selectedAgent, toolView, transcripts) |

## Global invariants (every task)

- **TDD always, no exceptions.** Write the failing test first, run `claude plugin test .` and watch it fail for the expected reason, then implement until it passes. Pass this rule on to any sub-agent. Only README/SKILL text and the version bump are exempt.
- **Don't break existing tests.** The only tests that may be removed or rewritten are the ones this plan names.
- **Hooks never throw.** Guard with try/catch and fall through (`return next(e)` or a harmless default). Press closures never reject unhandled.
- **Keep existing keys stable:** `agent:<id>`, `handover:<id>`, `handover:main`, `transcript:<id>`, `row:<id>` (desktop row Box), `<id>` (terminal row Box), `tool:<agent>:<toolUseId>`, `toolrow:…`, `tooldetail:…`, `full:<pin>`, `close`, `chart`, and every `$.state` key. New keys are all new prefixes: `fold:`, `nofold:`, `fold-hotkey`, `copy:`.
- **Carried over from earlier plans:**
  - `$` is passed only to top-level functions in `register.tsx`.
  - No state is written while drawing.
  - The render never awaits `$.session.messages`.
  - Every `$.state` key is declared in `PluginState`.
  - Hand over buttons, `handover:main` and the in-view mark stay.
- **Gates after every task:** `claude plugin test .` (count = previous − removed + new, 0 fail), `npx -p typescript@5.6.3 tsc -p .` (exit 0), `claude plugin validate .` (passes).

## Facts (sources)

**T** is `.claude-plugin/types/claude-code/index.d.ts` (21,293 lines, written by 2.1.296). **R** is `hooks/register.tsx`, **V** `hooks/view.ts`, **RT** `hooks/register.test.ts`, **VT** `hooks/view.test.ts`. **B295** is `~/Library/Application Support/Claude/claude-code/2.1.295/*/claude.app/Contents/MacOS/claude`, checked with `strings`.

### Collapse today

- **F1. The double-click machinery.**
  - `lastPress` and `pressQueue` are module state (R:142-145), reset in `register` (R:1019-1020).
  - `pressAgent` queues `pressOnce` (R:241-251).
  - `pressOnce` has the double branch: `isDoublePress`, then restore `prevSelected`, then toggle `collapsedAtom` when the row has children (R:253-267).
  - `isDoublePress` is at V:611-613 and imported at R:42 and VT:23. Its test is VT:957-963.
  - The comment at R:76 calls `collapsedAtom` "collapsed by a double-click".
  - The comment at R:1691 says main is pressable "so a double-click can collapse it".
- **F2. The pure collapse helpers stay as they are:** `childrenOf` (V:570), `descendants` (V:574, not exported), `collapseHidden` (V:596-605), `hiddenCount` (V:608-609). The `collapsed` key is `orchestrator.collapsed` (R:77).
- **F3. The terminal row** (R:1655-1700):
  - `NAME = min(24, max(12, floor(cols*0.25)))` (R:1555).
  - `lead = indent + glyph + ' '`, sliced to NAME (R:1663).
  - `room = NAME - lead.length` (R:1670). The name keeps at least 4 columns, and the `↻` and `+N done` marks shrink first.
  - The `agent:<id>` Button holds `glyphCell` and `nameCell`, which together are exactly NAME columns (R:1692-1695).
  - The row Box is keyed `row.id` (R:1690).
  - The test at RT:2621-2643 asserts the Button's text length is 12 at `cols=40`, and that `children[1]` (the name cell) contains `impl`.
- **F4. The desktop row** (R:1480-1510): `Box key="row:<id>" flexDirection="row" paddingLeft={depth*2} gap={1}`, holding the `agent:<id>` Button, then `handover:<id>` when `canHandOver`.
- **F5. The headers.**
  - Desktop: `<Text bold>{header}</Text>` plus `handover:main` (R:1462-1473).
  - Terminal: the same (R:1645-1654). Its `handover:main` Button is not `plain`.
  - **No `hotkey` is used anywhere in the repo** (grep of R and RT), so `c` is free.
- **F6. Button props** (T:1058-1168):
  - `hotkey`: one digit or one lowercase letter, pressed while the plugin's site holds focus; "two clash, later wins" (T:1087-1094).
  - `plain`: "the hotkey in the accent color, a colon, the label (`1: Yes`)… no `hotkey`, the label alone". A one-glyph label is a control by itself, and a desktop draws its native button either way (T:1103-1112).
  - The label is the `label` prop or the one string child (T:1075-1086).
  - The test kit's `ui.press({ key })` presses "as a click or its hotkey does" (T:15115-15127). So a hotkey is tested by asserting `props.hotkey === 'c'` and pressing its key.
- **F7. `label(r) = r.name ?? (r.description || r.id)`** (core.ts:155). Main's row has `description: 'main thread'` (core.ts:28), so `label(main)` is `main thread`.

### Sends and `tool.check`

- **F8. Every mod send** (validate lists `$.session.send (via deliverHandover, drain, tellParent)`):
  - `deliverHandover` R:549, awaited. This is the pane's Hand over, `/orch handover`, and the drain's queued HANDOVERs (R:752-756).
  - `tellParent` R:566, awaited.
  - `drain` R:763-770: `void $.session.send(...)`, not awaited, and inside a try.
- **F9. The pane Hand over press** is handled in the `ui.press` hook, in hook context (R:1323-1335), and calls `startHandover`. For an idle agent that calls `sendHandover`, then `deliverHandover`, then `$.session.send` (R:511-560).
- **F10. `tool.check`:**
  - It fires "when the engine decides whether a tool call may run… before the mode settles an ask". `next(e)` resolves to the engine's verdict and runs no tool. A hook may return any `{ decision }`. "A guard that fails is skipped, leaving the verdict beneath." Matcher example: `on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }))` (T:3963-3976).
  - `ToolCheckDecision = 'allow' | 'ask' | 'deny'`. `ask` "puts it to the mode's decider (the dialog, the auto-mode classifier…)", so `allow` skips the classifier (T:12807-12811, T:12867-12880).
  - `ToolCheckInput = { tool, input: unknown, tool_use_id?, agentId?, ceiling? }`, all pinned (T:12820-12858).
  - The hook signature is `($, e, next) => ToolCheckResult | Promise<…>`, with `next(e)` returning `Promise<ToolCheckResult>`.
  - `$.tool.check({ tool, input })` "runs the same chain, executing nothing", and carries no `agentId` (T:4716, T:3969, T:12801-12818).
- **F11. The SendMessage input** is `{ to: unknown, summary?, message: string | {…structured} }` (T:16625-16640).
  - For `$.session.send({ to: { agentId } })`, "the engine spells the two id forms the tool's way before the send… `{ agentId }` as the id (a live teammate's as its name)" (T:11514-11521).
  - So `to` is the agent id, or a live teammate's name. `namesAgent(to, row)` already matches an id or name and ignores a trailing ` [ref]` (V:504-512); reuse it.
- **F12. `next.origin`** names who raised a dispatch (`Origin { plugin, tier }`, T:7324-7343, T:6582-6594). For a real call, `ToolCheckInput.tool_use_id` notes "`{ plugin: 'engine', tier: 'core' }` for the model's own call, the plugin for its `$.tool.call` or its query" (T:12836-12840).
  - Whether a check raised by a plugin's `$.session.send` carries the plugin's origin is **not documented**. The decided design (a pending-send set) does not depend on it.
- **F13. The test world** (RT:13-158):
  - Its `session.send` hook (RT:66-77) is synchronous and pushes `{ to: e.to, text: e.text }` onto `w.sent`. `e.to` is a string, and tests match it with `m.to.includes('agent1')`.
  - It has `sendFails` and `hangNext`.
  - Hooks a test registers sit **beneath** the plugin (RT:2787 relies on this for `ui.press`).
  - No `tool.check` hook is registered today.

### Copy

- **F14. `$.ui.copy({ text, surface })`** resolves `{ isCopied: true } | { isCopied: false, reason: 'no-surface' | 'no-clipboard' | 'refused' }` (T:2565-2578, `UiCopyArgs` T:13704-13721, `UiCopyResult` T:13728-13760).
  - The hook form is `on('ui.copy', …)`, answerable with `{ value }` (T:7034-7037, T:7272).
  - The ButtonProps `onPress` doc shows exactly `onPress: press => $.ui.copy({ text: url, surface: press.surface })` (T:1158-1167). So the copy runs from the Button's own closure. Unlike a send, no hook context is needed.
- **F15. Desktop support is conditional (deviation, see below).**
  - T:2570-2571 says "The terminal writes as `/copy` does; a remote surface has no path yet".
  - B295 does have a `ui_copy` client request, but "sent only to a client whose ui_attach named `ui_copy` under `answers`; unanswered within 5 s… resolves `{isCopied: false, reason: 'no-clipboard'}`". A client that never names it gets `no-clipboard`.
  - So on today's desktop app a copy may fail with `no-clipboard`, after up to 5 s. The control must report failure visibly.
- **F16. What to copy.**
  - `DetailSection` is `{ kind: 'code', source, … } | { kind: 'markdown' | 'text', text }` (types/index.d.ts:91-97).
  - A Bash call with no description has sections `Command` (`npm test`), then `Output` (detail.ts:130-136).
  - `detailBody(ui, d)` and `toolBody(ui, v)` are top-level and take no `$` (R:467-507). They are used by the dialog (R:1346-1356) and by the inline fallback in both panes (R:1427-1432, R:1594-1599).
- **F17. Expandable cards on the desktop:**
  - Activity: `full:<logId>`, pinned through `togglePinned` (R:1532-1548).
  - Transcript text: `full:<pin>`, where `pin = step-<agentId>-<key>` (R:1444-1458).
  - The terminal uses hover cards instead (R:1608-1637, R:1740-1762). The terminal has native selection, so it gets no copy controls.
- **F18. `log($, text, 'warn')`** appends to the activity log and toasts (R:200-204). `$.ui.toast(text)` is `(text, options?) => void` (T:2453).

## Deviations from the brief's diagnosis

1. **Desktop copy may not work on today's app (F15).** T says remote surfaces have "no path yet". B295 routes `ui_copy` only to a client that announced it. Build it anyway, as decided, but show a failure toast with the reason. The manual check records whether the desktop app copies. If it answers `no-clipboard`, that is an app limitation to report; the mod is not at fault.
2. **The exact-text match is unverified against the real engine (F10-F12).** T does not say what `input.message` holds for a check raised by `$.session.send`: the raw text, or text inside the envelope. If the manual check under auto mode still fails, log the first unmatched SendMessage check's `to` and the first 80 characters of its `message` with `$.ui.log` (Task 2 includes this as a debug line) to see the shape. Then relax the match (for example, `message.includes(text)`) in a follow-up. Do not relax it pre-emptively.
3. Everything else matches the brief:
   - the double-click code sits at the cited places (V:611 is `isDoublePress`; the `collapse` tests start at RT:2493);
   - the send sites are R:549, R:566 and R:765;
   - there is no `c` hotkey conflict.

## Order

**Recommended: Task 2 → Task 1 → Task 3 → Task 4**, serially, because all touch R and RT.

- Task 2 fixes a broken core path (Hand over under auto mode) and is the smallest. Its only RT change is in the shared `world` (opt-in fields), so landing it first keeps the later diffs clean.
- Task 3 builds on Task 1's new row layout: the copy control sits in the desktop row next to the fold glyph. So 1 must come before 3.
- The brief's order 1 → 2 → 3 also works. The only cost is that Task 2's world edit lands on top of Task 1's large test rewrite.

| Task | Files |
| --- | --- |
| 2 | `hooks/register.tsx`, `hooks/register.test.ts` |
| 1 | `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md`, `skills/orchestrated-run/SKILL.md` |
| 3 | `hooks/register.tsx`, `hooks/register.test.ts`, `README.md` |
| 4 | `.claude-plugin/plugin.json` (version 0.3.5), after 1-3 are green |

---

### Task 2: allow the mod's own SendMessage under auto mode (register.tsx)

**Design.**
- Module state near R:135:
  ```ts
  /**
   * The mod's sends in flight. Under auto mode the engine judges a plugin's `$.session.send` as a
   * SendMessage call, and the classifier refuses it because no user request asked for it. tool.check
   * allows exactly these sends, and only while they are in flight.
   */
  const ownSends: { agentId: string; text: string }[] = []
  ```
  Reset it in `register` (R:1019 area): `ownSends.length = 0`.
- One top-level helper. Every mod send goes through it:
  ```ts
  /** The mod's only way to send: marks the send as its own for tool.check while it is in flight. */
  async function sendOwn($: $, agentId: string, text: string) {
    const mark = { agentId, text }
    ownSends.push(mark) // synchronously, before any await
    try {
      return await $.session.send({ to: { agentId }, text })
    } finally {
      const i = ownSends.indexOf(mark)
      if (i >= 0) ownSends.splice(i, 1)
    }
  }
  ```
  - It removes by object identity, so two identical concurrent sends each hold their own mark.
  - Replace R:549 `$.session.send({ to: { agentId: id }, text })` with `sendOwn($, id, text)`.
  - Replace R:566 with `sendOwn($, parentId, text)`.
  - Replace R:764-765 `$.session.send({ to: { agentId: d.agentId }, text: d.text })` with `sendOwn($, d.agentId, d.text)`, keeping its `void … .then(…).catch(…)` chain and the surrounding try.
  - Afterwards `grep -n 'session.send' hooks/register.tsx` must show only the line inside `sendOwn`.
- A new hook in `register`, placed after `tool.call`:
  ```ts
  // The mod's own sends (Hand over, a forwarded report, a check-in) are SendMessage calls to the engine;
  // under auto mode the classifier refuses them, since no user request asked. Allow exactly those, while in flight.
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    try {
      const input = (e.input ?? {}) as { to?: unknown; message?: unknown }
      if (typeof input.message === 'string' && ownSends.length > 0) {
        const rows = await read($, agentsAtom)
        const mine = ownSends.some(s => {
          if (s.text !== input.message) return false
          const r = rows.find(a => a.id === s.agentId) ?? { id: s.agentId }
          return namesAgent(input.to, r)
        })
        if (mine) return { decision: 'allow', reason: 'orchestrator mod: its own message' }
      }
    } catch {
      // fall through to the engine's verdict
    }
    return next(e)
  })
  ```
  - `namesAgent` is imported from `./view`. It treats `main` specially, but the mod never sends to `main` (tellParent appends instead), so that does not matter here.
  - Also accept `input.to` given as an object `{ agentId }`, if `typeof to === 'object'`: compare `to.agentId === s.agentId`. Put this as a branch before `namesAgent`.
  - **Debug line (deviation 2):** when `ownSends.length > 0` and nothing matched, `$.ui.log(\`orchestrator: SendMessage check not matched: to=${String(input.to)} message=${String(input.message).slice(0, 80)}\`)` once per module load (a module boolean `checkMissLogged`, reset in `register`).

**Test world wiring (RT, `world`):** opt-in, so the other 362 tests are untouched.
- New fields on `w`:
  ```ts
  /** Auto mode: each session.send first asks tool.check for SendMessage, and a verdict other than allow refuses it. */
  checkSends: false,
  /** The verdict each checked send got, in order. */
  checks: [] as string[],
  /** Runs inside each session.send, after its own check: `check` asks tool.check about any SendMessage. */
  duringSend: undefined as
    | ((check: (input: { to: unknown; message: unknown }) => Promise<string>, e: { to: string; text: string }) => Promise<unknown>)
    | undefined,
  ```
- Make the world's `session.send` hook `async`. At its very top (before the `inTimer` line):
  ```ts
  if (w.checkSends) {
    const check = async (input: { to: unknown; message: unknown }) =>
      (await $.tool.check({ tool: 'SendMessage', input })).decision
    const verdict = await check({ to: e.to, message: e.text })
    w.checks.push(verdict)
    await w.duringSend?.(check, { to: e.to, text: e.text })
    if (verdict !== 'allow')
      return { isDelivered: false, reason: 'The server-side auto mode classifier gave no verdict for SendMessage' } as never
  }
  ```
  - The rest is unchanged. Before the edit, confirm that `hangNext`'s `new Promise(() => {})` still works when returned from an async function (it does: it never resolves).
- A helper next to `world`, used only by the new tests:
  ```ts
  /** Auto mode: the engine's own verdict for a SendMessage is `ask` (the classifier), beneath the plugin. */
  const autoMode = (on: On, w: World) => {
    w.checkSends = true
    on('tool.check', () => ({ decision: 'ask' }))
  }
  ```
  - This base `ask` is registered **only** in these tests. It sits beneath the plugin, so the plugin's hook sees it through `next(e)`.

**Failing tests first** (`describe('auto mode: the mod's own sends')` in RT):
1. `Hand over on an idle agent is allowed and delivered (desktop)`:
   - setup: `running`, `complete($, 'agent1')` (now idle), `autoMode(on, w)`, mount the desktop pane, press `handover:agent1`;
   - expect `w.checks` to equal `['allow']`;
   - expect a HANDOVER in `w.sent` to agent1;
   - expect `row(w,'agent1').status` to be `handing-over` with `handoverVia: 'message'`, not `stalled`;
   - expect no log entry containing `could not be delivered`.
   - **Watch it fail first:** with no plugin hook, the verdict is `ask` and the row goes `stalled`.
2. `the same message checked outside a send is ask`:
   - after test 1's flow, `await $.tool.check({ tool: 'SendMessage', input: { to: 'agent1', message: w.sent.at(-1)!.text } })`;
   - expect `.decision` to be `'ask'` (the mark was removed in `finally`).
3. `a different recipient during the mod's send is ask`:
   - set `w.duringSend = async (check, e) => probes.push(await check({ to: 'agent2', message: e.text }))`;
   - spawn agent2 too, then press `handover:agent1`;
   - expect `probes` to equal `['ask']` and `w.checks` to equal `['allow']`.
4. `the agent's name and a different text`:
   - inside `duringSend`, `check({ to: 'impl-1', message: e.text })` is `allow`;
   - `check({ to: 'agent1', message: e.text + ' ' })` is `ask`;
   - `check({ to: 'agent1', message: { type: 'shutdown_request' } })` is `ask`.
5. `a forwarded report and a queued check-in are allowed too`:
   - with `autoMode`, run the flow of RT:2969 (agent2 under agent1 completes `R: green`);
   - expect `w.sent` to have one `R: green`, and every entry of `w.checks` to be `allow`.
   - This covers `drain`'s un-awaited send and `tellParent` (through a respawn, if it is cheap to add: the RT:2995 flow).
6. `a send that throws still clears its mark`:
   - `w.sendFails = 'throw'`, `autoMode`, agent1 idle (`complete($, 'agent1')` first, so the HANDOVER is sent as a message);
   - start a handover with `/orch handover impl-1` (`$.command.run({ command: 'orch', args: 'handover impl-1' })`, as existing tests do), or the desktop press;
   - then `$.tool.check` with the same `{ to, message }` gives `ask`. With `checkSends` on, the check runs first and the throw comes after; the order in the world hook is check, then the original body.
7. `the check hook never throws`:
   - `await $.tool.check({ tool: 'SendMessage', input: null })` is `ask`;
   - so is `input: { to: 42 }`.

**Acceptance:**
- All 7 tests pass.
- `grep -c 'session.send' hooks/register.tsx` is 1 (inside `sendOwn`), plus comments.
- `claude plugin validate .` lists `$.session.send (via sendOwn)` (or via its callers).
- Gates are green with **369** tests.
- Manual check M2 below.

---

### Task 1: fold glyph and `c` hotkey replace double-click (view.ts, register.tsx)

**Pure helper (V, after `hiddenCount`):** delete `isDoublePress` (V:611-613) and add:
```ts
/** Whether a row offers to fold: it is collapsed (so it can expand), or collapsing it would hide something. */
export const canFold = (rows: readonly AgentRow[], id: string, collapsed: readonly string[]): boolean =>
  collapsed.includes(id) || collapseHidden(rows, [id]).size > 0
/** The disclosure glyph: `▸` when collapsed, `▾` when not. */
export const foldGlyph = (isCollapsed: boolean): string => (isCollapsed ? '▸' : '▾')
```

**Pure tests first (VT, `describe('collapse')`):**
- Delete the `isDoublePress` import (VT:23) and its test (VT:957-963).
- Add `canFold: a row with finished descendants, or collapsed; not a childless or all-live row`, using the `tree()` fixture:
  - `canFold(tree(), 'o', [])` is true;
  - `canFold(tree({ d1: { status: 'running' }, d2: { status: 'running' } }), 'o', [])` is false;
  - the same with `['o']` is true (collapsed rows can always expand);
  - `canFold(tree(), 'd1', [])` is false (childless);
  - `canFold(tree(), 'main', [])` is true (main sees d1 and d2 under o);
  - a row whose only finished descendant sits under a live child is still true (the grandchild case at VT:927-934 with `o`).
- Add `foldGlyph: ▸ collapsed, ▾ expanded`.

**Wiring (R):**
- **Remove** `isDoublePress` from the import (R:42), `lastPress` (R:142-143), `pressQueue` (R:144-145), `pressOnce` and `pressAgent` (R:240-267), and their resets (R:1019-1020).
- The row Buttons' `onPress` becomes `() => toggleSelected($, row.id)` (R:1488, R:1692).
- Fix the comments at R:76 ("Rows the person collapsed with a row's fold glyph or the `c` hotkey…") and R:1691 ("Main too is pressable: a press selects it, so `c` acts on it; it opens no transcript").
- Add a top-level helper:
  ```ts
  function toggleCollapsed($: $, id: string) {
    return update($, collapsedAtom, c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]))
  }
  ```
- **Fold cell, on both surfaces.** `const foldable = (id: string) => canFold(rows, id, collapsed)` is computed in the render from the full `rows` and `collapsed`, as `hidden` is.
  - Foldable row: `<Button key={\`fold:${row.id}\`} plain onPress={() => toggleCollapsed($, row.id)}>{foldGlyph(collapsed.includes(row.id))}</Button>`. Use the one string child, not `label`, so the drawn tree carries the glyph as a child.
  - Non-foldable row: `<Text key={\`nofold:${row.id}\`}> </Text>` (one space, the glyph's width).
  - On the terminal, both are followed by `<Text> </Text>`, so the fold cell is exactly **2 columns** (`FOLD = 2`).
- **Terminal row** (R:1660-1700). The row Box (key `row.id`) holds, in order:
  1. `indent` (Text);
  2. the fold cell (2 columns);
  3. the `agent:<id>` Button, holding `glyphCell` (`glyph + ' '`, 2 columns) and `nameCell`;
  4. the tokens, model, timeline and status as today.
  - `indentW = Math.min(depth * 2, Math.max(0, NAME - FOLD - 2 - 4))`. Deep rows stop indenting, rather than eating the name's minimum 4 columns. Indent with `' '.repeat(indentW)`.
  - `room = NAME - indentW - FOLD - 2` replaces `NAME - lead.length`. The mark-shrinking logic (R:1672-1680) is unchanged.
  - Invariant: `indent + fold cell + agent Button` is exactly NAME columns. The time-axis line (R:1714) still pads `NAME + 7 + MODEL`.
- **Desktop row** (R:1487): the fold cell goes before the `agent:<id>` Button, inside `row:<id>`. A non-foldable row gets the same one-space `nofold:` Text. Alignment on native buttons is best effort, and only presence is tested.
- **Header hotkey, on both surfaces** (R:1462-1473 desktop, R:1645-1654 terminal), after `handover:main`:
  - `const target = liveSelection(visible, selected) || 'main'`. On the desktop `selected` already exists. On the terminal, move the `selected` read (R:1570) above the header use.
  - `const tRow = rows.find(r => r.id === target)`.
  - When `tRow && foldable(target)`:
    ```tsx
    <Button key="fold-hotkey" plain hotkey="c"
      label={`${collapsed.includes(target) ? 'expand' : 'collapse'} ${label(tRow)}`}
      onPress={() => toggleCollapsed($, target)} />
    ```
  - It is drawn only when the target can fold. A selected row that cannot fold shows no button; it does not fall back to main.

**Failing tests first (RT, rewrite `describe('collapse')` at RT:2493-2673):**
- Keep `crew`, `drawn` and `rowText`.
- Replace `double` with:
  ```ts
  const fold = (ui: Ui, id: string) => ui.press({ key: `fold:${id}` })
  /** A drawn element's own text: its children, else its label. */
  const cellText = (n: Drawn) => textOf(n) || String(n.props?.label ?? '')
  ```
- For each surface (`terminal`, `desktop`):
  1. `the fold glyph collapses finished descendants, and again expands them (${surface})`:
     - this is the old double-click test's assertions, driven by `fold(ui,'agent1')`;
     - also: `fold:agent1` reads `▾` before and `▸` after;
     - `transcript:agent1` is never drawn;
     - `selectedAgent` stays `''`.
  2. `a row press only opens and closes the transcript; it never collapses (${surface})`:
     - two `agent:agent1` presses with no clock advance;
     - after the first, `transcript:agent1` is drawn; after the second it is gone;
     - agent2 and agent3 are still drawn.
     - **This fails today:** two quick presses collapse.
  3. `only rows that can fold have a fold glyph; others reserve its cell (${surface})`:
     - `fold:agent1` and `fold:main` exist;
     - `fold:agent2`, `fold:agent3` and `fold:agent4` do not, and `nofold:agent2` and `nofold:agent4` exist;
     - after `fold(ui,'agent1')`, `fold:agent1` still exists (collapsed).
  4. `folding keeps the open transcript (${surface})`: open agent4's transcript, `fold(ui,'agent1')`, then `transcript:agent4` is still drawn and agent2 is hidden.
  5. `main folds its finished top-level agents and keeps a running one (${surface})`: as the old main test, with `fold(ui,'main')`.
  6. `a collapsed row counts a child that finishes later (${surface})`: as before, with `fold`.
  7. `the c hotkey folds the selected row, else main (${surface})`:
     - with nothing selected, `fold-hotkey` has `props.hotkey === 'c'`, `props.plain === true`, and label `collapse main thread`;
     - press `agent:agent1`: the label becomes `collapse impl-1`;
     - press `fold-hotkey`: agent2 is hidden, and the label becomes `expand impl-1`;
     - press it again: agent2 is back;
     - press `agent:agent4` (it cannot fold): `fold-hotkey` is absent.
- Single tests:
  - `terminal: a narrow, nested, resumed, collapsed row keeps its name visible` (adapted, not deleted):
    - same setup at `cols=40` (NAME 12), `fold(ui,'agent3')`;
    - agent4 is not drawn;
    - the `agent:agent3` Button's text contains `impl`;
    - the row Box `agent3`'s children before the token cell (indent, fold Button, its space, agent Button) have `cellText` lengths that sum to **12**;
    - `fold:agent3` reads `▸`.
  - Delete `two presses dispatched together still count as a double-click` (RT:2645-2654). Its premise is gone.
  - `collapse is display only and persists across a remount`: as before, with `fold(ui,'agent1')`.
- **Regression guard:** the existing transcript tests that press `agent:agent1` twice to close a transcript (for example RT:1718) must stay green unchanged. They pass today only because of `w.clock` gaps; after the change they need none.

**Docs (content, exempt):**
- README.md:44, :52 and :63: replace the double-click sentences. A `▾` before a row with finished agents beneath it collapses them into `+N done` (`▸` expands them). With the pane focused, `c` collapses or expands the selected row (main when none is selected). A click on a row only opens or closes its transcript.
- skills/orchestrated-run/SKILL.md:72: replace "double-clicking a row with children…" with "the `▾`/`▸` glyph before a row (or `c` with the pane focused, on the selected row or main) collapses its finished descendants into `+N done`".

**Acceptance:**
- No `isDoublePress`, `lastPress`, `pressOnce` or `pressQueue` remains (`grep -n` over `hooks/` returns nothing).
- No "double-click" or "double-clicking" remains in README.md, SKILL.md or `hooks/`.
- `orchestrator.collapsed` is unchanged in validate.
- Gates are green.

---

### Task 3: one copy control on the desktop (register.tsx)

**Design.**
- Top-level helpers in R (`// ---- pane presses ----` section):
  ```ts
  /** Copies to the pressing surface's clipboard and says so in a toast. Never throws. */
  async function copyText($: $, text: string, surface: RenderSurface) {
    try {
      const r = await $.ui.copy({ text, surface })
      $.ui.toast(r.isCopied ? 'Copied' : `Not copied (${r.reason})`)
    } catch (err) {
      $.ui.log(`orchestrator: copy failed: ${String(err)}`)
      try { $.ui.toast('Not copied') } catch { /* nothing more to do */ }
    }
  }

  /** The one copy control: a small plain Button, keyed `copy:<id>`, desktop only (the terminal selects natively). */
  function copyButton($: $, ui: Ui, id: string, text: string) {
    const { Button } = ui
    return <Button key={`copy:${id}`} plain dimColor label="⧉" onPress={e => void copyText($, text, e.surface)} />
  }
  ```
  - Import the `RenderSurface` type from `claude-code`, or use `UiPressArgument['surface']`.
  - The press runs in the closure, as the T:1165 example does: a copy, unlike a send, needs no hook context (F14).
- **Key scheme.** Every key is `copy:` plus the id of the thing copied, unique within its pane and stable across renders:

  | where | key | text copied |
  | --- | --- | --- |
  | each desktop agent row, after the `agent:<id>` Button and before `handover:<id>` | `copy:agent:<id>` | `label(row) === row.id ? row.id : \`${label(row)} (${row.id})\`` (main: `main thread (main)`) |
  | inside the pinned activity card `full:<logId>` (R:1540) | `copy:<logId>` | `l.text` in full |
  | inside the expanded transcript card `full:<pin>` (R:1454) | `copy:<pin>` (`copy:step-<agentId>-<key>`) | `it.full` |
  | each tool-detail section, beside its label | `copy:sec:<toolUseId>:<i>` | `sec.kind === 'code' ? sec.source : sec.text` |

- **Threading `$` into the detail.** `detailBody(ui, d)` becomes `detailBody($, ui, d, copy?: { toolUseId: string })` and `toolBody(ui, v)` becomes `toolBody($, ui, v, copyable: boolean)`. `toolBody` passes `{ toolUseId: v.toolUseId }` when `copyable` and `v.detail` is set.
  - Each section's label line becomes `<Box flexDirection="row" gap={1}>` holding the dim bold label `Text`, plus `copyButton(...)` when `copy` is set.
  - Callers:
    - the dialog (R:1350) passes `e.surface !== 'terminal'`;
    - the desktop inline fallback (R:1430) passes `true`;
    - the terminal inline fallback (R:1597) passes `false`.
- **Terminal: no copy controls anywhere.** It has native selection, and a `⧉` per row would cost a column.

**Test world (RT `world`):** unconditional, since nothing calls copy today.
```ts
/** Each `ui.copy` as asked. */
copies: [] as { text: string; surface?: string }[],
/** How `ui.copy` answers: copied, a refusal reason, or a throw. */
copyFails: '' as '' | 'no-clipboard' | 'throw',
```
```ts
on('ui.copy', ($, e) => {
  if (w.copyFails === 'throw') throw new Error('clipboard broke')
  w.copies.push({ text: e.text, surface: e.surface })
  return { value: w.copyFails ? { isCopied: false, reason: w.copyFails } : { isCopied: true } } as never
})
```

**Failing tests first** (`describe('copy')` in RT; `const copyKeys = async (ui) => (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('copy:'))`):
1. `each desktop agent row has a copy control that copies its name and id`:
   - `running`, mount desktop;
   - `copy:agent:main` and `copy:agent:agent1` exist;
   - press `copy:agent:agent1`;
   - `w.copies` equals `[{ text: 'impl-1 (agent1)', surface: 'desktop' }]`;
   - `w.toasts` contains `Copied`.
2. `the terminal draws no copy control`: `running`, mount terminal, open agent1's transcript and a long activity line; `copyKeys` is empty.
3. `a pinned activity card has a copy control for its full text`:
   - use the setup of RT:867 (long agent name, desktop at 40 columns);
   - `copy:<line.key>` is absent until the line is pressed;
   - press the line, then `copy:<line.key>` → `w.copies[0].text` contains the full name.
4. `an expanded transcript text has a copy control for its full text`:
   - use the setup of RT:1680 (`longStub`, `open`, `stepButton`);
   - press the button, then `copy:<button.key>` → the copied text contains `END` and `Long thoughts:`.
5. `each tool-detail section has a copy control (desktop dialog)`:
   - use the tool-detail setup (`opened`, `said(uses.b)`), press `tool:agent1:b`, settle, `mountTool($,'desktop')`;
   - `copy:sec:b:0` copies `npm test`, and `copy:sec:b:1` copies `PASS 3 tests`;
   - with `mountTool($,'terminal')` there is no `copy:` key.
6. `the inline detail on a desktop that places no dialog has the same controls`: `w.placesTool = false`, open `tool:agent1:b` on the desktop pane; `copy:sec:b:0` is in the main pane.
7. `a copy that fails says why and never throws`:
   - `w.copyFails = 'no-clipboard'`, press `copy:agent:agent1` → toast `Not copied (no-clipboard)`;
   - `w.copyFails = 'throw'` → the press resolves, and the toast is `Not copied`.
8. **Regression:** existing tests that count Buttons or read a row Button's `text` (for example `find({ key: 'agent:agent1' }).text`) are unaffected, because the copy control is a sibling, not a child, of `agent:<id>`. If any test uses `findAll({ type: 'Button' })` positionally, fix it by key, not by removing the control.

**Docs (content):**
- README desktop bullets (R-section around README:48-57): "a `⧉` beside each agent, each expanded activity or transcript card, and each section of a tool call's detail copies its text (a toast says whether it took; the desktop app must support plugin copies)".
- README terminal: nothing; it selects natively.

**Acceptance:**
- All 8 tests pass.
- `copy:` keys appear only on non-terminal surfaces.
- validate lists `$.ui.copy (via copyText)`.
- Gates are green.

---

### Task 4: version (content, exempt)

`.claude-plugin/plugin.json` `version` goes from `0.3.4` to `0.3.5`, after Tasks 1-3 are green.

## Manual checks (final reviewer)

- **M1 (Task 1)**, terminal (`claude --plugin-dir /Users/victorb/code/cc-orchestrator-mod`) and the desktop app:
  1. Spawn an orchestrator with two children, and let one finish.
  2. `▾` shows before the orchestrator and main only. A click collapses to `+1 done` and `▸`.
  3. A row click opens and closes the transcript, and never collapses.
  4. Focus the pane (ctrl+x tab, or a click). The header shows `c: collapse …`, and `c` toggles it.
  5. The terminal columns stay aligned at narrow and wide widths.
- **M2 (Task 2)**, with auto mode on:
  1. Press `Hand over` on an idle subagent on the desktop. It is delivered: the activity shows `HANDOVER sent`, and the agent is not stalled.
  2. If it still fails, read the `SendMessage check not matched` debug line, and follow deviation 2.
- **M3 (Task 3)**, desktop app:
  1. Press `⧉` on a row, a pinned activity card, an expanded transcript item, and a tool-detail section.
  2. Paste each one.
  3. Record whether the app answers `Copied` or `Not copied (no-clipboard)` (F15). The second is an app limitation to report; it is not a mod bug.
