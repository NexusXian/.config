#!/usr/bin/env python3
"""Claude Code hook -> agent-tracker bridge.

Wire as a command hook for UserPromptSubmit, Stop and Notification.
Reads the hook JSON from stdin and sends start_task / finish_task / notify
to the tracker socket for the current tmux pane ($TMUX_PANE).
"""
import json
import os
import re
import socket
import sys
import tempfile


def socket_path():
    return os.environ.get("TRACKER_SOCKET") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir(), "agent-tracker.sock"
    )


def summarize(text, limit):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def send(payload):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.8)
            sock.connect(socket_path())
            sock.sendall((json.dumps({"kind": "command", **payload}) + "\n").encode())
            sock.recv(4096)  # wait for ack
    except OSError:
        pass  # tracker not running: never block Claude


def last_assistant_text(transcript):
    """Fallback for Claude Code versions without last_assistant_message."""
    try:
        with open(transcript, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content") or []
        if isinstance(content, str):
            return content
        text = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
        if text.strip():
            return text
    return ""


def main():
    pane = os.environ.get("TMUX_PANE", "")
    if not re.fullmatch(r"%\d+", pane):
        return
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    event = data.get("hook_event_name", "")
    base = {"pane": pane, "cwd": data.get("cwd", "")}

    if event == "UserPromptSubmit":
        summary = summarize(data.get("prompt", ""), 80)
        if summary:
            send({**base, "command": "start_task", "summary": summary})
    elif event == "Stop":
        if data.get("stop_hook_active"):
            return
        note = data.get("last_assistant_message") or last_assistant_text(data.get("transcript_path", ""))
        send({**base, "command": "finish_task", "summary": summarize(note, 600) or "Done"})
    elif event == "Notification":
        # Idle reminders fire after the task already finished; only forward permission asks.
        if data.get("notification_type") == "idle_prompt" or "waiting for your input" in data.get("message", ""):
            return
        message = summarize(data.get("message", ""), 200)
        if message:
            send({**base, "command": "notify", "summary": message})


if __name__ == "__main__":
    main()
