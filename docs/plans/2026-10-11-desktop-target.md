# Desktop app target for the orchestrator mod

Date: 2026-10-11 · Branch: `desktop-target` · Engine: Claude Code 2.1.296

## Goal

The mod works in the Claude Code desktop app (the `desktop` surface) as well as the terminal. On the desktop it gets a GUI version of the Orchestrator pane: a vector chart, native buttons, click-to-select and click-to-expand. The terminal's behaviour and drawing stay as they are. Monitoring, handover, respawn and main-thread restart are shared, not duplicated.

## Baseline (before any change)

| gate | result |
| --- | --- |
| `claude plugin test .` | 50 pass, 0 fail, 2 files (`hooks/core.test.ts`, `hooks/register.test.ts`) |
| `claude plugin validate .` | ✔ Validation passed (marketplace, manifest, contract, hooks) |
| `npx -p typescript@5.6.3 tsc -p .` | exit 0, no diagnostics |

## API facts this plan rests on (with sources)

Sources:
- **S**: the plugin-authoring skill's SKILL.md (loaded through the Skill tool).
- **R**: `…/plugin-authoring/reference.md`.
- **T**: `…/plugin-authoring/types/claude-code.d.ts`, written by Claude Code 2.1.296. The same file sits in the repo as `.claude-plugin/types/claude-code/index.d.ts`. Line numbers below are in T.

1. **There is no per-target manifest switch.** A mod is one hooks module. It branches at draw time on `e.surface`, which is one of `'terminal' | 'desktop' | 'mobile' | 'vscode'` (`RenderSurface`, T:10388; S "A mod in one paragraph"; R "Drawing: ui.render"). Elements come from `$.ui.resolve(e)`, and narrowing `e.surface` narrows the table (T:3800-3870). A session can draw on several surfaces at once. Each surface asks for its own render (T:10377-10387; `$.session.surfaces()`, T:2812-2823). **Consequence:** `plugin.json`, `marketplace.json`, `hooks.json` and `tsconfig.json` need no target declaration.
2. **Element tables** (`Elements`, T:3803-3866):
   - **terminal:** Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image.
   - **desktop:** Box, Text, Button, Input, Select, **Svg**, Link, Code, Markdown, Client.
   - **vscode:** the desktop's table without Client.
   - **mobile:** Box, Text, Button, Svg, Link, Code, Markdown.

   A tree that holds an element the surface lacks is refused, and the engine draws its own (R "Drawing"; T:9648-9660). So **Svg must never reach the terminal, and Raster/Image must never reach the desktop.**
3. **Svg** (`SvgProps`, T:12273-12306) is the remote surfaces' vector leaf:
   - Props: `source` (at most 131,072 characters), `alt` (required), `width` and `height` in CSS px, and `isInteractive`.
   - With `isInteractive: true` it is drawn in a script-less sandboxed frame, so CSS `:hover` and `<title>` tooltips work. Script and event attributes are stripped.
   - It has no children and no press. A press goes on an enclosing or sibling Button.
4. **Where each component is raised** (`RenderComponentProps`, T:10255-10368):
   - `Pane` on **every** surface. Its props are `title`, `isFocused`, `bodyColumns`, `placement: 'dock'|'inline'`, `scroll` and `view`.
   - `AbovePrompt` on **terminal and desktop only**.
   - `Spinner`, `SessionMode` and `PromptHint` on terminal and desktop. `TurnDuration` and `InfoNotice` on the terminal only.
5. **Box and Text are drawn on every surface.** The terminal draws them with Ink; the desktop draws "a flex div and a styled span". `hover` on a keyed Box, and `position: "absolute"`, are surface-applied style data with no hook (T:907-990, T:12210-12245). A Button is "a native button" on the desktop. `variant` and `role="dismiss"` are drawing hints (T:1063-1135; R "Drawing").
6. **The viewport on a remote surface** is measured in cells of its code font, "cell-based until the first element lays out in pixels" (`RenderViewport`, T:10390-10425). `Pane.bodyColumns` is present on every surface. `viewport.isFullscreen` is absent until the client reports it.
7. **Status line, toasts and notifications:**
   - `$.ui.status` and `$.ui.toast` are drawn remotely too: up to 10,000 characters there, 2,000 on the terminal (T:2405-2480).
   - `$.ui.notify` answers `no-surface` where the session holds no terminal: "a -p run, the SDK, **the desktop**" (R "Work that outlives a dispatch"; T:14085-14115). The mod's stall path already toasts through `log(…, 'warn')`, so a desktop user still sees it.
