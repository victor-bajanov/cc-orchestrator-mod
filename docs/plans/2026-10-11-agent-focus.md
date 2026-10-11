# Main-handover control parity, and following the agent in view

Date: 2026-10-11 · Branch: `agent-focus` · Mod version now: 0.2.0 · Engines: terminal Claude Code 2.1.296; desktop app's bundled Claude Code 2.1.295 (2.1.293 also on disk)

## Goal

1. **Main-handover control parity.** Both surfaces offer the manual main-handover control whenever `mainHandover` is `ask`, even below the threshold. Neither surface offers it for `auto` or `off`.
2. **Click an agent to bring its transcript into the main view.** First find out whether a mod can do this. Build only the parts a documented, typed API supports.

## Baseline (before any change)

| gate | result |
| --- | --- |
| `claude plugin test .` | 95 pass, 0 fail |
| `claude plugin validate .` | ✔ Validation passed |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0 |

## Sources

- **S**: the plugin-authoring skill's SKILL.md, loaded through the Skill tool (2.1.296).
- **T**: `…/plugin-authoring/types/claude-code.d.ts`, written by 2.1.296 (21,293 lines). It is byte-identical to the repo's `.claude-plugin/types/claude-code/index.d.ts` (checked with `diff -q`). Line numbers below are in T.
- **B293 / B295 / B296**: the engine binaries. B293 and B295 are `~/Library/Application Support/Claude/claude-code/2.1.29{3,5}/*/claude.app/Contents/MacOS/claude`; B296 is `~/.local/share/claude/versions/2.1.296`. The desktop app ships **no `.d.ts`**: the folders hold only `claude.app` and `.verified`. So for the desktop versions, the API can be checked only by grepping the binary for op names (`grep -a -o '"(agent|session|ui)\.[a-zA-Z]+"'`).
- **Code**: `hooks/register.tsx` (R), `hooks/register.test.ts` (RT), `hooks/view.ts` (V), `README.md`, `skills/orchestrated-run/SKILL.md`, `.claude-plugin/plugin.json`.

## Feasibility findings: task 2 (bring an agent into the main view)

