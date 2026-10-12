# Bug: an idle agent isn't woken by its own background shell's completion notice

**Versions:** Claude Code 2.1.296 (terminal), in both the original stall and every repro run below.

See also [engine-bug-timer-hooks.md](engine-bug-timer-hooks.md). That bug is why the mod's workaround for this one can only act at some agent's turn end.

## Summary

A background agent runs a Bash command with `run_in_background: true` and ends its turn, waiting for the completion notice. When the shell exits, the engine queues a `<task-notification>` for that agent. The queue is the session's: main's transcript records a `queue-operation` `enqueue` with that content. Sometimes the queued notice does not wake the idle agent. It stays queued until something else gets the agent running: a message from another agent, or, in headless mode, main's next turn end. When the agent does run, it gets the notice as a `queued_command` attachment with `commandMode: "task-notification"`, stamped with the time it was queued.

What happens depends on the mode and on whether the agent is a named agent-teams teammate:

- **Interactive, named teammate:** the notice is never delivered on its own, whether main was busy or idle when the shell exited. Main's next turn doesn't deliver it either. This is the original stall.
- **Headless (`claude -p`, stream-json input), plain or named:** the notice is held while main is busy in a turn, and delivered the moment main's turn ends. If every agent is idle when the shell exits, it's delivered at once.
- **Interactive, plain (unnamed) background subagent:** delivered at once in both cases.

## Expected

When an agent's own background shell exits, the agent is woken within a few seconds to handle the notice, as the tool result promised: "You will be notified when it completes." This should not depend on whether main is busy, on the mode, or on whether the agent is a teammate.

## Actual

The notice is queued on time but held. In the original run, a teammate orchestrator sat idle for 74 minutes and then 66 minutes, with finished results waiting, until a message from main woke it. A finished shell is never delivered on its own to an interactive teammate. Headless, it waits for main's turn end.

## Evidence: the original stalls

Run in `/Users/victorb/code/me-sample-docs`, session `090eb9f3-38b0-4264-9940-f9dbfa6018fb`. The teammate `orch-synthetic-docs` was spawned by main with `"name":"orch-synthetic-docs"` (agent teams on). Its transcript is `~/.claude/projects/-Users-victorb-code-me-sample-docs/090eb9f3-38b0-4264-9940-f9dbfa6018fb/subagents/agent-aorch-synthetic-docs-d485630a558a29b9.jsonl`. Main's transcript is `…/090eb9f3-38b0-4264-9940-f9dbfa6018fb.jsonl` in the same folder.

**Stall 1 (74 minutes).**

- 05:50:42.617 (line 552): the teammate calls Bash with `"description": "Run full generation into output and dist", "run_in_background": true`.
- 05:50:43.199 (line 554): the result comes back: `Command running in background with ID: b7z1ow8i5. … You will be notified when it completes.`
- 05:50:44.952 (line 557): the teammate ends its turn with "I've started the full generation run … in the background and will commit the outputs once it finishes." `TeammateIdle` fires.
- 05:50:48.009 (main line 816): main's last turn ends (`stop_hook_summary`).
- 05:50:48.514 (main line 817): `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-12T05:50:48.514Z",…"content":"<task-notification>\n<task-id>b7z1ow8i5</task-id>…`. Every agent is idle now. Nothing happens until the user types "all done?" to main at 07:04:19.
- 07:04:33.994 (line 560): main's message wakes the teammate: `<teammate-message teammate_id="team-lead" summary="Nudge: generation finished, continue">`.
- 07:04:39.533 (main line 860): `"operation":"remove"`, `"reason": "absorbed_mid_turn"`.
- Line 566 of the teammate's transcript is appended after its first tool result of that turn (line 565, 07:04:39.525), but it carries the enqueue time: `"attachment":{"type":"queued_command",…,"commandMode":"task-notification","origin":{"kind":"task-notification","producer":"session-task"},…,"timestamp":"2026-10-12T05:50:48.514Z"}`.

**Stall 2 (66 minutes).**

