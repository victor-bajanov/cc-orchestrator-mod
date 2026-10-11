---
name: orchestrated-run
description: |
  Run a multi-task code change end to end through a delegated orchestrator subagent that drives TDD implementers, read-only reviewers and an adjudicator, commits in waves on a branch, and gates expensive steps behind a fresh /code-review. The orchestrator mod (this plugin) keeps every agent, and the main session, under its context ceiling with handover-note restarts. Use when the user asks to "run a subagent orchestrator", "have an orchestrator do task X", work through a backlog or plan with implementer/reviewer agents, or mentions the implementer → reviewer → adjudicator loop, handover notes, or monitoring subagent context.
---

# Orchestrated run

The main session stays small: it settles the user's decisions, spawns **one orchestrator subagent**, and otherwise waits. The orchestrator runs the whole job through its own subagents. Subagents can spawn subagents (nesting works; the child's completion notifies its parent). The **orchestrator mod** watches every agent's context and handles handovers, so nobody polls transcripts.

```
main session ── decisions; restarted from a note by the mod near its ceiling
  └─ orchestrator ── plan, briefs, task roster, wave commits; writes no production code
       ├─ investigator / planner
       ├─ implementer (TDD) ⇄ reviewer (read-only) → adjudicator → same implementer
       ├─ fresh code-review agent  (gate before expensive steps)
       └─ final adjudicator (whole diff, all gates, in-browser check)
the mod ── context of every agent, HANDOVER, respawn, run roster, pane (/orch)
```

## 1. Main session: before spawning

1. **Ask the decisions only the user can make, in one AskUserQuestion**, and pass the answers into the brief as "already decided, do not re-ask". Typical: who picks design parameters (orchestrator decides vs proposes-and-waits), how existing assets/data are treated, whether paid API calls are allowed (and a cap), and how the run finishes (stop on branch vs merge and push).
2. **Create the work branch** yourself (`git checkout -b <task-slug>`) so the orchestrator never touches the default branch.
3. Make `<scratchpad>/<task>/roster.md` for the orchestrator's **task roster**. Handover notes and the mod's run roster live in the mod's run folder (`<project>/.orchestrator/<run>/`); don't make a handover folder.
4. Check the mod's settings in `/config` match the run: `agentThreshold` and `mainThreshold` (450000 for a 500k ceiling), `mainHandover` (`ask` offers a button above the prompt, `auto` restarts on its own), `autoRespawn` and `injectClause` on.

## 2. The orchestrator brief (checklist)

Spawn with `subagent_type: general-purpose`, `model: opus`, `name: orchestrator`. The brief must contain:

- **Read first**: repo CLAUDE.md (its orchestration section, if any, is binding), relevant memory feedback notes, and the docs/sections the task touches. Tell it to keep its own reading lean and delegate wide investigation.
- **The task**, with the known dependent artefacts, and "find the rest via an investigation subagent and put them in the plan".
- **User decisions** verbatim.
- **Branch and commit rules**: work on the named branch; the orchestrator alone commits, in waves, staging only each approved task's files; the exact attribution trailer; never push, merge, touch the default branch or rewrite history (unless the user chose otherwise).
- **Process**:
  1. *Plan*: a subagent investigates and writes `docs/plans/<date>-<task>.md`, verified against the code, no placeholders, open questions decided, tasks split with **non-overlapping file scopes** for parallel implementers, expensive steps as a separate late phase. Commit it.
  2. *Implement*: an `implementer` per task (TDD: failing test first, watch it fail, implement, watch it pass; pass this rule on), parallel where scopes are independent. Each gets its own `reviewer`. **Reviewers are read-only and only return feedback.** Findings go to an `adjudicator`, whose accepted fix list goes back to the **same implementer via SendMessage** (not a fresh agent); a reviewer re-checks. Trivially verified findings may go straight back. Commit each approved task.
  3. *Code-review gate*: once all code is in and **before any expensive step** (data regeneration, long harness runs, paid calls), spawn a **fresh** general-purpose opus subagent whose only job is to invoke the Skill tool with `skill: "code-review"`, `args: "high"` against `<default>...<branch>` and return findings. Route them through adjudicator → same implementer → reviewer.
  4. *Expensive phase*: run long commands in the background and wait for completion notifications; never sleep-poll.
  5. *Final review*: an `adjudicator` reviews the whole branch diff, runs every gate (lint, typecheck, unit tests, e2e, build, any tool test suites) and does an in-browser Playwright check of affected UI; accepted fixes go through the same loop. Record findings and fixes in the project backlog.
