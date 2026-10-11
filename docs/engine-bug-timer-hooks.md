# Bug: a run a mod starts from a `$.clock` timer loses that mod's hooks

**Versions:** Claude Code 2.1.296 (terminal) and 2.1.295 (the desktop app's bundled engine). Both reproduce.

Finding 1 is the bug to file. Finding 2 is documented behaviour that is easy to trip over across a send; it is here because it shapes the workaround, and because it shows finding 1 isn't the same rule.

## Finding 1: a run started from a `$.clock` timer has no `tool.call` or `turn.step` hooks

### Summary

A mod can call `$.session.send` or `$.agent.spawn` from a `$.clock.after` or `$.clock.every` callback. The run that call starts gets none of that mod's `tool.call` or `turn.step` hooks. So a call to the mod's own registered tool fails with "no tool.call hook answered this call", and the mod sees none of the run's steps. `turn.complete` still fires for the run. The hook's `.catch` handler is never invoked, so the mod gets no error either.

The same `$.session.send` or `$.agent.spawn`, awaited inside a hook (`tool.call`, `turn.complete`, `command.run`), starts a run that keeps every hook. `$.prompt.submit` from a timer also keeps main's hooks.

### Expected

A run started by a mod's `$.session.send` or `$.agent.spawn` gets the same hooks whether the call was made from a hook or from a `$.clock` timer. If timers are deliberately a different context, the docs (`ClockApi`, `SessionSendAddress`) should say so, and the call should reject rather than start a run that can't use the mod's tools.

### Actual

In the timer case, the run's calls to `mcp__<plugin>__<tool>` fail with `no tool.call hook answered this call: add on('tool.call', …)`, and no `turn.step` hook fires for its steps. `turn.complete` fires. No `.catch` on `tool.call`, `turn.step` or `turn.complete` runs.

### Minimal repro

A plugin `x`:

```ts
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ping',
      description: 'Call with {}',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    return next(e)
  })
  on('tool.call', { tool: 'mcp__x__ping' }, async () => ({ result: 'pong' }) as never)
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId) {
      // A: from a timer. The resumed run's ping fails.
      $.clock.after(1500, () => void $.session.send({ to: { agentId: e.agentId! }, text: 'call mcp__x__ping' }))
      // B: awaited here instead, it works:
      // await $.session.send({ to: { agentId: e.agentId }, text: 'call mcp__x__ping' })
    }
    return res
  })
}
```

1. In the main session, spawn a background general-purpose subagent and let it finish its first run.
2. **A:** after 1.5 s the timer sends it "call mcp__x__ping". It resumes and calls the tool. The result is `no tool.call hook answered this call`.
3. **B:** the same send, awaited inside the hook, resumes it and the call returns `pong`.
4. The same holds for `$.agent.spawn({ prompt: 'call mcp__x__ping', … })`. From a timer, the spawned agent's call fails and no `turn.step` fires for it; awaited inside a `tool.call` hook, it works.

(Guard B against looping in a real test, since the resumed run ends and fires `turn.complete` again.)

### Observations from the probe

The probe plugin, headless runs and logs are in the session scratchpad `probe-send/`: `hooks/register.ts`, `prompt*.txt`, `run*.jsonl`, and `markers.log`. `markers.log` holds the last run only. The probe source changed between runs; only the last version is kept.

| run | engine | how the subagent's run was started | its `mcp__probe__ping` |
| --- | --- | --- | --- |
| `run.jsonl` | 2.1.296 | `$.session.send` from `$.clock.after` (`kid-timer`) and from `$.clock.every` (`kid-every`) | failed, "no tool.call hook answered" |
| `run.jsonl` | 2.1.296 | `$.session.send` awaited inside a hook (`kid-inline` and `kid-complete`; per the research-send-hooks report, from `tool.call` and `turn.complete`, since those probe modes' source wasn't kept) | `pong … via=hook` |
| `run4.jsonl` | 2.1.295 | `$.session.send` from a timer (`kid-timer`) | failed |
| `run5.jsonl` | 2.1.296 | `$.session.send` awaited in a `command.run` hook (`kid-command`) | `pong … via=hook` |
| `run6.jsonl` | 2.1.296 | `$.session.send` (HANDOVER) from a timer (`kid-handover`) | failed |
| `run6.jsonl` | 2.1.296 | `$.agent.spawn` awaited in a `tool.call` hook (`spawn-inline`) | `pong … via=hook` |
| `run7.jsonl` | 2.1.296 | `$.agent.spawn` from a timer (`spawn-timer`) | failed |
| `run2.jsonl` | 2.1.296 | main's turn started by `$.prompt.submit` from a timer (`main-submit`) | `pong … via=hook` |

In `markers.log` (run 7), the timer's `spawn(timer)` resolves `{"agentId":"a51dad60336b1a283"}`. The log then has a `turn.complete agent=a51dad60336b1a283` line, but no `tool.call` and no `turn.step` line for that agent. No `CATCH` line appears at all. The send or spawn itself always resolved (`{"isDelivered":true}` for sends).

## Finding 2 (documented, not a bug): re-entry is per hook registration, and it follows a send

### Summary

A run woken by a `$.session.send` made inside one hook registration R runs without R, even when the send comes after `next()`. The mod's other registrations, including other registrations of the same event, still run for it. This is the documented re-entry rule: "no hook runs under its own frame" (`HookFailure.kind`, `re-entry`, in the engine's `index.d.ts` at line 5145). What surprises is that the frame carries across a send into a different agent's run.

