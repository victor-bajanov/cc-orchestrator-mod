---
name: orchestrated-run
description: |
  Run a multi-task code change end to end through a delegated orchestrator subagent that drives TDD implementers, read-only reviewers and an adjudicator, commits in waves on a branch, and gates expensive steps behind a fresh /code-review. The orchestrator mod (this plugin) keeps every agent, and the main session, under its context ceiling with handover-note restarts. Use when the user asks to "run a subagent orchestrator", "have an orchestrator do task X", work through a backlog or plan with implementer/reviewer agents, or mentions the implementer → reviewer → adjudicator loop, handover notes, or monitoring subagent context.
---

# Orchestrated run

The main session stays small: it settles the user's decisions, spawns **one orchestrator subagent**, and otherwise waits. The orchestrator runs the whole job through its own subagents. Subagents can spawn subagents (nesting works). A background child's final message is not delivered to its parent agent, so every child reports by SendMessage, and the mod forwards the final answer of any child that didn't. The **orchestrator mod** watches every agent's context and handles handovers, so nobody polls transcripts.

```
main session ── decisions; restarted from a note by the mod near its ceiling
  └─ orchestrator ── plan, briefs, task roster, wave commits; writes no production code
       ├─ investigator / planner
       ├─ implementer (TDD) ⇄ reviewer (read-only) → adjudicator → same implementer
       ├─ fresh code-review agent  (gate before expensive steps)
       └─ final adjudicator (whole diff, all gates, in-browser check)
the mod ── context of every agent, HANDOVER, respawn, check-ins, auto-forwarded reports, run roster, pane (/orch)
```

## 1. Main session: before spawning

1. **Ask the decisions only the user can make, in one AskUserQuestion**, and pass the answers into the brief as "already decided, do not re-ask". Typical: who picks design parameters (orchestrator decides vs proposes-and-waits), how existing assets/data are treated, whether paid API calls are allowed (and a cap), and how the run finishes (stop on branch vs merge and push).
2. **Create the work branch** yourself (`git checkout -b <task-slug>`) so the orchestrator never touches the default branch.
3. Make `<scratchpad>/<task>/roster.md` for the orchestrator's **task roster**. Handover notes and the mod's run roster live in the mod's run folder (`<project>/.orchestrator/<run>/`); don't make a handover folder.
4. Check the mod's settings in `/config` match the run: `agentThreshold` and `mainThreshold` (450000 for a 500k ceiling), `mainHandover` (`ask` offers a pane button at any time and a band above the prompt past the threshold, `auto` restarts on its own), `autoRespawn` and `injectClause` on.

## 2. The orchestrator brief (checklist)

Spawn with `subagent_type: general-purpose`, `model: opus`, `run_in_background: true`, `description: orch-<task-slug>`, and **no `name`**. With agent teams on, every agent main spawns with a `name` becomes a teammate, and the engine never delivers a child's SubagentHandback to a teammate: children's reports are then refused or rerouted to main (see `docs/engine-bug-handback-teammate.md`). An unnamed orchestrator is a plain subagent, and its children's handbacks reach it even while it waits idle. Record the `agentId` from the spawn result and use it for check-ins and messages. The brief must contain:

