# /// script
# requires-python = ">=3.11"
# ///
"""Repro: an idle background subagent is not woken by its own background shell's
task-notification while main is busy. See docs/engine-bug-bg-shell-wake.md.

Run:  uv run docs/repro/bg_shell_wake.py [--interactive] [--teammate] [--keep-user-settings]
                                         [--sub-sleep 20] [--main-sleep 75] [--idle 45]

One session on haiku in a fresh scratch directory. By default it is headless
(`claude -p`, stream-json in and out, so it stays open between prompts);
--interactive drives the terminal UI through a pseudo-terminal instead.

  prompt 1  Main spawns one background general-purpose subagent. The subagent runs
            `sleep SUB` through Bash with run_in_background: true and ends its turn.
            When the shell's completion notice reaches it, it must `touch` a marker.
            Main then runs a foreground `sleep MAIN` and ends its turn.
  phase A   main is busy in its foreground sleep (with MAIN > SUB, the shell
            completes here, while the subagent is idle).
  phase B   main's turn has ended; nothing is sent for IDLE seconds.
  prompt 2  Main is asked to `ls` the marker; then IDLE more seconds (phase C).

With --main-sleep shorter than --sub-sleep (e.g. 2), the shell completes in
phase B instead, while every agent is idle.

The script then reads the transcripts under ~/.claude/projects and prints when the
shell's task-notification was queued (main transcript `queue-operation` enqueue),
when it left the queue and how (`remove`, with a reason), when it reached the
subagent, when the marker was written, and a verdict.

By default the session ignores user and project settings (no plugins, no user
hooks) so a mod can't interfere; --keep-user-settings loads them. --teammate
gives the subagent a name, so with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (set by
this script) it runs as an agent-teams teammate, as in the original stall.
"""
import argparse
import json
import os
import pty
import queue
import re
import select
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECTS = Path.home() / ".claude" / "projects"


def now():
    return datetime.now(timezone.utc)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def iso(t):
    return t.astimezone(timezone.utc).strftime("%H:%M:%S.%f")[:-3] if t else "-"


def content(d):
    m = d.get("message")
    c = m.get("content") if isinstance(m, dict) else None
    return c if isinstance(c, list) else []


