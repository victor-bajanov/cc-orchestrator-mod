# orchestrator: a Claude Code mod for long agent runs

This mod watches every agent loop in a session, hands it over before its context runs out, and charts what it is doing. It ships the `orchestrated-run` skill, rewritten so the mod handles context limits and the main session no longer polls transcripts.

## What it does

**Monitoring.** Every model request, from the main thread and from subagents at any depth, reports its token usage through `turn.step`. The mod records each agent's context size (input + cache-write + cache-read) over time. No transcript files are polled.

**Subagent handover.** When a subagent crosses `agentThreshold` (default 450k):

1. The mod gives it `HANDOVER` with a note path under the run folder's `handover/`. While the agent works, the HANDOVER rides on its next tool result. A message would do no good there: a named agent (a teammate) reads its inbox only between turns. An idle agent, or one that ends its turn before another tool call, is sent the HANDOVER as a message, which wakes it.
2. When the agent ends with that note written, the mod spawns a replacement. The replacement gets the original brief, the same type, model and name, plus "start from the handover note at …". The engine suffixes a teammate's name while the original holds it (`probe` → `probe-2`); the mod reads the real name back. The engine suffixes any taken name the same way, at the first spawn too. The mod records the registered name, and check-ins and `/orch handover` accept it, the id, or the requested name when that picks one agent. It also queues the agent a message: `[orchestrator mod] You are registered as \`<name>\` (you asked for \`<requested>\`); tell your children to SendMessage \`<name>\`.`
3. The mod tells the old agent's parent about the swap, with the replacement's id and SendMessage name. A parent agent gets a message; the main thread gets a note in its conversation. The note says no action is needed, so the parent doesn't spawn a second replacement. The agent's own final reply says the mod *will* spawn it, and that the parent should act only if the mod reports that none started.
4. Once the replacement has started, the mod stops the old agent (TaskStop), and moves its children under the replacement in the pane, the roster and check-ins. A SendMessage that still names the old agent, by name, id or teammate address, from any agent or main, is sent to the newest replacement instead, and the sender reads `[orchestrator mod] <old> was replaced by <new> (id <id>); this message went to <new>. Use that name from now on.` A name a live agent holds is never redirected, and a replacement messaging its predecessor goes as addressed.
5. When a replacement's original parent was the main thread, the mod forwards the replacement's final report there. A teammate's final report already reaches it, so that one isn't forwarded.

If the agent ends again without writing its note, it is marked `done` and not respawned. If it hasn't handed over within 20 minutes, it is marked `stalled` and you get a notification (a toast in the desktop app); when a stalled agent's run does end, the mod settles it as any other: replaced if the note is there by then, `done` if not. If the replacement can't be started (the engine refuses the spawn, or no brief was recorded), the old agent is marked `respawn-failed`. Its parent is told that nothing is carrying the work, with the note path, the brief's name, type and model, and a file holding the full replacement prompt (`handover/<…>.brief.md`). An agent parent gets a message, and main gets a prompt that wakes it. You get a toast and a notification. When the parent spawns an agent whose prompt names that note, the mod links it as the replacement, moves the old agent's children under it and stops the old agent. A replacement whose first reading is already at half the threshold or more (its brief and note alone fill the window) is left to run and you get a warning, so handovers can't loop.

**Resumed agents.** A finished agent that is messaged again resumes: its row goes back to `running` and carries a dim `↻`.

