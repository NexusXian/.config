import type { Plugin } from "@opencode-ai/plugin"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"

type TmuxTarget = {
  session: string
  sessionID: string
  window: string
  windowID: string
  pane: string
  cwd: string
  branch: string
}

const active = new Map<string, { target: TmuxTarget; summary: string }>()

const socketPath = () =>
  process.env.TRACKER_SOCKET ||
  join(process.env.XDG_RUNTIME_DIR || tmpdir(), "agent-tracker.sock")

const sendTracker = async (payload: Record<string, unknown>) => {
  await new Promise<void>((resolve) => {
    const sock = connect(socketPath())
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve()
    }
    sock.setTimeout(800, done)
    sock.on("error", done)
    sock.on("connect", () => {
      sock.write(JSON.stringify({ kind: "command", ...payload }) + "\n")
    })
    sock.on("data", done)
  })
}

const userSummary = (parts: unknown[]) => {
  const text = parts
    .filter((p): p is { type: string; text?: string; synthetic?: boolean; ignored?: boolean } => {
      if (!p || typeof p !== "object") return false
      const part = p as { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }
      return part.type === "text" && !!part.text && !part.synthetic && !part.ignored
    })
    .map((p) => p.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length <= 80) return text
  return text.slice(0, 79) + "…"
}

export const TrackerAuto: Plugin = async ({ client, $ }) => {
  const currentTarget = async (): Promise<TmuxTarget | undefined> => {
    if (!process.env.TMUX_PANE) return
    const out = (
      await $`tmux display-message -p -t ${process.env.TMUX_PANE} '#{session_name}:::#{session_id}:::#{window_name}:::#{window_id}:::#{pane_id}:::#{pane_current_path}'`
        .nothrow()
        .text()
    ).trim()
    const parts = out.split(":::")
    if (parts.length !== 6) return
    const cwd = parts[5] || process.cwd()
    const branch = (
      await $`git -C ${cwd} branch --show-current`.nothrow().text()
    ).trim()
    return {
      session: parts[0],
      sessionID: parts[1],
      window: parts[2],
      windowID: parts[3],
      pane: parts[4],
      cwd,
      branch,
    }
  }

  const isRootSession = async (sessionID: string) => {
    const res = await client.session.get({ path: { id: sessionID } })
    const session = res.data
    return !!session && !session.parentID
  }

  return {
    "chat.message": async (input, output) => {
      if (!(await isRootSession(input.sessionID))) return
      const target = await currentTarget()
      if (!target) return
      const summary = userSummary(output.parts as unknown[])
      if (!summary) return
      const command = active.has(input.sessionID) ? "update_task" : "start_task"
      active.set(input.sessionID, { target, summary })
      await sendTracker({
        command,
        session: target.session,
        session_id: target.sessionID,
        window: target.window,
        window_id: target.windowID,
        pane: target.pane,
        summary,
        cwd: target.cwd,
        branch: target.branch,
      })
    },
    "permission.ask": async (_input, _output) => {
      const target = await currentTarget()
      if (!target) return
      const item = [...active.values()].find((v) => v.target.pane === target.pane)
      await sendTracker({
        command: "needs_confirmation",
        session: target.session,
        session_id: target.sessionID,
        window: target.window,
        window_id: target.windowID,
        pane: target.pane,
        summary: item?.summary || "Needs user confirmation",
        cwd: target.cwd,
        branch: target.branch,
      })
    },
    "tool.execute.before": async (input) => {
      const item = active.get(input.sessionID)
      if (!item) return
      const target = await currentTarget()
      if (!target) return
      await sendTracker({
        command: "update_task",
        session: target.session,
        session_id: target.sessionID,
        window: target.window,
        window_id: target.windowID,
        pane: target.pane,
        summary: item.summary,
        cwd: target.cwd,
        branch: target.branch,
      })
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event.properties as { sessionID?: string }).sessionID
      if (!sessionID) return
      if (!(await isRootSession(sessionID))) return
      const item = active.get(sessionID)
      if (!item) return
      active.delete(sessionID)
      await sendTracker({
        command: "finish_task",
        session: item.target.session,
        session_id: item.target.sessionID,
        window: item.target.window,
        window_id: item.target.windowID,
        pane: item.target.pane,
        summary: item.summary,
        cwd: item.target.cwd,
        branch: item.target.branch,
      })
    },
  }
}
