# orchestrator: a Claude Code mod for long agent runs

This mod watches every agent loop in a session, hands it over before its context runs out, and charts what it is doing. It ships the `orchestrated-run` skill, rewritten so the mod handles context limits and the main session no longer polls transcripts.

## What it does

**Monitoring.** Every model request, from the main thread and from subagents at any depth, reports its token usage through `turn.step`. The mod records each agent's context size (input + cache-write + cache-read) over time. No transcript files are polled.

**Subagent handover.** When a subagent crosses `agentThreshold` (default 450k):

1. The mod gives it `HANDOVER` with a note path under the run folder's `handover/`. While the agent works, the HANDOVER rides on its next tool result. A message would do no good there: a named agent (a teammate) reads its inbox only between turns. An idle agent, or one that ends its turn before another tool call, is sent the HANDOVER as a message, which wakes it.
2. When the agent ends with that note written, the mod spawns a replacement. The replacement gets the original brief, the same type, model and name, plus "start from the handover note at …". The engine suffixes a teammate's name while the original holds it (`probe` → `probe-2`); the mod reads the real name back.
3. The mod tells the old agent's parent about the swap, with the replacement's id and SendMessage name. A parent agent gets a message; the main thread gets a note in its conversation. The note says no action is needed, so the parent doesn't spawn a second replacement.
4. When a replacement's original parent was the main thread, the mod forwards the replacement's final report there. A teammate's final report already reaches it, so that one isn't forwarded.

If the agent ends again without writing its note, it is marked `done` and not respawned. If it hasn't handed over within 20 minutes, it is marked `stalled` and you get a notification. A replacement whose first reading is already at half the threshold or more (its brief and note alone fill the window) is left to run and you get a warning, so handovers can't loop.

**HANDOVER clause.** Every Agent call has the cold-restart clause appended to its prompt (`injectClause`), so orchestrators no longer have to paste it into each brief.

**Main-thread restart.** When the main thread crosses `mainThreshold`:

1. It writes a handover note.
2. The mod runs `/clear`.
3. The mod submits a fresh prompt containing the note, the live agents (name, id, type, status, context) and the roster path.

Running agents survive `/clear`. This prompt is how the new context learns about them. With `mainHandover: ask` (the default) the mod offers a **Hand over & restart** button above the prompt. With `auto` it acts on its own. With `off` it never acts. After a restart, the mod doesn't offer again until the main context has read below the threshold once.

**Visual.** The **Orchestrator** pane opens on the first spawn, or with `/orch`. It has:
- a tree of agents (main, then each agent under its parent)
- each agent's context drawn on one shared time axis, so you can see when each agent was active and how close it is to its limit (green, then amber from 60%, red at the threshold)
- an activity log; a line too long for the pane ends in `…`, and hovering it shows the full text in a card (a click pins it open)

The status line shows live agents, the largest context and main's context.

**Records.** The run folder, `<project>/.orchestrator/<run>/` by default, holds `roster.md` (one row per agent: name, id, type, status, context, peak, note, replaced by/replaces), `state.json` and `handover/*.md`. The run id is the first session id, so it stays the same across `/clear`. The folder sits inside the project so agents can write notes there under ordinary edit permissions (`~/.claude` is a protected path, so they can't write there). The mod adds `.orchestrator/` to `.git/info/exclude` so it never shows in `git status`. Set `runRoot` to put run folders elsewhere.

## The orchestrated-run skill

`skills/orchestrated-run` is the run playbook: the main session settles the user's decisions and spawns one orchestrator, which drives TDD implementers, read-only reviewers and an adjudicator, and commits in waves on a branch. Its context-limit section defers to this mod: no poller, no hand-pasted HANDOVER clause, and orchestrators told to accept the mod's replacements rather than spawn their own. It loads as `orchestrator:orchestrated-run`.

## Commands

| | |
| --- | --- |
| `/orch` | open the pane |
| `/orch close` | close the pane |
| `/orch roster` | print the roster |
| `/orch handover` | hand the main thread over now |
| `/orch handover <name or id>` | hand that agent over now |

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

## Develop

```
claude plugin test .        # unit and integration tests (hooks/*.test.ts)
claude plugin validate .
npx -p typescript@5.6.3 tsc -p .   # needs .claude-plugin/types/, which the engine lays when it loads the mod
```

`hooks/core.ts` holds the pure logic (context math, timeline, roster, prompts). `hooks/register.tsx` wires it to the engine. The engine only lets `$` be passed to functions declared at the top level of the hooks module, which is why the helpers there are top-level functions reading a module-level `cfg`.