8. **Panes:** `$.ui.open` places a pane on a remote surface that reports it places panes. It resolves `{ isPlaced }` (T:2484-2505, T:14120-14165).
9. **Commands:** `$.command.register` and `command.run` are engine-side (T:3063-3098). R ("Sharing a mod") records only that `/plugin install` itself is unavailable in a desktop-started local session. Whether the desktop's prompt lists plugin commands is not documented. **Decision:** keep `/orch`, and put the actions that matter on the desktop pane as buttons, so the desktop never depends on a slash command.
10. **Tests** (R "Developing one"; T header lines 30-58, T:15070-15740):
    - `claude plugin test <dir>` runs `*.test.ts` against the engine.
    - `$.ui.mount({ plugin, surface, component, requestId, props })` draws through the plugin on the named surface. It **rejects when the tree does not validate for that surface's table**.
    - The handle offers `find`, `findAll`, `drawn`, `press({ key })` and `unmount`. `FoundElement` gives `{ type, key, props, text, children }`.
    - The docs recommend looping one body over `['terminal', 'desktop'] as const`.
    - The kit checks trees, never a surface's paint, so visuals need a manual check (below).
11. **Types:** `.claude-plugin/types/` is laid by the engine whenever it loads the mod from a hot-reloaded `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS` folder or the mods folder (S "WHERE THE TYPES ARE"; R "The types are the reference"). It is git-ignored here and present on disk. `tsc -p .` reads it through `tsconfig.json`'s `include`. State keys are declared in `types/index.d.ts` under `interface PluginState`, and `claude plugin validate` holds every `$.state` key to that contract (S).
12. **Running in each target:**
    - **Terminal:** `claude --plugin-dir <folder>`.
    - **Desktop:** the desktop app starts sessions with no CLI flag, so name the folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Optionally add `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` so the long-lived desktop session hot-reloads; reload lines then reach the host as `ui_log`.
    - **Desktop, alternative:** `claude plugin marketplace add <folder>`, then install at user scope from a terminal. "A mod installed from a terminal at the user scope loads in that local session too, and its `ui.render` hooks draw for the `desktop` surface", and `/reload-plugins` re-reads the folder (R "Developing one", "Sharing a mod").
    - Refused trees are logged as `ui.render (<Component>): a hook returned a tree that does not validate` in the debug log (`claude --debug`).