- 08:12:31.853 (line 703): Bash with `"description": "Check no name-kills remain and run suite", "run_in_background": true`.
- 08:12:32.380 (line 705): `Command running in background with ID: b6ncukm5l`. The teammate ends its turn at 08:12:35.223 (line 708). Main's last turn ends at 08:12:37.968 (main line 1367).
- 08:13:23.019 (main line 1374): `enqueue` of `<task-id>b6ncukm5l</task-id>`. Every agent is idle until the user types "is it done?" to main at 09:18:52.
- 09:19:12.585 (line 711): `<teammate-message teammate_id="team-lead" summary="Main is taking over the final commit and merge">` wakes the teammate. It reads the output file (`485 passed, 3 skipped in 50.39s\n\n[exited with code 0]`), and the notice is absorbed at 09:19:18.775 (main line 1416, `absorbed_mid_turn`).
- Line 717 is appended after line 716 (09:19:18.764) but stamped `"timestamp": "2026-10-12T08:13:23.019Z"`, `"commandMode": "task-notification"`.

Both stalled calls had an explicit `run_in_background: true` (each result came back in about 0.5 s). The session's one engine-initiated background move ("Command did not complete within its 180s timeout and was moved to the background", in `agent-a6e9c119a407c3bda.jsonl` line 347) was a busy plain subagent and did not stall.

## Minimal repro

[`docs/repro/bg_shell_wake.py`](repro/bg_shell_wake.py) runs one session on haiku in a fresh temp directory, by default without user or project settings, so no plugins or user hooks load:

```
uv run docs/repro/bg_shell_wake.py                                   # headless, main busy
uv run docs/repro/bg_shell_wake.py --main-sleep 2 --idle 90           # headless, all idle
uv run docs/repro/bg_shell_wake.py --interactive --teammate           # the original case
uv run docs/repro/bg_shell_wake.py --interactive --teammate --main-sleep 2 --idle 90
```

1. Main spawns a background `general-purpose` subagent (named `waiter` with `--teammate`, which also sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). The subagent runs `sleep 20; echo shell-done` with `run_in_background: true` and ends its turn. When the notice reaches it, it must `touch RESUMED`.
2. Main runs a foreground `sleep 75` (or `sleep 2` for the all-idle case) and ends its turn. The script then waits `--idle` seconds, sends main a second prompt (`ls RESUMED`), and waits `--idle` seconds more.
3. The script reads the transcripts. It reports when the shell's notice was enqueued (main transcript `queue-operation`), when and why it left the queue, when it reached the subagent, and when `RESUMED` was written, and prints a verdict.

Headless mode keeps the session open with `--input-format stream-json`. A plain `claude -p "<prompt>"` exits as soon as main's turn ends, so a held notice is simply lost. In the first attempt (single `-p` prompt, main busy), the notice was enqueued at 10:33:48.852, never removed, and the process exited at main's turn end, about 73 s later. Interactive mode drives the terminal UI through a pseudo-terminal and accepts the folder-trust prompt.

### Results (2.1.296, haiku, one run each)