**Check-ins.** The mod registers a tool, `mcp__orchestrator__checkin { agent, minutes }`, listed in the prompt's tools rather than behind ToolSearch. A parent calls it after spawning a child: the main thread, or any subagent (a subagent orchestrator with the default tools can call it; one whose definition restricts `tools` needs `mcp__orchestrator__checkin` added to that list, which is untested). It calls it naming the child by id, by the name it is registered under (the engine's, suffixed when taken: `orchestrator-2`), or by the name it was spawned with when that picks one child, with its estimate of the child's task plus a buffer. It works only on the caller's own children, which include the children of an agent the caller replaced. Calling it again re-arms it; `minutes` of 0 or less cancels it. If the child hasn't reported by then, the check-in fires once: the mod wakes the parent with a message, `[orchestrator mod] check-in: <name> (id …) has not reported after N min; status …, last active hh:mm. Check on it, or call checkin again to re-arm.` A check-in set by the main thread arrives as a prompt that wakes it, plus a toast, and one set by an orchestrator that has since handed over goes to its replacement. It is disarmed when the child reports or ends its run. A report is a SendMessage to its parent, or a SubagentHandback that the engine delivered to it: one that succeeded while the parent was live and not a teammate. A handback the engine refused or rerouted to main doesn't count. A teammate's turn end doesn't disarm it: a teammate ends a turn whenever it waits. A teammate's check-in is disarmed by its SendMessage, or when it ends for good (the engine stops listing it). The deadline is kept in `state.json`, so it survives a reload.

**Background commands.** The engine sometimes never wakes an idle agent when its own background shell exits: a named agent-teams teammate in an interactive session is never woken, and headless the wake waits for main's turn end when main is busy (see `docs/engine-bug-bg-shell-wake.md`). So the mod tracks every Bash call that goes to the background: explicit `run_in_background` calls, and long commands the engine moves there. A command that dies with its caller's final response isn't tracked. A TaskStop drops it. Every `shellPollSeconds` the mod checks each open command's output file and, when it has grown, reads the `[exited with code N]` or `[killed]` line the engine appends at the end (a file over 64 KiB through `tail`, so only its last bytes), and logs the exit. The agent has picked a finished command up when it starts a new run after the command ended (the woken run takes in the held notice), or when it makes a tool call naming the command's id or output path (a Read, TaskOutput or `cat`). A step in the same busy run doesn't count, so the grace runs from that run's end. If an idle agent with none still running hasn't picked up its finished commands within `shellGraceSeconds`, the mod sends it one nudge: `[orchestrator mod] your background command "<description>" (id …) exited with code N at hh:mm UTC and you haven't picked it up; output: <path>` (with several, `… your background commands finished and you haven't picked them up:` and one line each). Neither nudge goes to an agent the engine lists as completed, failed or killed, or no longer lists: its commands are settled without one (if the engine's list can't be read, nudges go as before). A command still running after `shellCeilingMinutes` gets its agent one nudge to check it (a suspended process, say) or stop it. At each turn end, the mod also compares the open commands against the engine's list of background tasks: one the engine no longer lists is ended (the stopping agent's at once, another agent's only once it started at least 30 seconds before, since the list may predate it), with the code its file holds, or as unknown. That catches what the poll missed (polling off, a file whose tail couldn't be read, a crash with no marker). Main's commands are tracked and logged, but main is never prompted: the engine wakes main itself. Its finished commands are dropped at its next step, and past the ceiling it gets a warning toast. Nudges ride the outbox like check-ins, so they can arrive 30 seconds or more late (see "Some messages wait…" below). Teammates running in their own terminal pane make no tool calls in this process, so their commands aren't tracked.

**Idle watchdog.** An agent that sits idle with nothing to wait for gets one nudge after `idleWatchdogMinutes`: `[orchestrator mod] you've been idle N min with no running children or background commands; if you're waiting on something, check it; otherwise carry on or report.` It applies only when the agent isn't main, both the mod and the engine list it idle (not finished, and not held on its own work), it has no live children (running, idle or handing over), and it has no background commands, open or unread. In practice that means idle teammates and background agents the engine keeps idle. It nudges once per idle stretch: it nudges again only after another run besides the one its nudge started, or after the agent starts a new background command.

