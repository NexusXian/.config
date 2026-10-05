#!/usr/bin/env python3
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time


EVENTS = {
    "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
    "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd",
}


class HookTimeout(Exception):
    pass


def text(value):
    return value.strip() if isinstance(value, str) else ""


def run(args):
    try:
        result = subprocess.run(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, timeout=0.3,
        )
        return result.stdout.rstrip("\n") if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def current_target(data):
    pane = os.environ.get("TMUX_PANE", "")
    if not re.fullmatch(r"%\d+", pane):
        return None
    fields = (
        "session_name", "session_id", "window_name", "window_id", "pane_id",
        "pane_current_path",
    )
    output = run([
        "tmux", "display-message", "-p", "-t", pane,
        "\x1f".join("#{" + field + "}" for field in fields),
    ]).split("\x1f")
    if len(output) != len(fields):
        return None
    session, session_id, window, window_id, actual_pane, pane_cwd = output
    if (actual_pane != pane or not re.fullmatch(r"\$\d+", session_id)
            or not re.fullmatch(r"@\d+", window_id)):
        return None
    # Without -A, show-options reads only this session's local options.
    for option, expected in (("@agent_popup", "1"), ("@agent_popup_tool", "claude")):
        if run(["tmux", "show-options", "-qv", "-t", session_id, option]) != expected:
            return None
    cwd = text(data.get("cwd")) or pane_cwd
    branch = run(["git", "-C", cwd, "branch", "--show-current"]) if cwd else ""
    return {
        "session": session, "session_id": session_id,
        "window": window, "window_id": window_id, "pane": pane,
        "cwd": cwd, "branch": branch,
    }


def send(target, command, **values):
    path = os.environ.get("TRACKER_SOCKET") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir(),
        "agent-tracker.sock",
    )
    payload = {"kind": "command", "command": command, **target, **values}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.4)
            sock.connect(path)
            sock.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode())
            # Wait for a reply so successive synchronous reports stay ordered.
            sock.recv(4096)
    except (OSError, ValueError):
        pass


def report(data, target, state):
    event = data["hook_event_name"]
    session_id = text(data.get("session_id"))
    prompt_id = text(data.get("prompt_id"))
    active = state.get("active") and state.get("session_id") == session_id
    if event == "UserPromptSubmit":
        summary = " ".join(text(data.get("prompt")).split())
        summary = summary if len(summary) <= 80 else summary[:79] + "…"
        if not summary:
            return
        send(target, "update_task" if active else "start_task", summary=summary)
        state.clear()
        state.update(session_id=session_id, prompt_id=prompt_id, summary=summary,
                     active=True, confirmation=False)
        send(target, "update_phase", phase="waiting")
        return
    if not active:
        return
    if prompt_id and state.get("prompt_id") and prompt_id != state["prompt_id"]:
        return
    if event in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
        if state.get("confirmation"):
            send(target, "update_task", summary=state["summary"])
            state["confirmation"] = False
        phase = "waiting"
        if event == "PreToolUse":
            phase = "question" if data.get("tool_name") == "AskUserQuestion" else "tool"
        send(target, "update_phase", phase=phase)
    elif event == "PermissionRequest":
        send(target, "needs_confirmation", summary=state["summary"])
        state["confirmation"] = True
    else:
        if event == "Stop":
            note = text(data.get("last_assistant_message"))
        elif event == "StopFailure":
            error = text(data.get("error")) or "unknown"
            detail = text(data.get("last_assistant_message")) or text(data.get("error_details"))
            note = "Claude turn failed: " + error + (" — " + detail if detail else "")
        else:
            reason = text(data.get("reason")) or "other"
            note = "Claude session ended while a turn was active (" + reason + ")."
        # finish_task consumes summary/message as its completion note, not note.
        send(target, "finish_task", summary=note)
        state.clear()


def main():
    data = json.load(sys.stdin)
    if (not isinstance(data, dict) or text(data.get("agent_id"))
            or data.get("hook_event_name") not in EVENTS
            or not text(data.get("session_id"))):
        return
    target = current_target(data)
    if target is None:
        return
    root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    directory = root / "agent-popup"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = os.environ.get("TMUX", "").rsplit(",", 2)[0]
    key = hashlib.sha256(
        json.dumps([server, target["pane"]]).encode()
    ).hexdigest()
    fd = os.open(directory / ("claude-" + key + ".json"), os.O_RDWR | os.O_CREAT, 0o600)
    # Keep the same inode: every read, report, and write shares its pane lock.
    with os.fdopen(fd, "r+", encoding="utf-8") as file:
        deadline = time.monotonic() + 0.2
        while True:
            try:
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    return
                time.sleep(0.01)
        try:
            state = json.load(file)
        except (ValueError, UnicodeError):
            state = {}
        if not isinstance(state, dict):
            state = {}
        report(data, target, state)
        file.seek(0)
        json.dump(state, file, ensure_ascii=False)
        file.truncate()


def timeout(signum, frame):
    raise HookTimeout


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, 2.5)
        main()
    except BaseException:
        pass
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    sys.exit(0)
