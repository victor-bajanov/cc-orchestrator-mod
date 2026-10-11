# orchestrator: a Claude Code mod for long agent runs

This mod watches every agent loop in a session, hands it over before its context runs out, and charts what it is doing. It ships the `orchestrated-run` skill, rewritten so the mod handles context limits and the main session no longer polls transcripts.

## What it does

**Monitoring.** Every model request, from the main thread and from subagents at any depth, reports its token usage through `turn.step`. The mod records each agent's context size (input + cache-write + cache-read) over time. No transcript files are polled.

**Subagent handover.** When a subagent crosses `agentThreshold` (default 450k):

1. The mod gives it `HANDOVER` with a note path under the run folder's `handover/`. While the agent works, the HANDOVER rides on its next tool result. A message would do no good there: a named agent (a teammate) reads its inbox only between turns. An idle agent, or one that ends its turn before another tool call, is sent the HANDOVER as a message, which wakes it.
2. When the agent ends with that note written, the mod spawns a replacement. The replacement gets the original brief, the same type, model and name, plus "start from the handover note at …". The engine suffixes a teammate's name while the original holds it (`probe` → `probe-2`); the mod reads the real name back.
3. The mod tells the old agent's parent about the swap, with the replacement's id and SendMessage name. A parent agent gets a message; the main thread gets a note in its conversation. The note says no action is needed, so the parent doesn't spawn a second replacement.
4. When a replacement's original parent was the main thread, the mod forwards the replacement's final report there. A teammate's final report already reaches it, so that one isn't forwarded.

If the agent ends again without writing its note, it is marked `done` and not respawned. If it hasn't handed over within 20 minutes, it is marked `stalled` and you get a notification (a toast in the desktop app); when a stalled agent's run does end, the mod settles it as any other: replaced if the note is there by then, `done` if not. A replacement whose first reading is already at half the threshold or more (its brief and note alone fill the window) is left to run and you get a warning, so handovers can't loop.

**Resumed agents.** A finished agent that is messaged again resumes: its row goes back to `running` and carries a dim `↻`.

**Check-ins.** The mod registers a tool, `mcp__orchestrator__checkin { agent, minutes }`, listed in the prompt's tools rather than behind ToolSearch. A parent calls it after spawning a child: the main thread, or any subagent (a subagent orchestrator with the default tools can call it; one whose definition restricts `tools` needs `mcp__orchestrator__checkin` added to that list, which is untested). It calls it naming the child by name or id, with its estimate of the child's task plus a buffer. It works only on the caller's own children, which include the children of an agent the caller replaced. Calling it again re-arms it; `minutes` of 0 or less cancels it. If the child hasn't reported by then, the check-in fires once: the mod wakes the parent with a message, `[orchestrator mod] check-in: <name> (id …) has not reported after N min; status …, last active hh:mm. Check on it, or call checkin again to re-arm.` A check-in set by the main thread arrives as a prompt that wakes it, plus a toast, and one set by an orchestrator that has since handed over goes to its replacement. It is disarmed when the child sends its parent a SendMessage or ends its run. A SubagentHandback doesn't count: it may reach main rather than the parent. The deadline is kept in `state.json`, so it survives a reload.

**Auto-forwarded reports.** A background subagent's final answer doesn't reach its parent agent on its own. At the end of each of a child's runs, the mod forwards its final answer to its parent agent (`[orchestrator mod] final report of <name> (id …), auto-forwarded:`), which wakes it; if the parent has handed over, the answer goes to its replacement. It skips the forward when the child's last act in that run was a delivered SendMessage report to its parent, or when a report it delivered says the same as the answer. Otherwise it forwards, because a lost report costs more than a duplicate; when the child did send something that run, the forward says `(may duplicate a message it sent you)`. It never forwards to the main thread (the engine already tells main), for teammates (their answers arrive anyway), for an aborted or failed run or an empty answer, or for a HANDOVER. A foreground agent's answer is its parent's tool result, so it isn't forwarded either, except a mod-spawned replacement's, which is always forwarded under the same per-run check. So a grandchild's report goes to its orchestrator, not to main.

**Some messages wait for an agent's turn to end.** In this engine, a run that a mod wakes from a timer, or from inside its `tool.call` or `turn.step` hook, misses some of the mod's hooks: the agent may be unable to call `checkin`, or the mod may lose track of its context (see `docs/engine-bug-timer-hooks.md`). Only a send made from `turn.complete` is safe. So the mod queues the two messages that would otherwise be sent from those places, check-in wake-ups and a HANDOVER message to an idle agent (state key `outbox`), and sends them at the next `turn.complete` of any agent. If the queue survives a sync while main is idle, and nothing has drained it since the last nudge, the mod submits one short `[orchestrator mod] queued messages…` prompt to main, whose turn's end sends them. So these can arrive a little late, and main may see that short prompt. Auto-forwarded reports and respawns already run from `turn.complete`, and the pane's `Hand over` button and `/orch handover` send at once, so none of those are delayed.