13. **Repo constraint** (README "Develop", learned in this repo, not in the docs): the engine lets `$` be passed only to functions declared at the top level of the hooks module. **Consequence:** everything that touches `$` stays in `hooks/register.tsx` as top-level functions. Everything pure goes to `hooks/core.ts` or a new pure module.

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | One hooks module. The `Pane` hook branches on `e.surface`: `'terminal'` draws today's tree unchanged; every other surface (`desktop`, `vscode`, `mobile`) gets the GUI tree. | All three remote surfaces have Svg, Box, Text and Button, and the GUI tree uses nothing else. Sharing it costs nothing. AbovePrompt is raised on the desktop and the terminal only, and it already uses only Box, Text and Button, so it stays one tree for both. |
| D2 | All monitoring, handover, respawn, restart, persistence, status and toasts stay as they are, shared. Only drawing is per surface. | Fact 1: the logic is surface-agnostic events. |
| D3 | The pure drawing logic goes in a new **`hooks/view.ts`**: the chart SVG builder, series colours, the header text and the log ids. `core.ts` is not touched. | Keeps file scopes disjoint for parallel tasks. Pure code is unit-testable without mounting. |
| D4 | **Desktop chart:** one `Svg` (`isInteractive: true`) with a step-after line per agent on a shared time axis, threshold lines dashed in red, and a `<title>` tooltip on each line and on its last point (name, context/limit, status). | It is the richer version of the terminal's per-row timeline, and the tooltips are the native hover affordance. Step-after is used because context holds between requests. |
| D5 | **Desktop agent list:** one row per agent in `orderRows` order, indented `paddingLeft = depth*2`. Each row is a plain `Button` (key `agent:<id>`) that holds: a `●` swatch in the agent's series colour; the label; `tokens/ceiling pct%` coloured by `level` (success/warning/error); and the status, dimmed. A press selects the agent (new state `selectedAgent`), and its line is drawn thick while the others fade. Pressing it again clears the selection. | The click links list and chart. The colour swatch makes a separate legend unnecessary. |
| D6 | **Desktop actions as buttons:** a `Hand over` Button (key `handover:<id>`, `variant="secondary"`) beside each **live subagent** (`running` or `idle`), always visible, not hover-revealed. A header Button `Hand over main` (key `handover:main`), shown unless `mainHandover` is `off` or the phase is `writing`/`clearing`. | Fact 9: the desktop must not rely on `/orch`. Always visible because mobile has no hover. Same functions as `/orch handover`. |
| D7 | **Desktop activity log:** the last 50 entries. An entry that fits `bodyColumns - 6` is a Text. A longer one is a plain `Button` keyed `logId(entry)`, showing the same `hh:mm` and the text cut with `…`. A press toggles `pinnedLog`, and while pinned the full text is drawn inline in flow beneath it: a `Box` with `borderStyle="round"` holding `Text wrap="wrap"`, key `full:<logId>`. No absolute overlay and no cell-padding on the desktop. | A GUI reflows naturally. The terminal's overlay and `wrapFill` padding exist only because Ink paints cells. The native button hover is the hover affordance. `pinnedLog` is session state shared by both surfaces, so a pin shows on both. That is accepted. |
| D8 | **Terminal:** the drawing does not change. The terminal header switches to the shared `paneHeader(...)` string, which produces exactly today's text. | One source for the header, and no visible change. |
| D9 | **Chart sizing:** Svg `width = clamp(bodyColumns*8, 320, 1200)` CSS px and `height = 180`. The markup's `width`, `height` and `viewBox` match. | Fact 6: only cells are known. 8 px per cell approximates the code font. Explicit sizes are deterministic and testable. |
| D10 | **Colours:** main `#6B7280`. Other agents in tree order cycle `#0072B2, #E69F00, #009E73, #CC79A7, #56B4E9, #D55E00` (Okabe-Ito: colour-blind safe, readable on light and dark). Limit line `#DC2626`, dashed `4 3`. Axis text and lines `#6B7280`, `font-family: system-ui, sans-serif`, `font-size: 10`. | An SVG drawn as an isolated image cannot read the theme. Mid-tones work on both themes. |
| D11 | **SVG size bound:** each series is downsampled to at most `floor(plotWidth/3)` points (the peak per time bucket). A test proves that 60 agents × 180 samples stays under 131,072 characters. | Fact 3's limit: past it the tree is refused. |
| D12 | `/orch`, the status line, toasts and notify are left as they are. | Facts 7 and 9. |
| D13 | No change to `plugin.json`, `marketplace.json`, `hooks.json` or `tsconfig.json`. The version bump is done by the orchestrator at the end. | Fact 1. `tsconfig` already includes `hooks/` and `types/`. |

## Architecture

```
hooks/core.ts      (unchanged) context math, recordStep, orderRows, level, fmtTokens, prompts, roster, wrapFill
hooks/view.ts      (NEW, pure) paneHeader, seriesColors, logId, chartWidthPx, contextChart (SVG string + alt)
hooks/register.tsx events + state (unchanged logic)
                   ui.render Pane → e.surface === 'terminal' ? today's tree : GUI tree (Svg + rows + activity)
                   ui.render AbovePrompt → one tree for terminal and desktop (unchanged)
types/index.d.ts   + selectedAgent: string
```

### `hooks/view.ts`: exact exports (Task 1 implements these; Task 2 codes against them)