| mode | subagent | main when the shell exited | notice enqueued → left the queue | marker |
| --- | --- | --- | --- | --- |
| interactive | named teammate | idle | 11:04:31.563 → never (still queued after main's next prompt and turn, 11:05:50–11:05:53, and 90 s more) | never |
| interactive | named teammate | busy (`sleep 75`) | 11:11:50.085 → never (main's turn ended 11:12:45, its next turn ended 11:13:53) | never |
| interactive | plain | busy | 11:15:37.660 → 11:15:37.670 `delivered_to_agent` | +2 s |
| interactive | plain | idle | 11:08:16.544 → 11:08:16.558 `delivered_to_agent` | +2 s |
| headless | plain | busy | 11:19:19.826 → 11:20:14.763 `delivered_to_agent`, as main's turn ended (11:20:14.755) | +57 s |
| headless | plain | busy | 10:42:40.298 → 10:43:34.126, as main's turn ended (10:43:34.117)¹ | +56 s |
| headless | named teammate | busy | 10:50:56.096 → 10:51:50.980, as main's turn ended (10:51:50.974)¹ | +57 s |
| headless | plain | idle | 10:46:03.554 → 10:46:03.561¹ | +2 s |
| headless | named teammate | idle | 10:48:37.502 → 10:48:37.510¹ | +2 s |
| headless, user settings and plugins | named teammate | idle | 10:53:52.586 → 10:53:52.594¹ | +2 s |

¹ These runs inherited the calling session's `CLAUDE_CODE_*` environment. Later runs strip it. The first row of the headless/busy pair was rerun with a clean environment and matched.

A sample verdict line (interactive, teammate, all idle): `VERDICT: BUG REPRODUCED: the shell's notice was queued but the idle subagent never resumed`.

## Observations

- The notice is queued in the session-level queue on time: the enqueue timestamp matches the shell's exit. Delivery is the part that fails. When the agent finally consumes it, the `queued_command` line carries the enqueue timestamp but sits in the transcript where it was consumed. Anyone reading the agent's transcript in order can mistake it for a timely notice.
- When a message wakes the teammate, the notice isn't the first thing it sees. It is attached after the woken turn's first tool result (`absorbed_mid_turn`). The agent acts on the waking message first.
- Headless, main busy: the notice leaves the queue within 10 ms of main's turn end every time. Main's turn end is what flushes it.
- Interactive teammates: main's turn end doesn't flush it, and neither does a new user prompt to main. Only a message to the teammate itself woke it in the original run. Plain background subagents in interactive mode are woken promptly.
- The engine knows the subagent may need waking. When a plain subagent ends its turn with a shell still running, main gets `This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, …`.
- The output file ends with `[exited with code N]` once the shell exits (stall 2's file: `485 passed, 3 skipped in 50.39s\n\n[exited with code 0]`). The mod's watcher polls for that line.

## Workaround (the orchestrator mod's background-shell watcher)

- **Tracking.** The mod tracks the shells each agent backgrounds: explicit `run_in_background` calls, plus long commands the engine moves to the background. Such a tool result has a `backgroundTaskId`. A command marked `backgroundEndsWithFinalResponse` dies with its caller's final response, so no notice can follow, and it isn't tracked. A TaskStop of a tracked shell drops it.
- **Polling.** Every `shellPollSeconds` (default 15) the mod `stat`s each open shell's output file. When the size has changed, it reads the file and looks for `[exited with code N]` or `[killed]` at its end, then records the exit and its time.
- **Picked up.** A finished shell counts as picked up when its agent starts a new run after the shell ended (a woken run absorbs the held notice, as in the original stalls), or when the agent makes a tool call whose arguments name the shell's id or output path. A step in the same busy run doesn't count: it's unknown whether a busy teammate gets the notice.
- **Grace nudge.** When an idle agent has no open shell left and hasn't picked up its finished ones within `shellGraceSeconds` (default 60) of the later of the last shell's end and its own last activity, the mod queues one nudge to it: `[orchestrator mod] your background command "<description>" (id <id>) exited with code N at hh:mm UTC and you haven't picked it up; output: <path>`. The nudge is a send, which wakes a teammate; the held notice is then absorbed into the woken turn. A duplicate costs less than a lost wake. No nudge goes to an agent the engine lists as completed, failed or killed, or doesn't list at all: its shells are settled silently. If the engine's list fails, the nudge goes as before.
- **Ceiling nudge.** A shell still running after `shellCeilingMinutes` (default 60) gets its agent one nudge to check it (a suspended process, say) or stop it with TaskStop.
- **Reconciliation.** At every `Stop` and `SubagentStop`, the mod compares its open shells against the hook's `background_tasks`. A tracked shell the engine no longer lists is ended (the stopping agent's at once, another agent's only once it started at least 30 s before, since the session-wide list may predate it), with the code its file holds, or as `unknown`. This catches what the poll misses: polling off, a file whose tail can't be read (one over 64 KiB is checked through `tail`), a hard crash that leaves no marker. An engine without the field changes nothing.
- **Main.** Main's shells are tracked and logged but main is never nudged: interactive main isn't affected, and headless delivery happens at main's own turn end. Its finished shells are dropped at its next step. Past the ceiling, main gets a warning toast, not a prompt.
- **Delivery.** Because of the [timer-hook bug](engine-bug-timer-hooks.md), the poll (a `$.clock` timer) can't send a nudge itself. It queues the nudge in the mod's outbox, marked live-only: it's dropped unsent if the agent has ended by delivery. The outbox is drained at some agent's turn end. When every agent is idle, that turn end is main's: the mod's 30-second sync submits a short `[orchestrator mod]` prompt to main, and main's turn end drains the outbox. So a nudge can lag the grace by up to one poll, one sync interval and main's short turn.
- **Not covered.** A teammate running in its own terminal pane makes no tool calls in this process, so its shells aren't tracked.