**HANDOVER clause.** Every Agent call has the cold-restart clause appended to its prompt (`injectClause`), so orchestrators no longer have to paste it into each brief.

**Main-thread restart.** When the main thread crosses `mainThreshold`:

1. It writes a handover note.
2. The mod runs `/clear`.
3. The mod submits a fresh prompt containing the note, the live agents (name, id, type, status, context) and the roster path.

Running agents survive `/clear`. This prompt is how the new context learns about them. With `mainHandover: ask` (the default), the pane carries a `Hand over main` button at any time, on the terminal and in the desktop app; past `mainThreshold`, a **Hand over & restart** band also appears above the prompt. With `auto` the mod acts on its own and shows no button. With `off` it never acts. `/orch handover main` works in every mode. If you ask for a handover mid-turn (with either button or `/orch handover`), it waits and starts when the turn ends, even a stopped one; meanwhile the buttons read "Handover queued". After a restart, the mod doesn't offer again until the main context has read below the threshold once.

**Visual.** The **Orchestrator** pane opens on the first spawn, or with `/orch`. In the desktop app it also opens on the first spawn, but `/orch` may not be listed in the desktop prompt.

*Terminal.* The pane has:
- a `Hand over main` button in the header (with `mainHandover: ask`; hidden while main is handing over)
- a tree of agents (main, then each agent under its parent); the agent you opened from `/tasks` is shown inverted
- each row's status glyph and status word in the status colour: running `●` bright green, waiting `◐` teal, idle `○` faint orange, handing over `↻` blue, stalled `!` red, done `✓` faint green, replaced `⤳` grey. The colours are theme keys, so they follow your theme
- each row's model and effort, such as `Sonnet 5.5 med` (the model alone when the engine reports no effort)
- click a subagent's name to show its transcript in a box beneath it: its last six entries, each with its time. A long entry ends in `…`; hovering it shows the full text in a card, and a click pins it open. Click the name again to close the box. The box takes its rows from the activity log
- double-click a row with children (main included) to collapse its finished descendants into `+N done`; double-click again to expand them
- each agent's context drawn on one shared time axis, so you can see when each agent was active and how close it is to its limit (green, then amber from 60%, red at the threshold)
- an activity log; a line too long for the pane ends in `…`, and hovering it shows the full text in a card (a click pins it open)

*Desktop app.* The pane has:
- a chart of each agent's context over time, one coloured line per agent, with the limits as dashed red lines; hover a line for the agent's name, context and status
- a tree of agents, each with its colour, model and effort (such as `Sonnet 5.5 med`), context, and a status emoji before the status word: running 🏃‍♂️ or 🏃‍♀️ (fixed per agent), waiting ⏳, idle 😴, handing over 📝, stalled 🛑, done ✅, replaced ♻️
- click an agent to highlight its line in the chart and show its transcript beneath it: its last twelve entries, each with its time, a long one ending in `…` that a click expands in place. Click again to clear both (the agent in view stays highlighted)
- double-click a row with children to collapse its finished descendants into `+N done`, and their lines leave the chart; double-click again to expand them
- the agent open in the main view is marked *in view* and its line highlighted, unless you clicked another
- a `Hand over` button beside each live subagent, and a `Hand over main` button in the header (hidden unless `mainHandover` is `ask`, and while main is handing over)
- an activity log; a line too long for the pane ends in `…`, and clicking it expands the full text beneath it

VS Code and the mobile app get the desktop pane.

Clicking a subagent shows its transcript inside the pane, read through the host's own transcript API. Main has none there, since it is the main view already. The box says `loading…` until the first read comes back, and it updates as the agent works. A teammate running in another pane's process, or a finished agent whose transcript was not saved, can't be read; the box says "transcript not readable (teammate in another pane, or finished)". The host gives mods no way to switch the main view to an agent, so to read a whole transcript open it with `/tasks` (terminal) or the app's agent panel (desktop). Each entry is a message's text (`» ` marks the agent's instructions) or one tool call, `⚙ <Tool> <command, path or pattern>`, with a red `✗` when it failed and `(running)` while it runs. Times are UTC `hh:mm`, as in the activity log. The host stamps no times on messages, so the mod records them as it sees them happen: tool calls, the agent's answers, and its brief (its start time). Anything it didn't see, such as history from before the mod loaded or a reload, or a SendMessage to the agent, shows `--:--`.

Clicking a tool call opens its detail in a second pane: a Bash call's command and output, an Edit as a diff (numbered from the start of the edit, since Edit gives no line numbers), a Read's path and the lines it read, a Write's content, a Grep or Glob's pattern and results, an Agent call's prompt and result, and the input and result of any other tool. A subagent's transcript stores only what the model read, so there is no separate stderr or exit code. Escape, the pane's `Close` button, or clicking the tool call again closes it, and the Orchestrator pane shows again. A surface that places no second pane (such as an older desktop app) shows the detail in place, beneath the tool call.