```ts
import type { AgentRow, LogEntry, MainPhase } from '../types'

export const MAIN_COLOR = '#6B7280'
export const PALETTE: readonly string[] = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00']
export const LIMIT_COLOR = '#DC2626'

/** Today's terminal header, verbatim:
 *  `${live} live · ${replaced} handed over · limits ${fmt(agentThreshold)} / main ${fmt(mainThreshold)} (${mainMode}${phase !== 'idle' ? `, ${phase}` : ''})`
 *  live = subagents with status running|idle|handing-over; replaced = subagents with status replaced. */
export const paneHeader = (
  rows: readonly AgentRow[],
  o: { agentThreshold: number; mainThreshold: number; mainMode: string; phase: MainPhase },
) => string

/** main → MAIN_COLOR; every other row in orderRows order → PALETTE[i % PALETTE.length]. */
export const seriesColors = (rows: readonly AgentRow[]) => Map<string, string>

/** `log-${t}-${text.length}`: the id the terminal card already uses. */
export const logId = (l: LogEntry) => string

/** clamp(bodyColumns * 8, 320, 1200) */
export const chartWidthPx = (bodyColumns: number) => number

export type ChartInput = {
  rows: readonly AgentRow[]
  now: number
  width: number   // CSS px
  height: number  // CSS px
  agentThreshold: number
  mainThreshold: number
  colors: ReadonlyMap<string, string>
  selected?: string // agent id; '' or undefined = none
}
export const contextChart = (i: ChartInput) => { source: string; alt: string; width: number; height: number }
```

**`contextChart` spec:**

- **Root:** `<svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 W H" role="img">`.
- **Plot area:** margins left 44, right 8, top 8, bottom 20.
- **Axes:**
  - `t0 = min(startedAt of rows, now)`, `t1 = now`, `span = max(1, t1 - t0)`.
  - `yMax = max(agentThreshold, mainThreshold, max peak) * 1.05`.
- **Limit lines:** dashed (`stroke-dasharray="4 3"`, `LIMIT_COLOR`), one per distinct threshold.
  - Equal thresholds: one line, labelled `limit <fmt>`.
  - Different thresholds: two lines, labelled `agent limit <fmt>` and `main limit <fmt>`.
  - Each label is a `<text>` at the left margin.
- **Axis labels:** y labels `0` and the label above. x labels are the `hh:mm` of t0 at the left and of t1 at the right, where `hh:mm = new Date(t).toISOString().slice(11, 16)`, as the terminal does.
- **One series per row with ≥ 1 sample, none for a row without:**
  - **Path:** `<path d="M x0 y0 H x1 V y1 …" fill="none" stroke="<color>" stroke-width="1.5|3" opacity="1|0.3">`. The path is step-after.
  - **Live tail:** a live row (running, idle or handing-over) extends with `H <right edge>`. A settled row stops at its last sample.
  - **Selection:** with `selected` set, the selected series has `stroke-width="3"` and every other has `opacity="0.3"`. With no selection, all are `stroke-width="1.5"` and `opacity="1"`.
  - **Last point:** a `<circle r="3">` on the last sample.
  - **Tooltips:** the path and the circle each hold `<title>${label} · ${fmt(tokens)} / ${fmt(ceiling)} · ${status}</title>`, where the ceiling is `mainThreshold` for main and `agentThreshold` otherwise.
  - **Downsampling:** to `floor(plotWidth/3)` points, keeping each bucket's peak at that sample's time. The first and last samples are kept.
- **Escaping:** every interpolated text (label, status) is XML-escaped (`& < > " '`).
- **alt:**
  - With series: `Context over time: ` + `${label} ${fmt(tokens)} of ${fmt(ceiling)}` for each series in order, joined by `; `.
  - With none: `No model requests yet.`

### Desktop pane tree (Task 2), top to bottom

1. **Header:** a `Box` (row, wrap) holding a bold `Text` with `paneHeader(...)`, plus `Button key="handover:main" variant="secondary" label="Hand over main"` (per D6). The press runs `startMainHandover($)` through `$.clock.after(0, …)`, as `/orch handover` does.
2. **Chart:**
   - With no rows: `<Text dimColor>No model requests yet.</Text>`.
   - Otherwise: `<Svg key="chart" isInteractive source alt width height />` from `contextChart({ …, width: chartWidthPx(cols), height: 180, colors: seriesColors(rows), selected })`.
