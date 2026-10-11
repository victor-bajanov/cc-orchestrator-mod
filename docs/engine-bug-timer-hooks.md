# Bug: a run started from a `$.clock` timer runs without the plugin's `tool.call` and `turn.step` hooks

**Versions:** Claude Code 2.1.296 (terminal) and 2.1.295 (the desktop app's bundled engine). Both reproduce.

## Summary

A mod can call `$.session.send` or `$.agent.spawn` from a `$.clock.after` or `$.clock.every` callback. The run that call starts gets none of that mod's `tool.call` or `turn.step` hooks. So a call to the mod's own registered tool fails with "no tool.call hook answered this call", and the mod sees none of the run's steps. `turn.complete` still fires for the run. The hook's `.catch` handler is never invoked, so the mod gets no error either.

The same `$.session.send` or `$.agent.spawn`, awaited inside a hook (`tool.call`, `turn.complete`, `command.run`), starts a run that keeps every hook. `$.prompt.submit` from a timer also keeps main's hooks.

## Expected

A run started by a mod's `$.session.send` or `$.agent.spawn` gets the same hooks whether the call was made from a hook or from a `$.clock` timer. If timers are deliberately a different context, the docs (`ClockApi`, `SessionSendAddress`) should say so, and the call should reject rather than start a run that can't use the mod's tools.

## Actual

In the timer case, the run's calls to `mcp__<plugin>__<tool>` fail with `no tool.call hook answered this call: add on('tool.call', …)`, and no `turn.step` hook fires for its steps. `turn.complete` fires. No `.catch` on `tool.call`, `turn.step` or `turn.complete` runs.

## Minimal repro

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

## Observations from the probe

The probe plugin, headless runs and logs are in the session scratchpad `probe-send/`: `hooks/register.ts`, `prompt*.txt`, `run*.jsonl`, and `markers.log`. `markers.log` holds the last run only. The probe source changed between runs; only the last version is kept.

| run | engine | how the subagent's run was started | its `mcp__probe__ping` |
| --- | --- | --- | --- |
| `run.jsonl` | 2.1.296 | `$.session.send` from `$.clock.after` (`kid-timer`) and from `$.clock.every` (`kid-every`) | failed, "no tool.call hook answered" |
| `run.jsonl` | 2.1.296 | `$.session.send` awaited inside a hook (`kid-inline`, from `tool.call`; `kid-complete`, from `turn.complete`, per the research-send-hooks report, since that probe mode's source wasn't kept) | `pong … via=hook` |
| `run4.jsonl` | 2.1.295 | `$.session.send` from a timer (`kid-timer`) | failed |
| `run5.jsonl` | 2.1.296 | `$.session.send` awaited in a `command.run` hook (`kid-command`) | `pong … via=hook` |
| `run6.jsonl` | 2.1.296 | `$.session.send` (HANDOVER) from a timer (`kid-handover`) | failed |
| `run6.jsonl` | 2.1.296 | `$.agent.spawn` awaited in a `tool.call` hook (`spawn-inline`) | `pong … via=hook` |
| `run7.jsonl` | 2.1.296 | `$.agent.spawn` from a timer (`spawn-timer`) | failed |
| `run2.jsonl` | 2.1.296 | main's turn started by `$.prompt.submit` from a timer (`main-submit`) | `pong … via=hook` |

In `markers.log` (run 7), the timer's `spawn(timer)` resolves `{"agentId":"a51dad60336b1a283"}`. The log then has a `turn.complete agent=a51dad60336b1a283` line, but no `tool.call` and no `turn.step` line for that agent. No `CATCH` line appears at all. The send or spawn itself always resolved (`{"isDelivered":true}` for sends).

## Impact on mods

- A mod that wakes an agent on a deadline, or forwards a report later, has to do it from a timer. The agent it wakes then can't call the mod's tools, and the mod loses its context tracking (`turn.step`) and HANDOVER attachment (`tool.call`) for that run.
- The failure is silent: the send resolves as delivered and no `.catch` fires. The agent sees only a tool error.
- **Workaround** (used by the orchestrator mod): timers never send or spawn. Its one timer-driven message, a check-in wake-up for a subagent, is queued, and the next hook drains the queue. If the queue survives a sync while main is idle, one short `$.prompt.submit` to main starts a turn whose hooks drain it.