A waiting agent is idle with live children: it ended its turn and is waiting on agents it spawned. A single click on a row still opens its transcript; a double-click (two presses within 400 ms) collapses or expands instead. On the terminal, main's row is pressable too, so it can be collapsed (a single click only bolds it). Collapsing hides the finished agents from the tree and, in the desktop app, from the chart, without changing the other agents' colours. It is display only: the header counts, the roster and handovers still see every agent, and a live agent is never hidden, even under a finished one.

On both the terminal and the desktop app, the status line shows live agents, the largest context and main's context; toasts show; and in ask mode the **Hand over & restart** band shows above the prompt past the threshold. The desktop app has no notifications; the stall toast still shows there.

**Records.** The run folder, `<project>/.orchestrator/<run>/` by default, holds `roster.md` (one row per agent: name, id, type, status, context, peak, note, replaced by/replaces), `state.json` and `handover/*.md`. The run id is the first session id, so it stays the same across `/clear`. The folder sits inside the project so agents can write notes there under ordinary edit permissions (`~/.claude` is a protected path, so they can't write there). The mod adds `.orchestrator/` to `.git/info/exclude` so it never shows in `git status`. Set `runRoot` to put run folders elsewhere.

## The orchestrated-run skill

`skills/orchestrated-run` is the run playbook: the main session settles the user's decisions and spawns one orchestrator, which drives TDD implementers, read-only reviewers and an adjudicator, and commits in waves on a branch. Its context-limit section defers to this mod: no poller, no hand-pasted HANDOVER clause, and orchestrators told to accept the mod's replacements rather than spawn their own. Orchestrators still end every spawn prompt with a SendMessage report-back clause, then call the check-in tool with an estimate plus a buffer; the mod auto-forwards any report a child didn't send, so reports reach the orchestrator and no longer land in main. It loads as `orchestrator:orchestrated-run`.

## Commands

| | |
| --- | --- |
| `/orch` | open the pane |
| `/orch close` | close the pane |
| `/orch roster` | print the roster |
| `/orch handover` | hand the main thread over now |
| `/orch handover <name or id>` | hand that agent over now |

In the desktop app, the pane's `Hand over` and `Hand over main` buttons do what `/orch handover` does, so you don't need `/orch handover` there. A main handover asked for mid-turn starts when the turn ends.

## Settings

Configure in `/config` (or `pluginConfigs.orchestrator.options` in settings):

| option | default | |
| --- | --- | --- |
| `agentThreshold` | 450000 | tokens at which a subagent is handed over |
| `mainThreshold` | 450000 | tokens at which the main thread is offered (or given) a restart |
| `mainHandover` | `ask` | `ask`, `auto` or `off` |
| `autoRespawn` | true | spawn the replacement automatically; when false, the agent asks its parent to |
| `injectClause` | true | append the HANDOVER clause to every Agent prompt |
| `runRoot` | (empty) | where run folders go; empty means `<project>/.orchestrator` |

## Install

```
/plugin install orchestrator --marketplace victor-bajanov/cc-orchestrator-mod
```

Or run it from a checkout:

```
claude --plugin-dir /path/to/cc-orchestrator-mod
```

### In the desktop app

`/plugin install` isn't available in the desktop app. Install the plugin at user scope from a terminal with the command above; it then loads in the desktop app's local sessions too.

### Run a checkout in the desktop app

The desktop app starts sessions with no CLI flags, so name the folder in the `env` block of `~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-orchestrator-mod",
  "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
}
```

`CLAUDE_CODE_PLUGIN_DIR_WATCH` is optional; it reloads the mod when you edit it. Restart the app afterwards. The app has no `/config` menu, so set options in `pluginConfigs.orchestrator.options`.

## Develop

```
claude plugin test .        # unit and integration tests (hooks/*.test.ts)
claude plugin validate .
npx -p typescript@5.6.3 tsc -p .   # needs .claude-plugin/types/, which the engine lays when it loads the mod
```

`hooks/core.ts` holds the pure logic (context math, timeline, roster, prompts). `hooks/view.ts` holds the pure drawing logic both surfaces share (pane header, series colours, the desktop chart's SVG, transcript items and times, model labels, status styles and emoji, collapsing, check-in and forwarding rules). `hooks/detail.ts` builds the tool-call detail sections per tool (diffs, excerpts, caps). `hooks/register.tsx` wires them to the engine and draws one pane tree for the terminal and another for the desktop app. The engine only lets `$` be passed to functions declared at the top level of the hooks module, which is why the helpers there are top-level functions reading a module-level `cfg`.
