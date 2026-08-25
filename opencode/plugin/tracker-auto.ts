import type { Plugin } from "@opencode-ai/plugin"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"

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

export const TrackerAuto: Plugin = async ({ client, $ }) => {
  if (!process.env.TMUX_PANE) return {}
  const pane = process.env.TMUX_PANE

  const active = new Map<string, { target: TmuxTarget; summary: string; phase: string }>()
  let cached: { target: TmuxTarget; at: number } | undefined
  let rootSessionID = ""
  let questionPending: boolean | undefined

  const currentTarget = async (force = false): Promise<TmuxTarget | undefined> => {
    if (!force && cached && Date.now() - cached.at < TARGET_TTL_MS) return cached.target
    const out = (
      await $`tmux display-message -p -t ${pane} ${FIELDS}`.nothrow().text()
    ).trim()
    const parts = out.split(SEP)
    if (parts.length !== 8) return cached?.target
    const cwd = parts[7] || process.cwd()
    const branch = (await $`git -C ${cwd} branch --show-current`.nothrow().text()).trim()
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
    cached = { target, at: Date.now() }
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

  const setQuestionPending = async (pending: boolean) => {
    if (questionPending === pending) return
    questionPending = pending
    if (pending) await $`tmux set-option -p -t ${pane} ${QUESTION_OPTION} 1`.nothrow()
    else await $`tmux set-option -p -u -t ${pane} ${QUESTION_OPTION}`.nothrow()
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
      const res = await client.session.get({ path: { id } }).catch(() => undefined)
      const parent = res?.data?.parentID
      if (!parent) break
      id = parent
    }
    rootCache.set(sessionID, id)
    return id
  }

  // The v1 SDK client has no `question` member; reach the route through the
  // shared transport so the in-process fetch fallback still applies.
  const pendingQuestions = async (): Promise<{ sessionID?: string }[]> => {
    const anyClient = client as unknown as {
      question?: { list: () => Promise<{ data?: unknown }> }
      session: { _client?: { get: (o: { url: string }) => Promise<{ data?: unknown }> } }
    }
    const res = anyClient.question?.list
      ? await anyClient.question.list().catch(() => undefined)
      : await anyClient.session._client?.get({ url: "/question" }).catch(() => undefined)
    const data = res?.data
    return Array.isArray(data) ? (data as { sessionID?: string }[]) : []
  }

  const syncQuestionPending = async () => {
    if (!rootSessionID) return
    const list = await pendingQuestions()
    for (const q of list) {
      if (!q.sessionID) continue
      if ((await rootOf(q.sessionID)) === rootSessionID) {
        await setQuestionPending(true)
        return
      }
    }
    await setQuestionPending(false)
  }

  const rememberRoot = async (sessionID: string, target: TmuxTarget) => {
    if (rootSessionID === sessionID) return
    rootSessionID = sessionID
    writeState(join(stateDir(), `loc_${sanitize(target.locator)}`), sessionID)
    writeState(join(stateDir(), `pane_${sanitize(target.pane)}`), sessionID)
  }

  const assistantSummary = async (sessionID: string, max = 80) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await client.session
        .messages({ path: { id: sessionID }, query: { limit: 6 } })
        .catch(() => undefined)
      const messages = res?.data
      if (Array.isArray(messages)) {
        const last = [...messages].reverse().find((m) => m.info?.role === "assistant")
        const text = last ? summarize(last.parts as unknown[], max) : ""
        if (text) return text
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    return ""
  }

  const userInputs = async (sessionID: string) => {
    const res = await client.session
      .messages({ path: { id: sessionID }, query: { limit: 30 } })
      .catch(() => undefined)
    const messages = res?.data
    if (!Array.isArray(messages)) return []
    return messages
      .filter((m) => m.info?.role === "user")
      .slice(-3)
      .map((m) => summarize(m.parts as unknown[], 200))
      .filter((text) => text)
  }

  const messageRoles = new Map<string, string>()

  await setQuestionPending(false)

  return {
    "chat.message": async (input, output) => {
      const target = await currentTarget()
      if (!target) return
      if ((await rootOf(input.sessionID)) !== input.sessionID) return
      const summary = summarize(output.parts as unknown[], 80)
      if (!summary) return
      await rememberRoot(input.sessionID, target)
      const command = active.has(input.sessionID) ? "update_task" : "start_task"
      active.set(input.sessionID, { target, summary, phase: "" })
      await sendTracker(trackerPayload(target, command, summary))
      await sendPhase(input.sessionID, "waiting")
    },
    "permission.ask": async () => {
      const target = await currentTarget()
      if (!target) return
      const item = active.get(rootSessionID)
      await sendTracker(
        trackerPayload(target, "needs_confirmation", item?.summary || "Needs user confirmation"),
      )
    },
    "tool.execute.before": async (input) => {
      if (input.tool === "question") await setQuestionPending(true)
      let key = input.sessionID
      if (!active.has(key)) key = await rootOf(input.sessionID)
      if (!active.has(key)) return
      await sendPhase(key, input.tool === "question" ? "question" : "tool")
    },
    event: async ({ event }) => {
      const type = event.type as string
      if (type === "question.asked") {
        await setQuestionPending(true)
        if (rootSessionID) await sendPhase(rootSessionID, "question")
        return
      }
      if (type === "question.replied" || type === "question.rejected") {
        await syncQuestionPending()
        return
      }
      if (type === "message.updated") {
        const info = (event.properties as { info?: { id?: string; role?: string } }).info
        if (info?.id && info.role) messageRoles.set(info.id, info.role)
        return
      }
      if (type === "message.part.updated") {
        const part = (event.properties as { part?: { type?: string; text?: string; messageID?: string } }).part
        if (part?.type === "text" && part.text && part.messageID && rootSessionID) {
          if (messageRoles.get(part.messageID) === "assistant") {
            await sendPhase(rootSessionID, "responding")
          }
        }
        return
      }
      if (type !== "session.idle") return
      const sessionID = (event.properties as { sessionID?: string }).sessionID
      if (!sessionID) return
      await syncQuestionPending()
      const item = active.get(sessionID)
      if (!item) return
      active.delete(sessionID)
      const note = (await assistantSummary(sessionID, 600)) || item.summary
      const inputs = await userInputs(sessionID)
      await sendTracker({
        ...trackerPayload(item.target, "finish_task", note),
        ...(inputs.length ? { inputs } : {}),
      })
    },
    dispose: async () => {
      await setQuestionPending(false)
    },
  }
}