- **Agent hygiene**: use the project's `.claude/agents/` roles where they exist (they carry model/effort); Opus in every role; give every agent a `name`; brief every agent with global invariants, its file scope and who else is working concurrently on what; prefer a fresh agent per new task; ask for short reports.
- **Context-limit rules** (section 3 below). The mod appends the HANDOVER clause to every brief itself; don't paste it.
- **Waiting**: background agents notify on completion; SendMessage is deferred (`ToolSearch "select:SendMessage"`).
- **Report routing**: grandchildren's final hand-backs are delivered to the *main session*, not reliably to the orchestrator. The orchestrator must tell every agent to `SendMessage` its final report to the orchestrator by name before ending. The main session relays any hand-back that only reached it. Read-only roles (a `reviewer` limited to Read/Grep/Glob/Bash) have no SendMessage, so their verdicts *always* land in the main session: either add SendMessage to the reviewer's tool list or plan for the main session to relay every verdict.
- **Escalation**: stop and report rather than guess when a decision exceeds the user's decisions, a paid call looks necessary, or gates can't go green.
- **Final report** (max ~300 words): decisions taken, commits (hash + subject), gate results with counts, outcome of the expensive phase, backlog items, anything left for the user.

## 3. Context limits: the mod does it

Hard ceiling 500k tokens per agent; the mod acts at `agentThreshold` (450k).

**What the mod does, at every depth, orchestrator included:**
1. Tracks each agent's context from its model requests (nothing to poll).
2. Past the threshold, gives the agent `HANDOVER` with a note path under `.orchestrator/<run>/handover/`: with its next tool result while it works (a busy teammate reads messages only between turns), or as a message when it is idle.
3. Once the agent ends with the note written, spawns a replacement: the original brief, type and model, plus "start from the handover note at …". A named agent's replacement gets the name with a suffix while the original holds it (`impl-3` → `impl-3-2`).
4. Tells the old agent's parent: `[orchestrator mod] Agent <name> (id …) … handed over … Replacement id … (SendMessage name "…") … do not spawn another.`

**What the orchestrator must do** (put this in the brief):
- On an `[orchestrator mod]` notice: **don't spawn a replacement**, update the task roster (old → new name and id), and send all later messages for that task (adjudicated fix lists, re-review requests) to the **new name** the notice gives. An implementer mid-review-loop hands the loop over in its note.
- Never hand agents over itself, and never send `HANDOVER` on its own initiative.
- Its own handover works the same way: its note lists every live child (name, id, state) and the task roster path, and its replacement adopts them.

**Main session.** Near `mainThreshold` the mod offers **Hand over & restart** above the prompt (or acts, with `auto`): the main session writes its note, the mod runs `/clear` and submits the note with the live agents and the run roster. Running agents survive `/clear`. If a restart is cut short (Esc), the next message carries on and the mod settles itself.

**Rosters.** The orchestrator's task roster (`<scratchpad>/<task>/roster.md`): one line per agent with name, id, role, task and status. It maps agents to roles. The mod's run roster (`.orchestrator/<run>/roster.md`, also `/orch roster`) has each agent's status, context, peak, note path and replaced-by links.

**Tools:** `/orch` opens the pane (agent tree, context over time, activity log) and `/orch close` closes it; `/orch handover <name or id>` hands an agent over now; `/orch handover` restarts the main session. In the desktop app the pane shows a context chart, a `Hand over` button beside each live subagent and a `Hand over main` button, which do what `/orch handover` does, so `/orch` is optional there.

## 4. Main session while it runs

- Wait for notifications; don't read agent transcripts into your context (they're huge). `/orch roster` or the pane (in the desktop app, the pane) is the cheap progress check.
- `[orchestrator mod]` notices about the orchestrator's children are for its roster; the main session needs to act only when its own child (the orchestrator) was replaced: from then on, address the replacement by the name the notice gives.
- Relay the orchestrator's escalations to the user; never answer them on the user's behalf.
- When the orchestrator reports, check `git log` on the branch and summarise for the user.