3. **Agents:** per `orderRows` entry, a `Box key={`row:${id}`}` with `paddingLeft={depth*2}` holding:
   - the `Button key={`agent:${id}`} plain` from D5, whose press runs `update($, selectedAtom, s => s === id ? '' : id)`;
   - for a live subagent, the `Button key={`handover:${id}`} variant="secondary" label="Hand over"`, whose press runs `startHandover($, id, 'from the pane')`.
4. **Activity:** a bold `Text` reading `Activity`, then the D7 entries (last 50), or `<Text dimColor>Nothing yet.</Text>`.

`cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80`, as today. All `$`-using functions (the selection toggle, the handover presses) stay top-level in `register.tsx` (Fact 13).

## Dependent artefacts

| artefact | change | task |
| --- | --- | --- |
| `hooks/view.ts` | new: pure view and chart functions | 1 |
| `hooks/view.test.ts` | new: unit tests | 1 |
| `hooks/register.tsx` | Pane branches on surface; GUI tree; terminal header via `paneHeader`; `selectedAtom`; top-level `toggleSelected` | 2 |
| `hooks/register.test.ts` | desktop and remote-surface pane tests; AbovePrompt over both surfaces | 2 |
| `types/index.d.ts` | add `selectedAgent: string` to `PluginState.orchestrator` | 2 |
| `README.md` | the "Visual" section split into Terminal and Desktop app; desktop install/run (env var, marketplace route); commands note | 3 |
| `skills/orchestrated-run/SKILL.md` | §3 "Tools" and §4: the pane works in the desktop app with buttons for handover; `/orch` stays for the terminal | 3 |
| `.claude-plugin/plugin.json`, `marketplace.json`, `hooks/hooks.json`, `tsconfig.json`, `hooks/core.ts`, `hooks/core.test.ts` | **no change** (D13; `core.ts` untouched per D3) | none |

## Tasks

TDD is mandatory for Tasks 1 and 2: write the failing test first, watch it fail, implement, watch it pass. Pass this rule on to any sub-agent. Task 3 is content, so it is exempt.

**Ordering:**
- Task 1 and Task 3 start at once, in parallel. Their scopes are disjoint.
- Task 2 depends on Task 1's exports. It may write its failing tests immediately against the signatures above, but it reaches green only once Task 1 is committed. The orchestrator commits Task 1 first.

All gates for every task:
```
claude plugin test .
claude plugin validate .
npx -p typescript@5.6.3 tsc -p .
```

### Task 1: pure view and chart module

**Scope:** `hooks/view.ts` (new), `hooks/view.test.ts` (new). Touch nothing else.