- **Read first**: repo CLAUDE.md (its orchestration section, if any, is binding), relevant memory feedback notes, and the docs/sections the task touches. Tell it to keep its own reading lean and delegate wide investigation.
- **The task**, with the known dependent artefacts, and "find the rest via an investigation subagent and put them in the plan".
- **User decisions** verbatim.
- **Branch and commit rules**: work on the named branch; the orchestrator alone commits, in waves, staging only each approved task's files; the exact attribution trailer; never push, merge, touch the default branch or rewrite history (unless the user chose otherwise).
- **Process**:
  1. *Plan*: a subagent investigates and writes `docs/plans/<date>-<task>.md`, verified against the code, no placeholders, open questions decided, tasks split with **non-overlapping file scopes** for parallel implementers, expensive steps as a separate late phase. Commit it.
  2. *Implement*: an `implementer` per task (TDD: failing test first, watch it fail, implement, watch it pass; pass this rule on), parallel where scopes are independent. Each gets its own `reviewer`. **Reviewers are read-only and only return feedback.** Findings go to an `adjudicator`, whose accepted fix list goes back to the **same implementer via SendMessage** (not a fresh agent); a reviewer re-checks. Trivially verified findings may go straight back. Commit each approved task.
  3. *Code-review gate*: once all code is in and **before any expensive step** (data regeneration, long harness runs, paid calls), spawn a **fresh** general-purpose opus subagent whose only job is to invoke the Skill tool with `skill: "code-review"`, `args: "high"` against `<default>...<branch>` and return findings. Route them through adjudicator → same implementer → reviewer.
  4. *Expensive phase*: run long commands in the background and wait for completion notifications; never sleep-poll. Agents may background any long command freely: the engine sometimes doesn't wake an idle agent when its shell exits, and the mod then nudges it (`[orchestrator mod] your background command … you haven't picked it up`) (not for a teammate in its own terminal pane).
  5. *Final review*: an `adjudicator` reviews the whole branch diff, runs every gate (lint, typecheck, unit tests, e2e, build, any tool test suites) and does an in-browser Playwright check of affected UI; accepted fixes go through the same loop. Record findings and fixes in the project backlog.
- **Agent hygiene**: use the project's `.claude/agents/` roles where they exist (they carry model/effort); Opus in every role; give every agent a `name` unique in the session; brief every agent with global invariants, its file scope and who else is working concurrently on what; prefer a fresh agent per new task; ask for short reports.
- **Context-limit rules** (section 3 below). The mod appends the HANDOVER clause to every brief itself; don't paste it.
- **Spawning**: background agents, each with a `name` (a subagent's named children are not teammates). Every spawn prompt ends with this clause, verbatim:
  > Your final message is NOT delivered to me. Deliver your full report with SubagentHandback, as your last call. If it fails, end with your full report as your final message; it is forwarded to me.

  SubagentHandback is in every subagent's tools, read-only roles included, so no role needs SendMessage to report. After each spawn the orchestrator checks the spawn result's `name`. A suffixed one (`impl-3-2`) is the child's real name for check-ins, messages and the roster.
- **Check-ins**: after each spawn the orchestrator calls the mod's tool `mcp__orchestrator__checkin { agent: <name or id>, minutes: <estimate + max(10, 50% of it)> }` (a 30-minute task gets 45; a 10-minute one gets 20). It works only on the orchestrator's own children (and, after a handover, its predecessor's). Calling it again re-arms it (`minutes` of 0 or less cancels), so re-arm after sending a fix list. It is disarmed when the agent reports (a SubagentHandback the engine delivered to the orchestrator, or a SendMessage to it) or ends its run. A handback the engine refused or rerouted to main doesn't count. A check-in on a teammate survives its turn ends (a teammate ends a turn whenever it waits); only its SendMessage, or its ending for good, disarms it. If it fires (once), the mod wakes the orchestrator with `[orchestrator mod] check-in: <name> (id …) has not reported after N min; status …, last active hh:mm`; the orchestrator then checks the agent (`/orch roster`, or a SendMessage nudge) rather than waiting on. The tool is in the prompt's tool list, not behind ToolSearch, and a subagent orchestrator with the default tools can call it. If the orchestrator's agent definition restricts `tools`, add `mcp__orchestrator__checkin` to that list (that case is untested).
- **Report routing**: a child's SubagentHandback reaches the orchestrator directly, and wakes it if it is idle. The mod's forward is the safety net: at the end of each run of a background child, it forwards the final answer to the parent agent (`[orchestrator mod] final report of <name> … auto-forwarded:`), or to the parent's replacement, so grandchildren's reports go to the orchestrator, not to the main session. The forward is skipped when the child's last act was a delivered report (a handback that reached the orchestrator, or a SendMessage to it), or when that report says the same as the answer. Otherwise it comes marked `(may duplicate a message it sent you)` if the child sent something that run, so treat a near-copy as one report. When the parent is a teammate, the engine refuses or reroutes every handback; the forward then carries every report, foreground children included, and the mod warns in the activity log. Check-in wake-ups, idle HANDOVERs, forwarded reports, respawns, and background-command and idle nudges are queued and sent at the next turn end of any agent (an engine limit). A run woken that way can't send its own queued messages, so they wait for another agent's turn end. If the session stays quiet, the mod sends main one `[orchestrator mod] queued messages…` prompt to deliver them (expect 30 seconds or more of delay); the main session can ignore that prompt. Teammates, and foreground children of a subagent, are not forwarded (their answers arrive anyway), except a replacement, whose answer is always forwarded under the same check.
- **Escalation**: stop and report rather than guess when a decision exceeds the user's decisions, a paid call looks necessary, or gates can't go green.
- **Final report** (max ~300 words): decisions taken, commits (hash + subject), gate results with counts, outcome of the expensive phase, backlog items, anything left for the user.

## 3. Context limits: the mod does it

Hard ceiling 500k tokens per agent; the mod acts at `agentThreshold` (450k).

**What the mod does, at every depth, orchestrator included:**
1. Tracks each agent's context from its model requests (nothing to poll).
2. Past the threshold, gives the agent `HANDOVER` with a note path under `.orchestrator/<run>/handover/`: with its next tool result while it works (a busy teammate reads messages only between turns), or as a message when it is idle.
3. Once the agent ends with the note written, spawns a replacement: the original brief, type and model, plus "start from the handover note at …". A named agent's replacement gets the name with a suffix while the original holds it (`impl-3` → `impl-3-2`).
4. Tells the old agent's parent: `[orchestrator mod] Agent <name> (id …) … handed over … Replacement id … (SendMessage name "…") … do not spawn another.`
5. If the spawn fails: `[orchestrator mod] Agent <name> … handed over …, but no replacement started: <reason>. … Spawn the replacement yourself …`

**What the orchestrator must do** (put this in the brief):
- On an `[orchestrator mod]` notice: **don't spawn a replacement** unless the notice says `no replacement started` (then spawn one as it says: same name, type and model, the brief file as the prompt, and record the new name and id); update the task roster (old → new name and id), and send all later messages for that task (adjudicated fix lists, re-review requests) to the **new name** the notice gives. Messages sent to the old name are redirected to the replacement, and the sender is told the new name. Use the new name anyway. An implementer mid-review-loop hands the loop over in its note.
- On an `[orchestrator mod] You are registered as <name> …` notice (a named orchestrator only): that is its real name, for any message it asks a child to send it.
- Never hand agents over itself, and never send `HANDOVER` on its own initiative.
- Its own handover works the same way: its note lists every live child (name, id, state) and the task roster path, and its replacement adopts them.

**Main session.** With `ask`, the pane's `Hand over main` button restarts it at any time, and near `mainThreshold` the mod also offers **Hand over & restart** above the prompt (with `auto` it acts on its own): the main session writes its note, the mod runs `/clear` and submits the note with the live agents and the run roster. Running agents survive `/clear`. If a restart is cut short (Esc), the next message carries on and the mod settles itself.

**Rosters.** The orchestrator's task roster (`<scratchpad>/<task>/roster.md`): one line per agent with name, id, role, task and status. It maps agents to roles. The mod's run roster (`.orchestrator/<run>/roster.md`, also `/orch roster`) has each agent's status, context, peak, note path and replaced-by links.

**Tools:** `/orch` opens the pane (agent tree with each agent's model, effort and coloured status, context over time, activity log; clicking a subagent, or main, opens its Timeline over the pane, one line per turn; pressing a row jumps to that turn in the transcript, the `▸` fold glyph beside it expands the turn, and clicking a tool call in a turn opens that call's detail, for the person, not your context) and `/orch close` closes it; an agent shown as `waiting` is idle with live children, which is normal for an orchestrator between reports; a dim `↻` marks a finished agent that was messaged again and resumed; the `▾`/`▸` glyph before a row (or `c` with the pane focused, on the selected row or main) collapses its finished descendants into `+N done` (live agents always stay visible); `/orch handover <name or id>` hands an agent over now; `/orch handover` restarts the main session. In ask mode the pane has a `Hand over main` button on both the terminal and the desktop app. In the desktop app the pane also shows a context chart and a `Hand over` button beside each live subagent, which do what `/orch handover` does, so `/orch` is optional there.

## 4. Main session while it runs

- Wait for notifications; don't read agent transcripts into your context (they're huge). `/orch roster` or the pane is the cheap progress check. The main session may call `mcp__orchestrator__checkin` on the orchestrator (its own child) with its estimate plus buffer; a due check-in arrives as a prompt that wakes the main session, plus a toast.
- **If the main session is the orchestrator** (it spawns the workers itself), it follows §2's spawning and check-in rules, and may also arm a one-shot `CronCreate` (`recurring: false`, a pinned minute) per agent at the same deadline, and `CronDelete` it when the report arrives. Cron prompts land only in the main session, so this doesn't work for a subagent orchestrator. The engine already tells the main session when its own background agents finish, so the mod doesn't forward those.
- `[orchestrator mod]` notices about the orchestrator's children are for its roster; the main session needs to act only when its own child (the orchestrator) was replaced: from then on, address the replacement by the id (or name) the notice gives.
- The main session gets no background-command or idle nudges: the engine wakes it itself, and a long-running background command of its own shows as a warning toast. An `[orchestrator mod] … background command …` or `[orchestrator mod] you've been idle …` message to an agent is the mod's (a finished command the agent hadn't picked up, one running past the ceiling, or an idle agent with nothing running); the agent acts on it, and the main session needs to do nothing.
- Relay the orchestrator's escalations to the user; never answer them on the user's behalf.
- When the orchestrator reports, check `git log` on the branch and summarise for the user.