def child_env(teammate):
    # Don't let the child think it is part of the session that runs this script.
    env = {k: v for k, v in os.environ.items()
           if not (k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_") or k == "CLAUDE_PID")}
    env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"] = "1"
    if not teammate:
        env.pop("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")
    return env


def main_transcript(sid):
    return next(PROJECTS.glob(f"*/{sid}.jsonl"), None)


def wait_turn_end(sid, after, timeout, quiet=3.0):
    """Interactive mode: main's turn has ended when its last transcript entry is a
    text-only assistant message newer than `after` and the file is quiet."""
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(1)
        tx = main_transcript(sid)
        if not tx or time.time() - tx.stat().st_mtime < quiet:
            continue
        rows = [json.loads(l) for l in open(tx) if l.strip()]
        last = next((d for d in reversed(rows) if d.get("type") in ("assistant", "user")), None)
        if (last and last["type"] == "assistant" and ts(last.get("timestamp")) > after
                and all(x.get("type") == "text" for x in content(last)) and content(last)):
            return ts(last["timestamp"])
    return None


def run_headless(cmd, work, env, prompt1, prompt2, args):
    cmd = cmd[:1] + ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
                     "--verbose"] + cmd[1:]
    out = open(work / "run.jsonl", "w")
    p = subprocess.Popen(cmd, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
    results = queue.Queue()

    def pump():
        for line in p.stdout:
            out.write(line)
            out.flush()
            try:
                if json.loads(line).get("type") == "result":
                    results.put(now())
            except json.JSONDecodeError:
                pass

    threading.Thread(target=pump, daemon=True).start()

    def send(text):
        p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
        p.stdin.flush()

    marks = {}
    send(prompt1)
    try:
        marks["turn1_end"] = results.get(timeout=args.main_sleep + 240)
    except queue.Empty:
        p.kill()
        return None
    time.sleep(args.idle)
    marks["extra"] = []  # turns main ran on its own (woken by the subagent's report)
    while not results.empty():
        marks["extra"].append(results.get())
    marks["prompt2"] = now()
    send(prompt2)
    try:
        marks["turn2_end"] = results.get(timeout=240)
    except queue.Empty:
        marks["turn2_end"] = None
    time.sleep(args.idle)
    p.stdin.close()
    try:
        p.wait(timeout=120)
    except subprocess.TimeoutExpired:
        p.kill()
    return marks


def run_interactive(cmd, work, env, sid, prompt1, prompt2, args):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe(cmd[0], cmd, env)
    log = open(work / "pty.log", "wb")
    stop = threading.Event()
    seen = {"trust": None, "ready": None}

    def pump():
        while not stop.is_set():
            r, _, _ = select.select([fd], [], [], 0.5)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            log.write(data)
            log.flush()
            low = data.lower()
            if b"trust" in low and not seen["trust"]:
                seen["trust"] = time.time()
            if b"shift+tab" in low or b"? for shortcuts" in low:
                seen["ready"] = time.time()

    threading.Thread(target=pump, daemon=True).start()

    def type_line(text):
        os.write(fd, text.replace("\n", " ").encode())
        time.sleep(1.0)
        os.write(fd, b"\r")

    t_end = time.time() + 60
    while time.time() < t_end and not seen["ready"]:
        time.sleep(0.5)
        if seen["trust"] and time.time() - seen["trust"] > 1.5 and seen["trust"] > 0:
            os.write(fd, b"\x1b[B")  # "Yes, I trust this folder"
            time.sleep(0.5)
            os.write(fd, b"\r")
            seen["trust"] = -1
    time.sleep(3)
    marks = {"extra": []}
    t1 = now()
    type_line(prompt1)
    marks["turn1_end"] = wait_turn_end(sid, t1, args.main_sleep + 240)
    if not marks["turn1_end"]:
        stop.set()
        os.kill(pid, 9)
        return None
    time.sleep(args.idle)
    marks["prompt2"] = now()
    type_line(prompt2)
    marks["turn2_end"] = wait_turn_end(sid, marks["prompt2"], 240)
    time.sleep(args.idle)
    stop.set()
    os.kill(pid, 9)
    return marks


def analyse(sid, marker, marks):
    main_tx = main_transcript(sid)
    subs = sorted(PROJECTS.glob(f"*/{sid}/subagents/*.jsonl"))
    if not main_tx or not subs:
        return f"INCONCLUSIVE (main transcript={main_tx}, subagent transcripts={len(subs)})"

    shell_tid, shell_rib, sub_turns, delivered = None, None, [], None
    for sub in subs:
        for line in open(sub):
            d = json.loads(line)
            c = content(d)
            if d.get("type") == "assistant" and c:
                sub_turns.append(ts(d.get("timestamp")))
            for x in c:
                if x.get("type") == "tool_use" and x.get("name") == "Bash" and shell_rib is None:
                    shell_rib = x["input"].get("run_in_background")
                if x.get("type") == "tool_result" and not shell_tid:
                    hit = re.search(r"running in background with ID: (\w+)", json.dumps(x.get("content")))
                    if hit:
                        shell_tid = hit.group(1)
            a = d.get("attachment") or {}
            if delivered is None and shell_tid:
                if a.get("commandMode") == "task-notification" and shell_tid in a.get("prompt", ""):
                    delivered = (ts(d.get("timestamp")), "queued_command attachment (mid-turn)")
                elif d.get("type") == "user" and shell_tid in json.dumps(d.get("message")) \
                        and "task-notification" in json.dumps(d.get("message")):
                    delivered = (ts(d.get("timestamp")), "new user turn")

    enq = rem = None
    for line in open(main_tx):
        d = json.loads(line)
        if d.get("type") == "queue-operation" and shell_tid and shell_tid in str(d.get("content", "")):
            if d.get("operation") == "enqueue" and enq is None:
                enq = ts(d.get("timestamp"))
            elif d.get("operation") != "enqueue" and rem is None:
                rem = (ts(d.get("timestamp")), d.get("operation"), d.get("reason"))

    marker_t = datetime.fromtimestamp(marker.stat().st_mtime, timezone.utc) if marker.exists() else None

    def phase(t):
        if t is None:
            return "never"
        if t < marks["turn1_end"]:
            return "A (main busy in its first turn)"
        if t < marks["prompt2"]:
            return "B (main idle after its first turn)"
        if marks.get("turn2_end") and t < marks["turn2_end"]:
            return "prompt 2 (main's second turn)"
        return "C (after main's second turn)"

    print(f"\nsubagent shell: task id {shell_tid}, run_in_background={shell_rib}")
    print(f"main turn 1 ended            {iso(marks['turn1_end'])}")
    print(f"main's own extra turns ended {[iso(t) for t in marks['extra']]}")
    print(f"prompt 2 sent                {iso(marks['prompt2'])}")
    print(f"main turn 2 ended            {iso(marks.get('turn2_end'))}")
    print(f"shell notice enqueued        {iso(enq)}  phase {phase(enq)}")
    print(f"shell notice left the queue  {iso(rem[0]) if rem else 'never'}  {rem[1:] if rem else ''}")
    print(f"shell notice reached subagent {iso(delivered[0]) if delivered else 'never'}"
          f"  {delivered[1] if delivered else ''}")
    print(f"subagent assistant entries   {[iso(t) for t in sub_turns]}")
    print(f"marker written               {iso(marker_t)}  phase {phase(marker_t)}")

    start = enq or (delivered[0] if delivered else None)
    if start is None:
        return "INCONCLUSIVE (no task-notification for the subagent's shell was found)"
    if marker_t is None:
        v = "BUG REPRODUCED: the shell's notice was queued but the idle subagent never resumed"
    elif (marker_t - start).total_seconds() <= 15:
        v = "NOT REPRODUCED: the subagent resumed promptly on its own shell's notice"
    else:
        v = (f"BUG REPRODUCED: the subagent resumed {(marker_t - start).total_seconds():.0f}s "
             f"after its notice was queued, in phase {phase(marker_t)}")
    if rem and abs((rem[0] - marks["turn1_end"]).total_seconds()) <= 3:
        v += "; the notice left the queue as main's first turn ended"
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interactive", action="store_true")
    ap.add_argument("--teammate", action="store_true")
    ap.add_argument("--keep-user-settings", action="store_true")
    ap.add_argument("--sub-sleep", type=int, default=20)
    ap.add_argument("--main-sleep", type=int, default=75)
    ap.add_argument("--idle", type=int, default=45)
    args = ap.parse_args()

    work = Path(tempfile.mkdtemp(prefix="bg-shell-wake-")).resolve()
    marker = work / "RESUMED"
    sid = str(uuid.uuid4())
    sub_prompt = (
        f"Step 1: call the Bash tool ONCE with command `sleep {args.sub_sleep}; echo shell-done` "
        "and run_in_background set to true. "
        "Step 2: immediately end your turn with the single sentence "
        "'Waiting for the background shell; I will continue when notified.' "
        "Do not poll, do not read the output file, do not sleep, do not call any other tool. "
        "Step 3 (only later, when a task-notification tells you the shell completed): "
        f"call Bash with command `touch {marker}` and then end."
    )
    prompt1 = (
        "Do exactly these steps and nothing else.\n"
        "1. Use the Agent tool with subagent_type general-purpose, run_in_background true, "
        "description 'bg shell waiter', "
        + ("name 'waiter', " if args.teammate else "")
        + "and this prompt, copied verbatim:\n"
        f"<<<{sub_prompt}>>>\n"
        f"2. Then call Bash (foreground, NOT in background, timeout 300000) with command "
        f"`sleep {args.main_sleep}`. Do not message, check on or wait for the subagent in any other way.\n"
        "3. End your turn with one short sentence. Ignore any notification about the subagent."
    )
    prompt2 = (f"Call Bash with command `ls -l {marker} || echo NO_MARKER`, report what it printed "
               "in one line, and end your turn. Do not message or check on any subagent.")

    cmd = ["claude", "--model", "haiku", "--session-id", sid, "--allowedTools", "Bash", "Agent"]
    if not args.keep_user_settings:
        cmd += ["--setting-sources", "local"]
    env = child_env(args.teammate)

    version = subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip()
    mode = "interactive" if args.interactive else "headless"
    print(f"engine: {version}\nmode: {mode}{', teammate' if args.teammate else ''}"
          f"{', user settings' if args.keep_user_settings else ''}\n"
          f"sub-sleep {args.sub_sleep}s, main-sleep {args.main_sleep}s, idle {args.idle}s\n"
          f"workdir: {work}\nsession: {sid}", flush=True)

    if args.interactive:
        marks = run_interactive(cmd, work, env, sid, prompt1, prompt2, args)
    else:
        marks = run_headless(cmd, work, env, prompt1, prompt2, args)
    time.sleep(2)
    if not marks:
        print("VERDICT: INCONCLUSIVE (main's first turn did not end)")
        return
    print(f"VERDICT: {analyse(sid, marker, marks)}")


if __name__ == "__main__":
    main()
