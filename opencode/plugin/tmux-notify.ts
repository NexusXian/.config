import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const stateDir = join(tmpdir(), "opencode-notify")
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_")

const loop = `trap 'rm -rf "$2"; : > "$1"' EXIT INT TERM
while :; do
  clear
  printf ' opencode done\\n\\n'
  cat "$1" 2>/dev/null
  printf ' [any key dismisses all]'
  if read -rsn1 -t 1 _; then break; fi
done`

export const TmuxNotify: Plugin = async ({ client, $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (!process.env.TMUX) return
      try {
        const toggle = (
          await $`tmux show-options -gqv @opencode_notify`.text()
        ).trim()
        if (toggle === "off") return

        const sessionID = (event.properties as { sessionID: string }).sessionID
        const res = await client.session.get({ path: { id: sessionID } })
        const session = res.data
        if (!session) return
        if (session.parentID) return

        const dir = (session.directory || "").replace(/\/+$/, "")
        const dirName = dir.split("/").pop() || dir || "session"
        const title = (session.title || "").trim() || dirName
        const now = new Date().toTimeString().slice(0, 5)

        let input = ""
        const msgs = (await client.session.messages({
          path: { id: sessionID },
        })).data
        if (msgs) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].info.role !== "user") continue
            input = msgs[i].parts
              .filter(
                (p) =>
                  p.type === "text" && !p.synthetic && !p.ignored && p.text,
              )
              .map((p) => (p as { text: string }).text)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
            break
          }
        }
        if (input.length > 40) input = input.slice(0, 40) + "…"

        const clients = (
          await $`tmux list-clients -F '#{client_name}'`.text()
        )
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean)
        if (clients.length === 0) return

        const ocPane = process.env.TMUX_PANE
        const loc = ocPane
          ? (
              await $`tmux display-message -p -t ${ocPane} '#{session_name}:#{window_index} #{window_name}'`
                .nothrow()
                .text()
            ).trim()
          : ""
        const entry =
          `  ${title}\n` +
          (input ? `  > ${input}\n` : "") +
          (loc ? `  ${loc}\n` : "") +
          `  ${dirName}  ${now}\n` +
          `  ${"-".repeat(40)}\n`

        await mkdir(stateDir, { recursive: true })

        for (const c of clients) {
          const active = (
            await $`tmux display-message -p -t ${c} '#{pane_id}'`.text()
          ).trim()
          if (ocPane && active === ocPane) continue

          const pending = join(stateDir, safe(c) + ".txt")
          const lock = join(stateDir, safe(c) + ".lock")
          await appendFile(pending, entry)

          let owns = false
          try {
            await mkdir(lock)
            owns = true
          } catch {}
          if (!owns) continue

          $`tmux display-popup -c ${c} -x R -y 1 -w 56 -h 40% -T ${" opencode done "} -E bash -c ${loop} _ ${pending} ${lock}`
            .nothrow()
            .catch(() => {})
        }
      } catch {}
    },
  }
}