1. **No op lets a mod change which transcript is in view.**
   - `$.agent` has only `spawn`, `list` and `register` (T:3173-3222). `$.session` has `messages`, `cwd`, `root`, `model`, `turns`, `id`, `send`, `compact` and similar; none of them views anything (T:2745-2830). `$.ui` has `open`, `close`, `scroll`, `focus` (moves a focus ring inside *this plugin's* site, T:2550-2564), `copy`, `status`, `toast` and similar; none of them views anything.
   - The full list of event and op names (T:3962-7190) has no `agent.view`, `agent.focus`, `ui.view` or `session.switch`.
   - The binaries agree. The op-name sets of `agent.*`, `session.*` and `ui.*` are identical in B293, B295 and B296, except that `ui.notify` is missing from B293. None of them has a view or switch op.
2. **The host's agent view is readable but not writable.** `Pane` and `AbovePrompt` both receive `props.view: SiteView` (T:10308, T:10364). Its doc says it is "Which transcript is on screen beside the pane: the main conversation's (no `agentId`) or one agent's, opened from the tasks list. … Read-only: a rewrite carries it on as received; one that changes or drops it is refused." `SiteView = { agentId?: string }` is "the `id` `$.agent.list()` gives it, the `agentId` its `turn.step` and `tool.call` events carry" (T:11880-11888). That `agentId` is the id our `AgentRow.id` uses.
3. **How the host opens an agent's view.**
   - **Terminal:** the person opens it from the tasks list (`/tasks`, alias `/bashes`: "View and manage everything running in the background", `immediate`; B296 string table). The `Agents` keybinding context has `agents:switchView` (ctrl+s), `agents:togglePin`, `agents:find` and similar (B296).
   - Those are the engine's own keybindings. A `Button`'s `action` prop goes the other way: the person's chord presses *our* button (T:1096-1103). It cannot fire an engine action.
   - **Desktop:** the agent panel belongs to the desktop app's GUI. Nothing in T or in B295 reaches it.
4. **Reading an agent's transcript is a CLEAN API.** `$.session.messages({ agentId })` returns that agent's `SessionMessage[]` (`role`, `text`, `toolUses`, …), or `{ deny }`. It denies for a teammate hosted in another pane's process, or for a finished agent with no saved transcript (T:2747-2778, T:11142-11262).
   - The op name `"session.messages"` is present in B293, B295 and B296.
   - Reads are allowed while drawing; only `$.state.set` is refused there (T:3387-3412; reference.md "Drawing").
   - This would let the mod show a transcript **inside its own pane**. It would not show it in the main view.
5. **`$.command.run({ command: 'tasks' })`** is documented as running a slash command "as if the person typed" it (T:3071-3078). Two things are not documented: whether an `immediate`, dialog-type built-in opens its dialog when a plugin runs it, and whether the dialog could be pointed at one agent. At best it opens the generic list, and the person still picks the agent.

### Classification

| capability | terminal (2.1.296) | desktop (2.1.295) |
| --- | --- | --- |
| Put agent X's transcript in the main view from a click | **NONE**: no op (findings 1, 3) | **NONE**: no op; the agent panel is GUI-only (findings 1, 3) |
| Know which agent the host has in view, and mark it in the pane | **CLEAN**: `Pane.props.view` (finding 2) | **CLEAN on the 2.1.296 types**. The desktop has no `.d.ts` to confirm the prop on 2.1.295, and whether the desktop's agent panel sets it is undocumented. If it is absent, the mod draws no mark. See Risks. |
| Show agent X's transcript inside the Orchestrator pane | **CLEAN** (finding 4) | **CLEAN**: the op is present in B295 (finding 4) |
| Open `/tasks` for the person to pick from | **HACKY**: unconfirmed behaviour, not targeted (finding 5) | **NONE**: commands may not be listed on the desktop (desktop-target plan, fact 9) |

**Outcome:** the switching the user asked for is **NONE on both surfaces**, so it does not ship. Clicking a desktop row keeps highlighting its chart line. This plan builds one CLEAN complement, Task 2 below: the pane follows the agent the person opened through the host's own view. Anything beyond that is under "Escalation options".

## Current code: task 1 (main-handover control)

- **Desktop pane button:**
  - R:611: `const canHandMain = cfg.mainMode !== 'off' && phase !== 'writing' && phase !== 'clearing'`. This shows the button for `auto` too, which is the inconsistency.
  - R:614-624: the button itself, `<Button key="handover:main" variant="secondary" label={queued ? 'Handover queued' : 'Hand over main'} onPress={() => startMainHandover($)} />`, inside the header row Box with `<Text bold>{header}</Text>` (R:616).
- **Terminal pane:** the header is a lone `<Text bold>{header}</Text>` (R:708). There is no main-handover control.
- **Band (AbovePrompt, one tree for both surfaces):** R:556-576. It draws only when `phase === 'offered' && cfg.mainMode === 'ask'` (R:558). It holds `key="handover"`, labelled `Handover queued` or `Hand over & restart` (R:567-572), and `key="dismiss"`, `Not now`, which sets `cooldown`.
- **Shared behaviour, unchanged by this plan:**
  - `startMainHandover` (R:297-327) has the synchronous double-press guard, queues mid-turn (`mainBusy`, `queuedAtom`), and returns in `writing`/`clearing`.
  - The queue is drained in `turn.complete` (R:486-520). The threshold offer is made in `checkMain` (R:352-362).
  - `/orch handover [main]` (R:540) works in every mode.
- **Tests that touch this:**
  - RT:436-453: the band in ask mode, looped over terminal and desktop.
  - RT:455-463: off mode never offers.
  - RT:606-614: desktop button hidden while writing.
  - RT:616-632: pressed mid-turn, it waits.
  - RT:634-651: desktop queued label.
  - RT:653-673: terminal band queued label.
  - RT:675-704: a turn end that fails beneath.
  - RT:706-715: double press.
  - RT:731-739: Hand over main starts it.
  - RT:741-747: none when off.
  - The `mountPane(surface, bodyColumns)` helper is at RT:561-562, and the `running($, w)` fixture at RT:564-569.
- **Docs:**
  - README:26 says ask mode "offers a **Hand over & restart** button above the prompt", and mentions "the desktop pane's `Hand over main`".
  - README:38 says the button is "hidden when `mainHandover` is `off` or main is already handing over".
  - README:43 covers the band.
  - plugin.json:24: `ask: offer a button above the prompt`.
  - SKILL.md:26, 64 and 68.

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | One pure rule, `mainButtonShown(mode: string, phase: MainPhase): boolean` in `hooks/view.ts`, equal to `mode === 'ask' && phase !== 'writing' && phase !== 'clearing'`. The two pane trees and nothing else use it. | One source for both surfaces; testable without mounting. |
| D2 | **The always-available control on the terminal is a pane button, as on the desktop.** The terminal header becomes `<Box flexDirection="row" gap={1}><Text bold>{header}</Text>{shown && <Button key="handover:main" label={queued ? 'Handover queued' : 'Hand over main'} onPress={() => startMainHandover($)} />}</Box>`. It is the same key, label and handler as the desktop button, drawn `[ Hand over main ]`. The terminal pane must now also read `queuedAtom`. | **Rejected: a persistent quiet band.** It would hold a row above the prompt for the whole session on both surfaces, because AbovePrompt is one tree. Prompt rows are the scarcest space on the terminal. The pane is already the orchestrator's control surface and opens on the first spawn. `/orch` reopens it, and `/orch handover main` remains for a closed pane. |
| D3 | **The band is unchanged:** still the prominent offer past the threshold (`offered` and `ask`), on both surfaces, with `Hand over & restart`, `Handover queued` and `Not now`. | The user's decision concerns the always-available control. The threshold prompt stays the prominent one. Both surfaces now follow the same two rules. |
| D4 | `auto`: no pane button on either surface. This is a behaviour change for the desktop. `/orch handover main` keeps working in every mode, unchanged. | It matches the user's decision. The slash command is an explicit request and is out of scope. |
| D5 | Task 2: the pane marks the agent the host has in view. `viewed = liveSelection(rows, e.props.view?.agentId ?? '')`, with optional chaining because the kit's mounts and older hosts may omit `view`. Main is never marked: no `agentId` is the default view. | Finding 2: the CLEAN part of task 2 that keeps the pane and the main view in step. |
| D6 | **Desktop:** the viewed row's Button gets a trailing `<Text dimColor> · in view</Text>`. The chart highlights `selected \|\| viewed`, so a click selection still wins and clicking still only highlights. | It keeps today's click behaviour (D5 of the desktop-target plan). With no click selection, the line in view stands out. |
| D7 | **Terminal:** the viewed row's name `Text` gets `key={`name:${row.id}`}` and `inverse`. Today's per-row layout is otherwise unchanged. | It marks the row without spending a column. |
| D8 | Nothing in either task writes new state. `types/index.d.ts` is unchanged. | `view` is a render prop; `queuedAtom` already exists. |
| D9 | **Version:** **0.2.1**, because the switching asked for in task 2 does not ship. If the user approves Escalation P (the in-pane transcript), it becomes **0.3.0**. The orchestrator bumps `.claude-plugin/plugin.json` (`"version"`, line 3) at the end. | Caller's rule. |

## Tasks

TDD is mandatory for Tasks 1 and 2: write the failing test first, watch it fail, implement, watch it pass. Pass this rule on to any sub-agent. Task 3 is content and exempt.

**Ordering:**
- Tasks 1 and 2 both touch `hooks/register.tsx` and `hooks/register.test.ts`, so **Task 2 runs after Task 1 is committed**.
- Task 3 (docs) touches only content files and can run in parallel with either, against the decisions above.

Gates after every task:
```
claude plugin test .
claude plugin validate .
npx -p typescript@5.6.3 tsc -p .
```

### Task 1: main-handover control parity

**Scope:** `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`.

**Failing tests to write first:**
1. `view.test.ts`: `mainButtonShown`:
   - `('ask','idle')`, `('ask','offered')` and `('ask','cooldown')` are true.
   - `('ask','writing')` and `('ask','clearing')` are false.
   - `('auto','idle')`, `('auto','offered')` and `('off','idle')` are false.
   - This fails because the export is missing.
2. `register.test.ts`, new `describe('main handover control')` with a loop over `['terminal', 'desktop'] as const`, using `mountPane` and `running` (lift both to file scope so both describes share them). For each surface:
   - a. **Below the threshold in ask (default options; main at 1,000 tokens):** `handover:main` exists, with label `Hand over main`. Pressing it, then `w.clock.advance(10)`, makes `w.prompts[0]` contain `main-1.md`. Fails on the terminal today.
   - b. **`{ options: { mainHandover: 'auto' } }`:** `findAll({ key: 'handover:main' })` has length 0. Fails on the desktop today.
   - c. **`{ options: { mainHandover: 'off' } }`:** length 0. This already passes on the desktop and is kept as a guard.
   - d. **Hidden while writing:** press, then `find({ key: 'handover:main' })` is undefined (the RT:606 body). Fails on the terminal.
   - e. **Queued mid-turn** (the RT:634 body, with `turn.start` hooked): the label goes from `Hand over main` to `Handover queued`. A second press adds no prompt. After `complete($, undefined)` and `advance(10)`, exactly one prompt contains `main-1.md`. Fails on the terminal.
   - f. **The band stays threshold-only:** in ask below the threshold, `AbovePrompt` mounted on the surface has no `handover` key. This is a guard that already passes.
3. The existing RT:606-747 desktop tests stay as they are and green. The duplicated desktop-only "none when off" (RT:741) may be deleted in favour of 2c.

**Implementation:**
- Add `mainButtonShown` to `view.ts`.
- In the Pane hook (R:578+), compute `const shown = mainButtonShown(cfg.mainMode, phase)` and `const queued = await read($, queuedAtom)` **before** the surface branch.
- Desktop: replace `canHandMain` (R:611) with `shown`.
- Terminal: replace R:708 with the D2 header row.
- AbovePrompt is untouched.

**Acceptance:**
- All gates are green, and the count is 95 plus the new tests, 0 failing.
- The pane button is present on both surfaces exactly when `mainHandover` is `ask` and the phase is not `writing` or `clearing`.
- The band's behaviour is byte-for-byte unchanged.
- `$` is passed only to top-level functions in `register.tsx`.

### Task 2: the pane follows the agent in view (CLEAN part of task 2)

**Scope:** `hooks/register.tsx`, `hooks/register.test.ts`. It depends on Task 1 being committed.

**Failing tests to write first** (new `describe('agent in view')`, mounting with `props: { bodyColumns: 100, view: { agentId: 'agent1' } } as never`, after `running($, w)`):
1. **Desktop, viewed and nothing selected:** the `Svg` `props.source` contains `stroke-width="3"`, and `find({ text: /in view/ })` is defined.
2. **Desktop, viewed and the user selects another agent** (spawn a second agent, `agent2`, step it, press `agent:agent2`): the source has exactly one `stroke-width="3"`, on agent2's colour (`seriesColors` gives it `PALETTE[1]`; assert `stroke="#E69F00" stroke-width="3"` per V's attribute order, or just that agent1's path is `opacity="0.3"`). The `in view` text is still on agent1's row (`find({ key: 'agent:agent1' })` text contains `in view`).
3. **Terminal:** `find({ key: 'name:agent1' })!.props.inverse` is `true`, and `name:main` has no `inverse`.
4. **No view, or a view naming an unknown id** (`view: { agentId: 'ghost' }`), on both surfaces: no `in view` text, no `inverse` on any `name:` key, and on the desktop no `stroke-width="3"`.
5. **A view without `agentId`** (`view: {}`, the main conversation): nothing is marked, on both surfaces.

**Implementation:**
- In the Pane hook: `const viewed = liveSelection(rows, e.props.view?.agentId ?? '')`.
- Desktop: `selected: selected || viewed` in `contextChart`. The row Button appends `{viewed === row.id && <Text dimColor> · in view</Text>}`.
- Terminal: the name `Text` gets `key={`name:${row.id}`}` and `inverse={viewed === row.id}`.

**Acceptance:**
- All gates are green.
- Clicking a row still only toggles the highlight; no press changes anything outside the pane.
- No new state keys.

### Task 3: docs

**Scope:** `README.md`, `skills/orchestrated-run/SKILL.md`, and `.claude-plugin/plugin.json`'s `mainHandover.description` only. The version bump is the orchestrator's.

**Content:**
- **README:26:**
  - With `ask` (the default), both the terminal and the desktop pane carry a `Hand over main` button at any time. Past `mainThreshold`, a **Hand over & restart** band also appears above the prompt.
  - With `auto`, the mod acts on its own and shows no button. With `off`, it never acts.
  - `/orch handover main` works in every mode.
  - The queued wording stays.
- **README "Visual":**
  - Terminal list: add "a `Hand over main` button in the header (with `mainHandover: ask`; hidden while main is handing over)" and "the agent you opened from `/tasks` is shown inverted".
  - Desktop list (README:38): "hidden unless `mainHandover` is `ask`, and while main is handing over". Add "the agent open in the main view is marked *in view* and its line highlighted, unless you clicked another".
  - Add one sentence: clicking an agent highlights it in the pane; the host gives mods no way to switch the main view to an agent, so open it with `/tasks` (terminal) or the app's agent panel (desktop).
- **README:43:** the band shows past the threshold in ask mode on both surfaces.
- **plugin.json:24:** `"auto: restart without asking; ask: offer a Hand over main button in the pane, and a band above the prompt past the threshold; off: never."`
- **SKILL.md:**
  - §26 `mainHandover` (`ask` offers a pane button at any time and a band above the prompt past the threshold).
  - §64 the same.
  - §68: the `Hand over main` pane button is on both surfaces in ask mode.

**Acceptance:**
- Nothing in the docs claims more than Tasks 1 and 2 implement. In particular, no claim that clicking switches the main view.
- `claude plugin validate .` is green, with SKILL.md frontmatter and plugin.json valid.

## Escalation options (not planned; need the user's go-ahead)

- **P: CLEAN, both surfaces, a feature the user did not ask for. An agent transcript inside the pane.**
  - What it does: a press on an agent shows its last messages beneath its row, desktop in flow and terminal as a bordered box, from `$.session.messages({ agentId })` (finding 4).
  - Handling: `{ deny }` reads as "transcript not readable (teammate in another pane, or finished)".
  - It needs: a `peekAgent` state key in `types/index.d.ts`, a pure `peekLines(messages, width, n)` in `view.ts`, and tests that stub `on('session.messages', …)`.
  - It ships as 0.3.0.
- **H1: HACKY, terminal.** A press runs `$.command.run({ command: 'tasks' })` to open the background-tasks list, where the person picks the agent. It is untested whether the dialog opens from a plugin run, and it cannot target the agent. Check it by hand before considering it.
- **H2: HACKY, terminal.** Inject the view keystrokes through `$.process.run` (for example `tmux send-keys`, only under tmux). It is brittle and depends on the person's keybindings and terminal. Not recommended.
- **N: NONE, both surfaces.** True click-to-switch needs an engine API, for example a `$.ui.view({ agentId })` op or a writable `SiteView`. Raise it as a feature request with Anthropic. The desktop's agent panel additionally needs the app to honour it.

## How the final reviewer exercises each target

- **Terminal:** `claude --plugin-dir /Users/victorb/code/cc-orchestrator-mod`.
  - With `mainHandover: ask`, `[ Hand over main ]` is in the pane header at low context, and pressing it mid-turn reads `Handover queued`.
  - With `auto` (in `/config`), it is gone.
  - Spawn an agent, open it with `/tasks` → Enter: its pane row is inverted. Back to main: no mark.
- **Desktop** (as in the desktop-target plan, through `CLAUDE_CODE_PLUGIN_DIRS`):
  - The button shows in `ask` and not in `auto`.
  - Open an agent in the app's agent panel: if the app sets `view`, its row shows `· in view` and its line is thick. If not, nothing is marked. Record which in the PR.

## Risks

- **`Pane.view` on the desktop is unverified.** 2.1.295 ships no `.d.ts`, and the type doc mentions only "the tasks list". The mod degrades to no mark (D5's optional chaining, test 4). The manual desktop check records the outcome.
- **A teammate's `view.agentId` might not match our row id** if the host keys teammates differently. T:11882 says it is the `agentId` the loop's events carry, which is what rows use. If the manual check shows a mismatch, fall back to matching `$.agent.list()` (`id` or `teammateId`) in a follow-up.
- **The terminal header becomes a row with a Button.** On a narrow pane the button wraps onto its own line, which costs one row of activity. This is accepted.

## Task 4: in-pane transcript (option P, approved)

The user approved Escalation P: clicking an agent in the Orchestrator pane shows that agent's transcript inside the pane, on both surfaces, read with `$.session.messages({ agentId })` (finding 4). No main-view switching. The *in view* mark (Task 2) stays.

**Scope:** `hooks/view.ts`, `hooks/view.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts` (doc comment only), `README.md`, `skills/orchestrated-run/SKILL.md`. The version bump (0.3.0, D9) stays the orchestrator's.

### Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| P1 | **No new state.** The click selection `selectedAtom` (`selectedAgent`) is the open-transcript target on both surfaces; `toggleSelected` opens and closes it. Only its doc comment in `types/index.d.ts` changes. | One click, one meaning: the desktop's highlight and the transcript are the same selection. The `peekAgent` key the escalation sketched is not needed. |
| P2 | **Pure helper** `peekLines(messages, width, n): string[]` in `view.ts`. It drops messages with no text and no tool use (tool-result-only user rows), keeps the last `n`, and draws each as one line: `role: ` then, when it called tools, `⚙ Read, Bash×2 · ` (counts per tool, in first-use order), then its text with whitespace collapsed; a line longer than `width` is cut with `cut`. Tools come before the text so the cut never hides them. | Testable without mounting; one line per message keeps the terminal row budget exact. |
| P3 | **The read** is a top-level `peekOf($, id, width, n)` in `register.tsx`, called while drawing (reads are allowed there). It answers `{ lines }` or `{ deny }`; a `{ deny }` result or a throw both read as unreadable. | The `$` invariant; a host without the op or a kit with no stub must not break the pane. |
| P4 | **Unreadable** (`deny`): one dim line `transcript not readable (teammate in another pane, or finished)`. **Empty:** one dim line `no messages yet`. | The caller's wording; empty is not an error. |
| P5 | **Main is never peeked.** On the desktop main's row stays a Button (it still highlights its chart line); no transcript is drawn for it. On the terminal main's name is plain Text. | Main is the main view already. |
| P6 | **Desktop:** the transcript is a `Box key="peek:<id>" borderStyle="round"` in flow directly beneath the selected row, `n = 8`, width `cols - 6`, lines `wrap="truncate"`. A second click closes it. | As the activity card already expands in flow. |
| P7 | **Terminal:** each non-main row's name cell becomes `<Button key="agent:<id>" plain onPress={toggleSelected}>` holding the same name `Text` (still `inverse` when in view; `bold` when open). The transcript is a `Box key="peek:<id>" borderStyle="round"` beneath the row, `n = 5`, inner width `cols - 4`. **Room:** an open transcript costs `lines + 2` rows (border), taken from the activity's `room` (floor 3 kept). | Buttons in a terminal pane are supported (plain, Text children). Honest row budget. |
| P8 | A selection naming a row no longer listed opens nothing (`liveSelection`, as for the highlight). | Stale selection guard, unchanged. |

### Failing tests to write first

`view.test.ts`, `describe('peekLines')`:
1. `[]` gives `[]`; a user row with only `toolResults` and no text is dropped.
2. Keeps the last `n` drawable messages, oldest first.
3. Role prefix and collapsed whitespace: `{ role: 'assistant', text: 'a\n  b' }` gives `assistant: a b`.
4. Tool summary before the text: two Bash and one Read give `assistant: ⚙ Bash×2, Read · text`; tools with no text give `assistant: ⚙ Bash×2, Read`.
5. A long line is cut to exactly `width` characters ending in `…`; a short one is untouched.

`register.test.ts`, `describe('agent transcript')`, looped over `terminal` and `desktop` where noted, with `on('session.messages', …)` stubs:
1. (both) No `peek:agent1` until `agent:agent1` is pressed; then its text holds the agent's last message and a tool summary; pressing again removes it. The stub saw `agentId: 'agent1'`.
2. (both) A `{ deny }` answer draws `transcript not readable (teammate in another pane, or finished)`.
3. (both) An empty transcript draws `no messages yet`.
4. (both) A stub that throws reads as not readable; the pane still draws.
5. (terminal) Main has no `agent:main` Button; (desktop) pressing `agent:main` draws no `peek:main`.
6. (terminal) An open transcript takes its rows from the activity: with twelve agents logged, opening a three-message transcript leaves `ROOM - 1 - (3 + 2)` activity lines.
7. The existing terminal `names` helper descends into the row's Button so the in-view `inverse` checks keep passing.

### Async read (follow-up request)

`ui.render` never awaits `$.session.messages`. That supersedes P3's read-while-drawing.
- **Cache:** the pane draws only the cached `peeks` state (`types/index.d.ts`: `Peek = { lines, t } | { denied: true, t }` per agent id), through the pure `peekView(peek, width, n)`. With nothing cached yet it draws a dim `loading…`.
- **Read:** the top-level `refreshPeek($, id)` reads off the render. It is started through `schedulePeek` (`$.clock.after(0, …)`: plugin-authoring's "Work that outlives a dispatch") on:
  - the press that opens a transcript;
  - `turn.step` and `tool.call` from the selected agent;
  - the 30 s sync, so a peek left loading after a reload settles.
- **One at a time:** a module-level in-flight `Set` allows one read per agent.
- **Timeout:** the read races a cancellable `$.clock.after(PEEK_TIMEOUT_MS = 3000)`, cancelled once the race settles. A refusal, a failure or a timeout is stored as `denied`, which draws `PEEK_DENIED`. The agent stays in flight until the read itself settles, so a hung read never has more reads piled behind it.
- **Lines:** stored cleaned, up to 8, each capped at 500 characters (`PEEK_CHARS`); the render cuts them to its width.
- **Rules:** state writes happen only in presses, events and timers, never while drawing. The Hand over buttons never wait on a read.
- **Tests:** `describe('transcript read off the render')` in `register.test.ts` covers four cases. Each failed first by timing out because the render awaited the read.
  - (a) a read that never answers blocks neither the pane nor Hand over / Hand over main (both surfaces);
  - (b) `loading…` then the lines;
  - (c) past the timeout, the not-readable line;
  - (d) triggers during an in-flight read make one call.

  Plus `peekView` in `view.test.ts`. The earlier transcript tests now settle the clock after the opening press.