- A send from inside a `turn.step` registration: the woken run's steps skip that registration, so a mod tracking context there loses them.
- A send from inside a `tool.call` registration: the woken run's tool calls skip it, so if that registration is the one that answers the mod's tool, the call fails with "no tool.call hook answered".
- A send from a registration that the woken run doesn't need (for example, a `turn.complete` registration that only sends) costs nothing.

This explains finding 1's `kid-inline` row: there, the send was made from the `poke` `tool.call` registration, and the woken run's `ping` was answered by a different registration, the `ping` one.

### Suggestion

Say in the `session.send` and `agent.spawn` docs that a run they start counts as beneath the calling registration's frame.

### Repro

Start from plugin `x` in finding 1, without its `turn.complete` hook. Replace its `ping` registration with one catch-all `tool.call` registration that both answers the ping and sends:

```ts
let target: string | undefined // a finished background subagent's id, recorded at its turn.complete
on('tool.call', async ($, e, next) => {
  if (e.tool === 'mcp__x__ping') return { result: 'pong' } as never
  const res = await next(e)
  if (target && e.agentId && e.agentId !== target) {
    const to = target
    target = undefined
    await $.session.send({ to: { agentId: to }, text: 'call mcp__x__ping' })
  }
  return res
})
```

1. Spawn two background subagents. Let one finish and record its id as `target`. Keep the other making tool calls (for example, a few `sleep 25` Bash calls).
2. On the busy agent's next tool call, the registration sends to `target`. `target` resumes and calls `mcp__x__ping`. The result is `no tool.call hook answered this call`, because the only registration that answers it is the one the send came from.
3. Keep the ping in its own registration, as finding 1 has it, and send from the catch-all one: the ping returns `pong`.
4. Send from a `turn.step` registration instead, after `yield* next(e)`: the ping works, but that registration doesn't run for the woken run's steps.

### Evidence

Two headless runs of the orchestrator mod itself (2.1.296), in the session scratchpad `final/`: `runA.jsonl`, `runB.jsonl`, `promptA.txt`, `promptB.txt`, and the mod's `projA/.orchestrator/*/state.json` and `projB/…/state.json`. In both runs, a `parent` subagent arms a 0.2-minute check-in on a sleeping child, then ends; the check-in message wakes it, and it calls `mcp__orchestrator__checkin` again.

- **Run B, send inside `tool.call`.** The check-in is sent during the `ticker` agent's Bash call (`parent` receives it at 08:08:35.5, just after ticker's tool result). The woken `parent`'s `mcp__orchestrator__checkin` call returns "orchestrator registered the tool checkin but no tool.call hook answered this call". `state.json` still records that run's steps (samples at 08:08:37.497 and 08:08:40.065), so `turn.step` fired.
- **Run A, send inside `turn.step`.** The check-in is sent during main's turn (started by the mod's `[orchestrator mod] queued messages…` prompt at 08:09:00). The woken `parent` calls `mcp__orchestrator__checkin` at 08:09:06 and gets `checkin: armed…`, so `tool.call` fired. But `state.json` has no samples for its steps at 08:09:06 or 08:09:08 (samples jump from 08:08:13.330 to 08:10:14.681), so `turn.step` did not.
- **Both runs, send inside `turn.complete`.** The auto-forwarded final reports (`… (may duplicate a message it sent you), auto-forwarded`) are sent from `turn.complete`. The runs they wake are fully tracked: their steps are in `state.json` (A: 08:10:14.681; B: 08:10:26.767, 08:10:44.385).

- **Runs C and D (mod at commit d9e6000), sends from a dedicated `turn.complete` registration that does nothing but drain the queue.** Every woken run and replacement was fully tracked. In run C (`promptC.txt`, `runC.jsonl`, `projC/…/state.json`), the parent was woken by check-ins and forwards and called `mcp__orchestrator__checkin` successfully every time (9 `checkin: armed` results, none unanswered), and all 8 of its steps were recorded. In run D (`promptD.txt`, `runD.jsonl`, `projD/…/state.json`), a HANDOVER and a respawn went through the drain, and the replacement's step was recorded.

## Impact on mods

- A mod that wakes an agent on a deadline has to do it from a timer, and finding 1 means the run it wakes can't use the mod's tools and isn't tracked. The failure is silent: the send resolves as delivered and no `.catch` fires, not even with `re-entry`. The agent sees only a tool error.
- Finding 2 means the next hook isn't automatically a safe place to send from: a send from the registration that tracks steps, or that answers the mod's tool, disables it for the woken run.

## Workaround (used by the orchestrator mod)

- Timers never send or spawn.
- Cross-agent sends and spawns (check-in wake-ups, idle HANDOVER messages, forwarded reports, respawns) go into a queue (state key `outbox`).
- A dedicated `turn.complete` registration that does nothing but drain the queue sends them at the next turn end of any agent. A woken run loses only that drain registration, and keeps every hook it needs.
- A run the drain wakes or spawns can't drain the queue itself, so whatever it queues waits for another agent's turn end. If the queue survives a 30-second sync while main is idle, the mod submits one short `[orchestrator mod]` prompt to main, whose turn end drains it.