**Auto-forwarded reports.** A child reports to its parent agent with SubagentHandback, which the engine delivers to a subagent parent even while it waits idle on its children, and wakes it. The engine never delivers one to a teammate, though: with agent teams on, every agent the main thread spawns with a `name` is a teammate, and its children's handbacks are refused or rerouted to main (`docs/engine-bug-handback-teammate.md`). So spawn an orchestrator without a name; the mod warns in the activity log when a teammate spawns children. As a safety net, at the end of each of a child's runs, the mod forwards its final answer to its parent agent (`[orchestrator mod] final report of <name> (id …), auto-forwarded:`), which wakes it; if the parent has handed over, the answer goes to its replacement. It skips the forward when the child's last act in that run was a delivered report (a handback that reached its parent, or a SendMessage to it), or when a report it delivered says the same as the answer. Otherwise it forwards, because a lost report costs more than a duplicate; when the child did send something that run, the forward says `(may duplicate a message it sent you)`. It never forwards to the main thread (the engine already tells main), for teammates (their answers arrive anyway), for an aborted or failed run or an empty answer, or for a HANDOVER. A foreground child of a subagent has its answer as its parent's tool result, so it isn't forwarded either. A foreground child of a teammate is forwarded: the engine withholds its answer from the teammate's Agent result. A mod-spawned replacement's answer is always forwarded under the same per-run check. So a grandchild's report goes to its orchestrator, not to main.

**Some messages wait for an agent's turn to end.** In this engine, a run that a mod starts from a timer loses the mod's hooks: the agent can't call `checkin` and the mod can't track it. A run woken from inside one of the mod's hooks runs without that hook (see `docs/engine-bug-timer-hooks.md`). So the mod queues its cross-agent sends and spawns (check-in wake-ups, HANDOVER messages to idle agents, forwarded reports, respawns, name notices, and background-command and idle nudges; state key `outbox`) and sends them from a `turn.complete` hook that does nothing else, at the next turn end of any agent. A run that hook wakes or spawns loses only that hook. So whatever that run itself queues waits for another agent's turn to end, or for the fallback: if the queue survives a sync while main is idle, and nothing has drained it since the last nudge, the mod submits one short `[orchestrator mod] queued messages…` prompt to main, whose turn end sends them. Queued messages can therefore arrive 30 seconds or more late, and main may see that short prompt. The pane's `Hand over` button and `/orch handover` send at once.

**HANDOVER clause.** Every Agent call has the cold-restart clause appended to its prompt (`injectClause`), so orchestrators no longer have to paste it into each brief.

**Auto mode.** The mod's own messages, its spawn of a replacement, and its stop of a replaced agent are tool calls no request of yours asked for, so auto mode's classifier would refuse them. The mod allows exactly those calls while they are in flight (10 seconds at most), and nothing else.

**Main-thread restart.** When the main thread crosses `mainThreshold`:

1. It writes a handover note.
2. The mod runs `/clear`.
3. The mod submits a fresh prompt containing the note, the live agents (name, id, type, status, context) and the roster path.

Running agents survive `/clear`. This prompt is how the new context learns about them. With `mainHandover: ask` (the default), the pane carries a `Hand over main` button at any time, on the terminal and in the desktop app; past `mainThreshold`, a **Hand over & restart** band also appears above the prompt. With `auto` the mod acts on its own and shows no button. With `off` it never acts. `/orch handover main` works in every mode. If you ask for a handover mid-turn (with either button or `/orch handover`), it waits and starts when the turn ends, even a stopped one; meanwhile the buttons read "Handover queued". After a restart, the mod doesn't offer again until the main context has read below the threshold once.

**Visual.** The **Orchestrator** pane opens on the first spawn, or with `/orch`. In the desktop app it also opens on the first spawn, but `/orch` may not be listed in the desktop prompt.

