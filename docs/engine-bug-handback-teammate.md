# Bug: a SubagentHandback never reaches a teammate parent

**Versions:** Claude Code 2.1.296 to 2.1.309 (terminal), agent teams on (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). The probe below ran on 2.1.309.

Tracked here as issue #9. See also [engine-bug-bg-shell-wake.md](engine-bug-bg-shell-wake.md), another bug that hits only named teammates.

## Summary

With agent teams on, every agent the main thread spawns with a `name` becomes an in-process teammate (`<name>@session-…`). An agent it spawns without a name is a plain subagent. When a teammate spawns a child, the child's `SubagentHandback` never reaches the teammate:

- If the engine counts the child as backgrounded, the report is rerouted to **main**, and the child is told `{"success":true,"message":"Report delivered to your caller."}`.
- Otherwise the call is refused: `{"success":false,"message":"Nothing was sent: the agent that spawned you is no longer running."}`. The teammate's Agent result is then `status: "completed"`, `handback: "withheld"`, with "The subagent ended without delivering a report through SubagentHandback, so no report was delivered. Its unsent text is not shown." So the report is lost.

This happens whatever the teammate is doing, including while it is blocked inside the very Agent call that started the child.

A plain subagent parent receives its child's handback even while it waits idle between turns, and is woken by it.

## Expected

A child's handback reaches the agent that spawned it, teammate or not, or is queued for that agent's next turn.

## Cause

The handback tool (2.1.309, minified names as shipped, lightly reformatted) delivers to the child's `handbackRecipient` only when `Rft(registry.get(recipient))` holds:

```js
function Rft(e){ if(!vn(e)) return false
  return e.status==="running" || e.status==="completed" && [...YR(e)].some(n => n!==J1) }
function x2n(e,n){ return e===et() || Rft(n.get(e)) }
// in call():
S = vn(x) && x.isBackgrounded && !x2n(a.recipient, registry) ? et() /* main */ : a.recipient
if (S !== main && !Rft(registry.get(a.recipient)))
  return { success:false, message:"Nothing was sent: the agent that spawned you is no longer running." }
```

`vn()` accepts only local agent tasks, so a teammate's task fails `Rft` at its first line, in every state. A plain subagent passes: while it runs, or while it is idle (`completed`) holding the `agent:<child>` keepalive the engine adds to the owner at each interactive spawn (`if(!_e()) gD(owner, \`agent:${id}\`)`, where `_e()` is `!isInteractive()`).

## Evidence

**Survey.** Every run folder under `~/code/*/.orchestrator/` from 12 to 23 October, matched against its transcripts: 9 runs, engine 2.1.296 to 2.1.309. No handback from a teammate's child reached the teammate. They went to main or nowhere. In `optical`'s run `357813d5…` (2.1.305), the teammate `orch-port-105` had 19 children with handbacks refused; 18 handbacks in that session reached main, and none reached the teammate.

**Probe (2.1.309, 23 October, session `cb57f1ef-3fd3-4aac-a62f-664391fe752a` in this repo).** Main spawned two haiku parents with the same prompt, one without a name and one named `probe-parent-named` (a teammate). Each spawned one read-only `compose-explorer` child (Read, Grep, Glob, Bash: no SendMessage), which ran a 25-second foreground loop and then called SubagentHandback.

| Parent | Child's handback | Outcome |
|---|---|---|
| unnamed subagent, idle when the child finished | `success: true` at once | delivered to the parent, which woke and quoted `PROBE-U-REPORT-5150` |
| named teammate (its Agent call ran in the foreground) | refused 4 times: "the agent that spawned you is no longer running" | Agent result `completed`, `handback: withheld`; report lost |

A first probe (an unnamed parent with an async child) also delivered to the idle parent.

## What the mod does about it

- The `orchestrated-run` skill spawns the orchestrator without a `name`, so it is a plain subagent and handbacks reach it.
- A handback the engine delivered to a live, non-teammate parent counts as the child's report: it disarms the check-in and stops a duplicate forward.
- When a teammate spawns a child, the mod warns once in the activity log. It forwards every child's final answer to the teammate, foreground children included, since the engine withholds a foreground child's answer from the teammate's Agent result.