**Failing tests to write first** (in `hooks/view.test.ts`, importing from `./view` and building rows with a local `row()` fixture like `core.test.ts`'s):
1. `paneHeader`, for main plus 2 running, 1 replaced and 1 done subagent, with thresholds 450k/300k, `mainMode` `ask` and phase `offered`, equals `2 live · 1 handed over · limits 450k / main 300k (ask, offered)`. With phase `idle` it ends `(ask)`.
2. `seriesColors`: main maps to `MAIN_COLOR`. Subagents get `PALETTE[0]`, `[1]`, … in `orderRows` order (a child under its parent). The 7th subagent wraps to `PALETTE[0]`.
3. `logId({ t: 5, text: 'abc', level: 'info' })` equals `log-5-3`.
4. `chartWidthPx(10)` is 320, `chartWidthPx(100)` is 800 and `chartWidthPx(500)` is 1200.
5. `contextChart` root: the source starts with `<svg`, contains `viewBox="0 0 640 180"` for width 640 and height 180, and returns `width: 640, height: 180`.
6. One `<path` per row with samples. A row with no samples adds none.
7. Step-after geometry: a settled row with samples at t0 and at t0 + span/2 ends its path at x = 44 + plotW/2 (rounded as implemented). A live row's path ends at x = W − 8.
8. Selection: with `selected: 'a1'`, a1's path has `stroke-width="3"` and the other path has `opacity="0.3"`. Without it, no `opacity="0.3"` appears.
9. Limits: equal thresholds give exactly one `stroke-dasharray` and the text `limit 450k`. Different thresholds give two, with `agent limit` and `main limit`.
10. Escaping: a row named `a<b & "c"` puts `a&lt;b &amp; &quot;c&quot;` in its `<title>`, and the source contains no `<b `.
11. Bound: 60 agents with 180 samples each gives `source.length < 131072`, and each path has at most `floor((640-52)/3) + 2` points.
12. alt: two agents yield `Context over time: impl-1 300k of 450k; main 20k of 450k` (in series order). No rows yield `No model requests yet.`

**Acceptance:**
- Every export matches the signatures in "Architecture" exactly.
- Pure: no `$` and no `claude-code` runtime import, only `import type` and imports from `./core`.
- All gates are green, and the test count rises by the new tests with 0 failing.

### Task 2: per-surface pane rendering and wiring

**Scope:** `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts`. Depends on Task 1.

**Behaviour:**
- `types/index.d.ts` gains `selectedAgent: string` in `PluginState.orchestrator`. `register.tsx` adds `const selectedAtom = atom({ plugin: 'orchestrator', key: 'selectedAgent' } as const, '')`.
- The Pane hook reads the state as today.
  - **Terminal** (`e.surface === 'terminal'`): returns today's tree byte-for-byte, except that the header `Text` child becomes `paneHeader(rows, { agentThreshold: cfg.agentThreshold, mainThreshold: cfg.mainThreshold, mainMode: cfg.mainMode, phase })`, which is the same text. The terminal card id uses `logId(l)`, the same string.
  - **Any other surface:** returns the desktop tree from "Desktop pane tree". Narrow on `e.surface` so `Svg` is typed. Never emit `Svg` on the terminal, and never `Raster`/`Image` elsewhere.
- New top-level `toggleSelected($, id)`. The per-row handover press calls the existing top-level `startHandover($, id, 'from the pane')`. The header button calls `$.clock.after(0, () => void startMainHandover($))`.
- The AbovePrompt hook is unchanged, and so are all event hooks and `/orch`.

**Failing tests to write first** (in `register.test.ts`, new `describe('desktop pane')`, reusing `world`, `start`, `spawn`, `step` and `complete`, and mounting with `requestId: 'orchestrator'`, `props: { bodyColumns: 100 }`):
1. Desktop draws a chart and the terminal does not. On `desktop`, `find({ type: 'Svg' })` is defined, its `props.alt` contains `impl-1` and `300k`, and `props.isInteractive` is `true`. On `terminal`, `findAll({ type: 'Svg' })` has length 0 and `findAll({ key: 'handover:agent1' })` has length 0.
2. Selecting: pressing `agent:agent1` on desktop makes the Svg `props.source` contain `stroke-width="3"`. Pressing it again leaves the source with no `stroke-width="3"`.
3. Handing over from the pane: with a running agent1, `handover:agent1` exists. Pressing it sets `row(w,'agent1').status` to `handing-over`. Once agent1 is `done` (complete twice with no note, as in the existing test), no `handover:agent1` button is drawn.
4. Main from the pane: pressing `handover:main`, then `w.clock.advance(10)`, makes `w.prompts[0]` contain `main-1.md`. With `{ options: { mainHandover: 'off' } }` no `handover:main` is drawn.
5. Activity expand: with the long-name spawn from the existing hover test at `bodyColumns: 40` on desktop, the entry Button's text contains `…`. `find({ key: 'full:' + itsKey })` is undefined until it is pressed, then defined with the full name in its text, and undefined again after a second press. The desktop tree has no Box with `props.position === 'absolute'`.
6. Remote surfaces: mounting the Pane on `vscode` and on `mobile` resolves (no refusal), and each holds an `Svg`.
7. The AbovePrompt ask-mode test (`main thread` › `in ask mode offers…`) loops its mount and press over `['terminal', 'desktop'] as const`, re-arming between iterations. The simplest form: one fresh `world` per surface inside a `for` that builds a new test per surface.
8. The existing tests stay unmodified and green: `pane` › charts, the hover card and `/orch` close/handover.

**Acceptance:**
- All gates are green, and `claude plugin validate .` lists `orchestrator.selectedAgent` among the state reads and writes.
- The terminal tests are untouched and still pass.
- No `$` is passed to any function that is not top-level in `register.tsx`.
- No logic is duplicated between the two trees beyond JSX: header, colours, ids and chart come from `view.ts`, and the threshold/level maths from `core.ts`.

### Task 3: docs

**Scope:** `README.md`, `skills/orchestrated-run/SKILL.md`.

**Behaviour (content):**
- **README, "Visual":** split it into *Terminal* (today's text) and *Desktop app*:
  - the interactive chart, with tooltips on hover;
  - click an agent to highlight its line;
  - `Hand over` buttons per live agent and `Hand over main`;
  - click a long activity line to expand it.

  Also note:
  - the status line and toasts show on both;
  - the stall notification falls back to a toast on the desktop;
  - the Hand over & restart band above the prompt shows on both;
  - VS Code and mobile get the desktop pane.
- **README, Install:**
  - add "In the desktop app". A plugin installed at user scope from a terminal (`/plugin install …`) loads in the desktop app's local sessions too; `/plugin install` itself is not available in the desktop.
  - add "Run a checkout in the desktop app": `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-orchestrator-mod" }` in `~/.claude/settings.json` (optionally `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"`), then restart the app.
- **README, Commands:** note that on the desktop the pane's buttons do what `/orch handover` does.
- **README, Develop:** mention `hooks/view.ts` (pure drawing logic shared by both surfaces).
- **SKILL.md:** in §3 "Tools", add that in the desktop app the pane carries `Hand over` buttons and `/orch` is optional. In §4, add that the pane is the cheap progress check in the desktop too.

**Acceptance:**
- The wording matches the decisions above; nothing in the docs claims behaviour that Tasks 1 and 2 do not implement.
- `claude plugin validate .` is green: SKILL.md frontmatter is intact.

## How the final reviewer exercises each target

**Automated:** run the three gates. The test files mount the Pane on `terminal`, `desktop`, `vscode` and `mobile`, and AbovePrompt on `terminal` and `desktop`.

**Terminal:**
1. Run `claude --plugin-dir /Users/victorb/code/cc-orchestrator-mod --debug`.
2. In `/config`, set `agentThreshold` to 30000, `mainThreshold` to 60000 and `mainHandover` to `ask`.
3. Ask Claude to spawn two named background agents that read several files each.

**Check:**
- The pane opens on the first spawn and looks as before (tree, block timeline, activity, hover card and click pin).
- The status line and the band above the prompt work.
- The debug log has no `ui.render (Pane): … does not validate` line.

**Desktop app:**
1. Add `"CLAUDE_CODE_PLUGIN_DIRS": "/Users/victorb/code/cc-orchestrator-mod"` and `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` to the `env` block of `~/.claude/settings.json`, then restart the desktop app. Remove both afterwards.
2. Open a local Code-tab session on the repo, with the same low thresholds (`pluginConfigs.orchestrator.options` in settings, since there is no `/config` menu in the app).
3. Spawn two agents as above.

**Check:**
- The pane shows the SVG chart, sized to the pane, with tooltips on hover.
- Clicking an agent row thickens its line, and clicking again clears it.
- `Hand over` on a live agent moves it to handing-over, then replaced, with a respawn.
- `Hand over main` writes a note, clears and resumes.
- A long activity line expands on click.
- The band above the prompt appears past `mainThreshold`.
- The status line and toasts show.
- No refusal lines appear in the session's log.

**Alternative desktop route:** run `claude plugin marketplace add /Users/victorb/code/cc-orchestrator-mod`, then `claude plugin install orchestrator@cc-orchestrator-mod` (user scope) in a terminal, and `/reload-plugins` after edits.

## Risks

- **Desktop pixel metrics are approximate (D9).** The chart may be narrower or wider than the pane by a little. This is only visible in a manual check; the test kit never paints.
- **Plugin slash commands may not be listed in the desktop prompt (Fact 9).** This is mitigated by the pane buttons (D6).
- **Fact 13 is empirical, not documented.** If a GUI helper outside `register.tsx` takes `$`, the module may be refused at load, and `claude plugin validate` would show it.
- **`pinnedLog` is shared across surfaces (D7).** A pin on one surface shows on the other. This is accepted.
- **The SVG's mid-tone colours (D10)** cannot follow the person's theme, because an isolated image gets no theme tokens.