*Terminal.* The pane has:
- a `Hand over main` button in the header (with `mainHandover: ask`; hidden while main is handing over)
- a tree of agents (main, then each agent under its parent); the agent you opened from `/tasks` is shown inverted
- each row's status glyph and status word in the status colour: running `●` bright green, waiting `◐` teal, idle `○` faint orange, handing over `↻` blue, stalled `!` red, done `✓` faint green, replaced `⤳` grey, respawn failed `✗` red. The colours are theme keys, so they follow your theme
- each row's model and effort, such as `Sonnet 5.5 med` (the model alone when the engine reports no effort)
- click a subagent's name to open its Timeline over the whole pane (see *Timeline* below); `← agents`, or `b` with the pane focused, brings the tree back
- a `▾` before a row with finished agents beneath it (main included) collapses them into `+N done`; the `▸` it becomes expands them again. With the pane focused, `c` collapses or expands the selected row (main when none is selected)
- each agent's context drawn on one shared time axis, so you can see when each agent was active and how close it is to its limit (green, then amber from 60%, red at the threshold)
- an activity log; a line too long for the pane ends in `…`, and a click shows its full text beneath it (a second click hides it); the log gives up the rows it takes

*Desktop app.* The pane has:
- a chart of each agent's context over time, one coloured line per agent, with the limits as dashed red lines; hover a line for the agent's name, context and status
- a tree of agents, each with its colour, model and effort (such as `Sonnet 5.5 med`), context, and a status emoji before the status word: running 🏃‍♂️ or 🏃‍♀️ (fixed per agent), waiting ⏳, idle 😴, handing over 📝, stalled 🛑, done ✅, replaced ♻️, respawn failed ⚠️
- click a subagent to open its Timeline over the whole pane, chart and tree included (see *Timeline* below); `← agents`, or `b` with the pane focused, brings them back. Clicking main highlights its line in the chart and opens nothing; click again to clear it (the agent in view stays highlighted)
- a `▾` before a row with finished agents beneath it collapses them into `+N done`, and their lines leave the chart; the `▸` it becomes expands them again. With the pane focused, `c` collapses or expands the selected row (main when none is selected)
- the agent open in the main view is marked *in view* and its line highlighted, unless you clicked another
- a `Hand over` button beside each live subagent, and a `Hand over main` button in the header (hidden unless `mainHandover` is `ask`, and while main is handing over)
- an activity log; a line too long for the pane ends in `…`, and clicking it expands the full text beneath it
- a `⧉` beside each agent, each expanded activity or transcript card, and each prose section of a tool call's detail copies its text (a toast says whether it took). A code section, such as a command or its output, has the app's own copy button instead. Nothing else in a desktop pane can be selected. The terminal has no `⧉`: select its text as usual

VS Code and the mobile app get the desktop pane.

**Timeline.** Clicking a subagent opens its Timeline, which takes over the Orchestrator pane. Each row is one turn: a number, the message that opened it, what the agent did in it (`✎ 2 files` for files edited or written, `› 3 cmds` for shell commands, `4 tools` for other tool calls, `reply` for text alone), `• here` on the latest turn, and its UTC `hh:mm`. A click on a row expands the turn in place: the opening message (`» ` marks it), the agent's text and each tool call, `⚙ <Tool> <command, path or pattern>`, with a red `✗` when it failed and `(running)` while it runs. A long text ends in `…`; a click shows its full text beneath it, and a second click hides it. A click on a tool call opens its detail (below). The pane scrolls a long Timeline with the wheel or keys. Turns are counted over the last 600 entries read, so an agent with a long history starts at `earlier steps`. Main has no Timeline, since it is the main view already.

The `↗` at the end of a row jumps to the turn's first tool call in the agent's transcript. On Claude Code 2.1.312 and later it first switches the main view to that agent when it is not already showing (what picking it from `/tasks` does), then scrolls to the call. On older engines it says to open the agent from `/tasks` yourself. A turn with no tool call has no jump (a dim `↗`). If the host refuses (the agent is a teammate in a pane of its own, say), the reason shows under the header with a `dismiss` button. The Timeline is read through the host's own transcript API and updates as the agent works. A teammate running in another pane's process, or a finished agent whose transcript was not saved, can't be read; the pane says "transcript not readable (teammate in another pane, or finished)". Esc keeps its host meaning and closes the pane; `/orch` opens it again. Times are UTC `hh:mm`, as in the activity log. The host stamps no times on messages, so the mod records them as it sees them happen: tool calls, the agent's answers, and its brief (its start time). Anything it didn't see, such as history from before the mod loaded or a reload, or a SendMessage to the agent, shows `--:--`.

