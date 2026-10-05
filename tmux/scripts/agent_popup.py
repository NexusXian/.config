#!/usr/bin/env python3
import argparse
import curses
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time


SCRIPT = str(Path(__file__).resolve())
PREFIX = "__agent_popup_"
TOOLS = ("opencode", "claude")


def tmux(*args, check=True, allow_popup_close=False):
    result = subprocess.run(
        ["tmux", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # Closing a display-popup -E sends SIGHUP to its job (exit status 129).
    closed_popup = (allow_popup_close and result.returncode == 128 + signal.SIGHUP
                    and not result.stdout and not result.stderr)
    if check and result.returncode and not closed_popup:
        raise RuntimeError(result.stderr.strip() or "tmux command failed")
    return result.stdout.rstrip("\n")


def pane_info(pane):
    if not re.fullmatch(r"%\d+", pane or ""):
        return None
    fields = ("session_id", "window_id", "pane_id", "pane_current_path", "pane_dead")
    output = tmux("display-message", "-p", "-t", pane,
                  "\x1f".join("#{" + field + "}" for field in fields), check=False)
    values = output.split("\x1f")
    if len(values) != len(fields) or values[2] != pane:
        return None
    return dict(zip(fields, values))


def option(target, name, pane=False):
    args = ["show-options", "-qv"]
    if pane:
        args.append("-p")
    return tmux(*args, "-t", target, name, check=False)


def set_option(target, name, value, pane=False):
    args = ["set-option"]
    if pane:
        args.append("-p")
    tmux(*args, "-t", target, name, value)


def session_name(owner, tool):
    if not re.fullmatch(r"%\d+", owner or "") or tool not in TOOLS:
        raise RuntimeError("Invalid popup owner or tool")
    return PREFIX + owner[1:] + "_" + tool


def session_pane(name):
    output = tmux("list-panes", "-t", "=" + name, "-F", "#{pane_id}", check=False)
    return output.splitlines()[0] if output else ""


def root_client(client, source=None):
    if source and option(source["session_id"], "@agent_popup") == "1":
        client = option(source["session_id"], "@agent_popup_client") or client
    clients = []
    output = tmux("list-clients", "-F",
                  "#{client_tty}\x1f#{session_id}\x1f#{client_activity}", check=False)
    for line in output.splitlines():
        values = line.split("\x1f")
        if len(values) != 3 or option(values[1], "@agent_popup") == "1":
            continue
        clients.append(values)
    for tty, _, _ in clients:
        if tty == client:
            return tty
    if source:
        owner = pane_info(option(source["session_id"], "@agent_popup_owner"))
        if owner:
            matches = [entry for entry in clients if entry[1] == owner["session_id"]]
            if matches:
                return max(matches, key=lambda entry: int(entry[2] or "0"))[0]
    if clients:
        return max(clients, key=lambda entry: int(entry[2] or "0"))[0]
    raise RuntimeError("No attached tmux client available for the popup")


def close_popup(client):
    tmux("display-popup", "-C", "-c", client, check=False)


def display(client, cwd, title, command):
    tmux("display-popup", "-E", "-c", client, "-d", cwd,
         "-w", "90%", "-h", "85%", "-T", title.replace("#", "##"),
         shlex.join(command), allow_popup_close=True)


def popup_title(tool, cwd):
    label = "Claude Code" if tool == "claude" else "OpenCode" if tool == "opencode" else "Agent"
    title = label + " · " + (Path(cwd).name or cwd) + " · Alt+d hide"
    return title + " · Alt+x exit" if tool in TOOLS else title


def attach(session):
    environment = os.environ.copy()
    socket_path = environment.get("TMUX", "").rsplit(",", 2)[0]
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)
    command = ["tmux"]
    if socket_path:
        command.extend(["-S", socket_path])
    command.extend(["attach-session", "-E", "-t", session])
    os.execvpe("tmux", command, environment)


def ensure_session(owner, tool, client):
    info = pane_info(owner)
    if not info:
        raise RuntimeError("The originating pane no longer exists")
    name = session_name(owner, tool)
    old = pane_info(session_pane(name))
    if old and old["pane_dead"] != "1":
        set_option(old["session_id"], "@agent_popup_client", client)
        set_option(owner, "@agent_popup_last", tool, pane=True)
        return old["session_id"]
    if old:
        tmux("kill-session", "-t", old["session_id"])
    token = name + "_" + str(os.getpid())
    launch = [tool]
    if tool == "claude":
        launch.extend(["--settings", str(Path(SCRIPT).parent.parent / "claude-popup.json")])
    command = shlex.join(["tmux", "wait-for", token]) + "; " + shlex.join([
        "/bin/zsh", "-lic", "proxy && " + shlex.join(launch),
    ])
    created = tmux("new-session", "-d", "-P", "-F", "#{session_id}\x1f#{pane_id}",
                   "-s", name, "-n", tool, "-c", info["pane_current_path"], command)
    session, pane = created.split("\x1f")
    try:
        for key, value in (
            ("@agent_popup", "1"), ("@agent_popup_owner", owner),
            ("@agent_popup_tool", tool), ("@agent_popup_client", client),
            ("status", "off"), ("key-table", "agent-popup"), ("prefix", "None"),
            ("prefix2", "None"), ("detach-on-destroy", "on"),
        ):
            set_option(session, key, value)
        tmux("set-option", "-w", "-t", session + ":", "remain-on-exit", "on")
        set_option(owner, "@agent_popup_last", tool, pane=True)
    except Exception:
        tmux("kill-session", "-t", session, check=False)
        raise
    tmux("wait-for", "-S", token)
    return session


def locked_session(owner, tool, client):
    server = os.environ.get("TMUX", "").rsplit(",", 2)[0]
    key = hashlib.sha256((server + owner).encode()).hexdigest()
    with open(Path(tempfile.gettempdir()) / ("agent-popup-" + key + ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return ensure_session(owner, tool, client)


def choose_tool():
    def menu(screen):
        curses.curs_set(0)
        curses.set_escdelay(25)
        selected = 0
        while True:
            screen.erase()
            height, width = screen.getmaxyx()
            lines = ["Choose an agent", "", "OpenCode (default)", "Claude Code", "",
                     "↑/↓ or j/k select · Enter start/resume · Esc / Alt+d hide",
                     "Each tool keeps its own terminal and conversation."]
            start = max(0, (height - len(lines)) // 2)
            for index, line in enumerate(lines):
                if start + index >= height:
                    break
                active = index == selected + 2
                text = ("› " if active else "  ") + line
                try:
                    screen.addnstr(start + index, max(0, (width - 68) // 2), text,
                                   max(0, width - max(0, (width - 68) // 2) - 1),
                                   curses.A_REVERSE if active else curses.A_NORMAL)
                except curses.error:
                    pass
            screen.refresh()
            key = screen.getch()
            if key in (curses.KEY_UP, ord("k")):
                selected = (selected - 1) % len(TOOLS)
            elif key in (curses.KEY_DOWN, ord("j")):
                selected = (selected + 1) % len(TOOLS)
            elif key in (10, 13, curses.KEY_ENTER):
                return TOOLS[selected]
            elif key == ord("o"):
                return "opencode"
            elif key == ord("c"):
                return "claude"
            elif key in (27, 3, ord("q")):
                return None
    return curses.wrapper(menu)


def confirm_exit(tool):
    def prompt(screen):
        curses.curs_set(0)
        curses.set_escdelay(25)
        while True:
            screen.erase()
            height, width = screen.getmaxyx()
            lines = ["Exit " + tool + "?", "", "Running tasks will be interrupted.",
                     "Other agents and panes will not be affected.", "",
                     "y: exit    n / Enter / Esc: cancel (default)"]
            start = max(0, (height - len(lines)) // 2)
            column = max(0, (width - 60) // 2)
            for index, line in enumerate(lines):
                if start + index >= height:
                    break
                try:
                    screen.addnstr(start + index, column, line, max(0, width - column - 1))
                except curses.error:
                    pass
            screen.refresh()
            key = screen.getch()
            if key in (ord("y"), ord("Y")):
                return True
            if key in (ord("n"), ord("N"), ord("q"), 3, 10, 13, 27, curses.KEY_ENTER):
                return False
    return curses.wrapper(prompt)


def tracker_command(info, command):
    path = os.environ.get("TRACKER_SOCKET") or str(Path(
        os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()) / "agent-tracker.sock")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.4)
            sock.connect(path)
            sock.sendall((json.dumps({
                "kind": "command", "command": command,
                "session_id": info["session_id"], "window_id": info["window_id"],
                "pane": info["pane_id"],
            }) + "\n").encode())
            sock.recv(4096)
    except OSError:
        pass


def terminate_session(info):
    session = info["session_id"]
    if option(session, "@agent_popup") != "1":
        raise RuntimeError("Only an agent popup session can be terminated")
    owner = option(session, "@agent_popup_owner")
    tool = option(session, "@agent_popup_tool")
    if not re.fullmatch(r"%\d+", owner) or tool not in TOOLS:
        raise RuntimeError("Invalid agent popup session")
    tmux("kill-session", "-t", session)
    if pane_info(owner) and option(owner, "@agent_popup_last", pane=True) == tool:
        tmux("set-option", "-p", "-u", "-t", owner, "@agent_popup_last")
    tracker_command(info, "delete_task")


def open_session(info, client):
    session = info["session_id"]
    owner = option(session, "@agent_popup_owner")
    tool = option(session, "@agent_popup_tool")
    origin = pane_info(owner)
    if origin:
        tmux("switch-client", "-c", client, "-t", origin["session_id"])
        tmux("select-window", "-t", origin["window_id"])
        tmux("select-pane", "-t", owner)
        set_option(owner, "@agent_popup_last", tool, pane=True)
    set_option(session, "@agent_popup_client", client)
    tracker_command(info, "acknowledge")
    display(client, info["pane_current_path"], popup_title(tool, info["pane_current_path"]),
            ["python3", SCRIPT, "attach", "--session", session])


def launch_menu(owner, client):
    info = pane_info(owner)
    if not info:
        raise RuntimeError("The originating pane no longer exists")
    display(client, info["pane_current_path"], popup_title("", info["pane_current_path"]),
            ["python3", SCRIPT, "launcher", "--owner", owner, "--client", client])


def controller(args):
    source = pane_info(args.pane)
    if args.action == "terminate":
        if source:
            time.sleep(0.15)
            terminate_session(source)
        return
    if not source:
        raise RuntimeError("The target pane no longer exists")
    popup = option(source["session_id"], "@agent_popup") == "1"
    client = root_client(args.client, source)
    owner = option(source["session_id"], "@agent_popup_owner") if popup else args.pane
    if args.action == "exit":
        if not popup:
            raise RuntimeError("Exit is only available inside an agent popup")
        time.sleep(0.15)
        close_popup(client)
        display(client, source["pane_current_path"], "Confirm agent exit", [
            "python3", SCRIPT, "confirm-exit", "--pane", args.pane, "--client", client,
        ])
        return
    if args.action == "toggle" and popup:
        tmux("detach-client", "-t", args.client)
        return
    if args.action in ("choose", "tracker", "focus"):
        time.sleep(0.15)
        close_popup(client)
    if args.action == "tracker":
        current = tmux("display-message", "-p", "-c", client, "#{pane_current_path}")
        display(client, current, "Agent Tracker", ["env", "AGENT_TRACKER_POPUP=1",
                "AGENT_TRACKER_CLIENT=" + client, "agent-tracker"])
    elif args.action == "focus":
        if popup:
            open_session(source, client)
        else:
            tmux("switch-client", "-c", client, "-t", source["session_id"])
            tmux("select-window", "-t", source["window_id"])
            tmux("select-pane", "-t", args.pane)
            tracker_command(source, "acknowledge")
    elif args.action == "choose":
        launch_menu(owner, client)
    else:
        tool = option(owner, "@agent_popup_last", pane=True)
        existing = pane_info(session_pane(session_name(owner, tool))) if tool in TOOLS else None
        if not existing or existing["pane_dead"] == "1":
            session = locked_session(owner, "opencode", client)
            pane = tmux("display-message", "-p", "-t", session + ":", "#{pane_id}")
            existing = pane_info(pane)
        open_session(existing, client)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=(
        "toggle", "choose", "tracker", "focus", "launcher", "attach", "exit", "confirm-exit", "terminate",
    ))
    parser.add_argument("--pane", default=os.environ.get("TMUX_PANE", ""))
    parser.add_argument("--client", default="")
    parser.add_argument("--owner", default="")
    parser.add_argument("--session", default="")
    args = parser.parse_args()
    if args.action == "attach":
        attach(args.session)
    elif args.action == "confirm-exit":
        source = pane_info(args.pane)
        if source:
            if option(source["session_id"], "@agent_popup") != "1":
                raise RuntimeError("Only an agent popup session can be terminated")
            tool = option(source["session_id"], "@agent_popup_tool")
            action = "terminate" if confirm_exit(tool) else "focus"
            tmux("run-shell", "-b", shlex.join([
                "python3", SCRIPT, action, "--pane", args.pane, "--client", args.client,
            ]))
    elif args.action == "launcher":
        tool = choose_tool()
        if tool:
            session = locked_session(args.owner, tool, args.client)
            pane = tmux("display-message", "-p", "-t", session + ":", "#{pane_id}")
            tmux("run-shell", "-b", shlex.join([
                "python3", SCRIPT, "focus", "--pane", pane, "--client", args.client,
            ]))
    else:
        controller(args)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print("Agent popup: " + str(error), file=sys.stderr)
        if "--client" in sys.argv:
            client = sys.argv[sys.argv.index("--client") + 1]
            tmux("display-message", "-c", client, "Agent popup: " + str(error), check=False)
        sys.exit(1)
