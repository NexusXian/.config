import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { TrackerBinding } from "./rpc"

type TmuxTarget = {
  session: string
  sessionID: string
  window: string
  windowID: string
  pane: string
  locator: string
  cwd: string
  branch: string
}

const TARGET_TTL_MS = 10_000
const QUESTION_OPTION = "@op_question_pending"
const exec = promisify(execFile)

// Unit separator: cannot appear in tmux names or paths, unlike ":".
const SEP = "\x1f"
const FIELDS = [
  "#{session_name}",
  "#{session_id}",
  "#{window_name}",
  "#{window_id}",
  "#{pane_id}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_current_path}",
].join(SEP)

const socketPath = () =>
  process.env.TRACKER_SOCKET ||
  join(process.env.XDG_RUNTIME_DIR || tmpdir(), "agent-tracker.sock")

const stateDir = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "op")

const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_")

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

type TextPart = {
  type?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

const summarize = (parts: unknown[], max: number) => {
  const text = (parts as TextPart[])
    .filter((p) => p && p.type === "text" && !!p.text && !p.synthetic && !p.ignored)
    .map((p) => p.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

const writeState = (file: string, value: string) => {
  try {
    mkdirSync(stateDir(), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${value}\n`, "utf8")
    renameSync(tmp, file)
  } catch {
    // best effort
  }
}

const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const active = new Map<string, { target: TmuxTarget; summary: string; phase: string }>()
  const targets = new Map<string, { target: TmuxTarget; at: number }>()
  const bindings = new Map<string, string>()
  const waiters = new Map<string, Set<(pane: string | undefined) => void>>()
  const questionPending = new Map<string, boolean>()

  const paneFor = async (sessionID: string, wait: boolean) => {
    const binding = bindings.get(sessionID) ?? await ctx.storage.get(`pane/${sessionID}`)
    if (typeof binding === "string" && /^%\d+$/.test(binding)) return binding
    if (!wait) return
    return new Promise<string | undefined>((resolve) => {
      const pending = waiters.get(sessionID) ?? new Set()
      const done = (pane: string | undefined) => {
        clearTimeout(timer)
        pending.delete(done)
        if (!pending.size) waiters.delete(sessionID)
        resolve(pane)
      }
      const timer = setTimeout(() => {
        console.warn("tracker-auto: no client pane binding", sessionID)
        done(undefined)
      }, 2000)
      pending.add(done)
      waiters.set(sessionID, pending)
      const pane = bindings.get(sessionID)
      if (pane) done(pane)
    })
  }

  const currentTarget = async (sessionID: string, wait = false): Promise<TmuxTarget | undefined> => {
    const pane = await paneFor(sessionID, wait)
    if (!pane) return
    const cached = targets.get(pane)
    if (cached && Date.now() - cached.at < TARGET_TTL_MS) return cached.target
    const out = (await exec("tmux", ["display-message", "-p", "-t", pane, FIELDS])).stdout.trim()
    const parts = out.split(SEP)
    if (parts.length !== 8) return
    const cwd = parts[7] || process.cwd()
    const branch = await exec("git", ["-C", cwd, "branch", "--show-current"])
      .then(({ stdout }) => stdout.trim())
      .catch((error) => {
        if (error.code === 128) return ""
        throw error
      })
    const target: TmuxTarget = {
      session: parts[0],
      sessionID: parts[1],
      window: parts[2],
      windowID: parts[3],
      pane: parts[4],
      locator: `${parts[0]}:${parts[5]}.${parts[6]}`,
      cwd,
      branch,
    }
    targets.set(pane, { target, at: Date.now() })
    return target
  }

  const trackerPayload = (target: TmuxTarget, command: string, summary: string) => ({
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

  const setQuestionPending = async (sessionID: string, pending: boolean) => {
    const target = active.get(sessionID)?.target ?? await currentTarget(sessionID)
    if (!target) return
    const pane = target.pane
    if (questionPending.get(pane) === pending) return
    if (pending) await exec("tmux", ["set-option", "-p", "-t", pane, QUESTION_OPTION, "1"])
    else await exec("tmux", ["set-option", "-p", "-u", "-t", pane, QUESTION_OPTION])
    questionPending.set(pane, pending)
  }

  const sendPhase = async (sessionID: string, phase: string) => {
    const item = active.get(sessionID)
    if (!item || item.phase === phase) return
    item.phase = phase
    const t = item.target
    await sendTracker({
      command: "update_phase",
      session: t.session,
      session_id: t.sessionID,
      window: t.window,
      window_id: t.windowID,
      pane: t.pane,
      phase,
      cwd: t.cwd,
      branch: t.branch,
    })
  }

  const rootCache = new Map<string, string>()
  const rootOf = async (sessionID: string): Promise<string> => {
    const hit = rootCache.get(sessionID)
    if (hit) return hit
    let id = sessionID
    for (let i = 0; i < 8; i++) {
      const session = await ctx.session.get({ sessionID: id })
      const parent = session.parentID
      if (!parent) break
      id = parent
    }
    rootCache.set(sessionID, id)
    return id
  }

  const pendingForms = new Map<string, string>()

  const syncQuestionPending = async (sessionID: string) => {
    await setQuestionPending(sessionID, [...pendingForms.values()].includes(sessionID))
  }

  const rememberRoot = async (sessionID: string, target: TmuxTarget) => {
    writeState(join(stateDir(), `loc_${sanitize(target.locator)}`), sessionID)
    writeState(join(stateDir(), `pane_${sanitize(target.pane)}`), sessionID)
  }

  const assistantSummary = async (sessionID: string, max = 80) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const messages = await ctx.session.context({ sessionID })
      const last = [...messages].reverse().find((m) => m.type === "assistant")
      const text = last ? summarize(last.content, max) : ""
      if (text) return text
      await new Promise((r) => setTimeout(r, 120))
    }
    return ""
  }

  const userInputs = async (sessionID: string) => {
    const messages = await ctx.session.context({ sessionID })
    return messages
      .filter((m) => m.type === "user")
      .slice(-3)
      .map((m) => summarize([{ type: "text", text: m.text }], 200))
      .filter((text) => text)
  }

  await ctx.rpc.register(TrackerBinding, {
    bind: async ({ sessionID, pane }) => {
      bindings.set(sessionID, pane)
      const target = await currentTarget(sessionID)
      if (!target) throw new Error(`Cannot resolve tmux pane ${pane}`)
      await ctx.storage.set(`pane/${sessionID}`, pane)
      await rememberRoot(sessionID, target)
      for (const resolve of waiters.get(sessionID) ?? []) resolve(pane)
      waiters.delete(sessionID)
      return {}
    },
  })

  await ctx.session.hook("prompt", async (input) => {
    if ((await rootOf(input.sessionID)) !== input.sessionID) return
    const summary = summarize([{ type: "text", text: input.prompt.text }], 80)
    if (!summary) return
    const target = await currentTarget(input.sessionID, true)
    if (!target) return
    await rememberRoot(input.sessionID, target)
    const command = active.has(input.sessionID) ? "update_task" : "start_task"
    active.set(input.sessionID, { target, summary, phase: "" })
    await syncQuestionPending(input.sessionID)
    await sendTracker(trackerPayload(target, command, summary))
    await sendPhase(input.sessionID, "waiting")
  })
  await ctx.permission.hook("evaluate", async (event) => {
    if (event.effect !== "ask") return
    const item = active.get(await rootOf(event.sessionID))
    if (!item) return
    await sendTracker(
      trackerPayload(item.target, "needs_confirmation", item.summary || "Needs user confirmation"),
    )
  })
  await ctx.tool.hook("execute.before", async (input) => {
    let key: string = input.sessionID
    if (!active.has(key)) key = await rootOf(input.sessionID)
    if (!active.has(key)) return
    if (input.tool === "question") await setQuestionPending(key, true)
    await sendPhase(key, input.tool === "question" ? "question" : "tool")
  })
  await ctx.tool.hook("execute.after", async (input) => {
    if (input.tool === "question") await syncQuestionPending(await rootOf(input.sessionID))
  })

  const controller = new AbortController()
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === "form.created") {
        const form = event.data.form
        if (form.sessionID === "global") continue
        const sessionID = await rootOf(form.sessionID)
        if (!active.has(sessionID)) continue
        pendingForms.set(form.id, sessionID)
        await syncQuestionPending(sessionID)
        await sendPhase(sessionID, "question")
        continue
      }
      if (event.type === "form.replied" || event.type === "form.cancelled") {
        const sessionID = pendingForms.get(event.data.id)
        if (!sessionID) continue
        pendingForms.delete(event.data.id)
        await syncQuestionPending(sessionID)
        continue
      }
      if (event.type === "session.text.delta") {
        if (event.data.delta && active.has(event.data.sessionID)) {
          await sendPhase(event.data.sessionID, "responding")
        }
        continue
      }
      if (
        event.type !== "session.execution.succeeded" &&
        event.type !== "session.execution.failed" &&
        event.type !== "session.execution.interrupted"
      ) continue
      if (event.type === "session.execution.interrupted" && event.data.reason === "shutdown") continue
      const sessionID = event.data.sessionID
      const item = active.get(sessionID)
      if (!item) continue
      await syncQuestionPending(sessionID)
      active.delete(sessionID)
      const note = (await assistantSummary(sessionID, 600)) || item.summary
      const inputs = await userInputs(sessionID)
      await sendTracker({
        ...trackerPayload(item.target, "finish_task", note),
        ...(inputs.length ? { inputs } : {}),
      })
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error("tracker-auto event subscription failed", error)
  })

  return async () => {
    controller.abort()
    await events
    for (const pending of waiters.values()) {
      for (const resolve of pending) resolve(undefined)
    }
    for (const pane of questionPending.keys()) {
      await exec("tmux", ["set-option", "-p", "-u", "-t", pane, QUESTION_OPTION])
    }
  }
}

export default Plugin.define({ id: "tracker-auto", setup })