Clicking a tool call opens its detail in a second pane: a Bash call's command and output, an Edit as a diff (numbered from the start of the edit, since Edit gives no line numbers), a Read's path and the lines it read, a Write's content, a Grep or Glob's pattern and results, an Agent call's prompt and result, and the input and result of any other tool. A subagent's transcript stores only what the model read, so there is no separate stderr or exit code. Escape, the pane's `Close` button, or clicking the tool call again closes it, and the Orchestrator pane shows again. A surface that places no second pane (such as an older desktop app) shows the detail in place, beneath the tool call.

A waiting agent is idle with live children: it ended its turn and is waiting on agents it spawned. A click on a row only opens or closes its Timeline; collapsing is the `▾`/`▸` glyph's job, or `c`'s. Main's row is pressable too: a click selects it (bolds it), so `c` acts on it, and opens no Timeline. Collapsing hides the finished agents from the tree and, in the desktop app, from the chart, without changing the other agents' colours. It is display only: the header counts, the roster and handovers still see every agent, and a live agent is never hidden, even under a finished one.

On both the terminal and the desktop app, the status line shows live agents, the largest context and main's context; toasts show; and in ask mode the **Hand over & restart** band shows above the prompt past the threshold. The desktop app has no notifications; the stall toast still shows there.

**Records.** The run folder, `<project>/.orchestrator/<run>/` by default, holds `roster.md` (one row per agent: name, id, type, status, context, peak, note, replaced by/replaces), `state.json`, `handover/*.md`, and `activity.log`: every activity line with its UTC time and level, plus every press on the mod's panes (element, surface, pane id) and every Hand over that could not start, with the reason. It keeps the last 2,000 lines and survives a reload. If a Hand over press seems lost, look there: no `press handover:<id>` line means the press never reached the mod. The run id is the first session id, so it stays the same across `/clear`. The folder sits inside the project so agents can write notes there under ordinary edit permissions (`~/.claude` is a protected path, so they can't write there). The mod adds `.orchestrator/` to `.git/info/exclude` so it never shows in `git status`. Set `runRoot` to put run folders elsewhere.

## The orchestrated-run skill

`skills/orchestrated-run` is the run playbook: the main session settles the user's decisions and spawns one orchestrator, which drives TDD implementers, read-only reviewers and an adjudicator, and commits in waves on a branch. Its context-limit section defers to this mod: no poller, no hand-pasted HANDOVER clause, and orchestrators told to accept the mod's replacements rather than spawn their own. Orchestrators still end every spawn prompt with a SendMessage report-back clause, then call the check-in tool with an estimate plus a buffer; the mod auto-forwards any report a child didn't send, so reports reach the orchestrator and no longer land in main. It loads as `orchestrator:orchestrated-run`.

## Commands

| | |
| --- | --- |
| `/orch` | open the pane |
| `/orch close` | close the pane |
| `/orch roster` | print the roster |
| `/orch handover` | hand the main thread over now |
| `/orch handover <name or id>` | hand that agent over now: its id, its registered name, or the name it was spawned with when that picks one agent |

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
| `shellPollSeconds` | 15 | how often background command output files are checked for their exit; 0: never |
| `shellGraceSeconds` | 60 | an idle agent that hasn't picked up its finished background commands within this is nudged; 0: never |
| `idleWatchdogMinutes` | 5 | an idle agent with no running children or background commands this long is nudged once; 0: never |
| `shellCeilingMinutes` | 60 | a background command still running this long gets its agent one nudge; 0: never |

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
