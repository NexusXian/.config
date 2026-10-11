import { Plugin } from "@opencode/plugin/tui"
import { createEffect } from "solid-js"
import { TrackerBinding } from "./rpc"

export default Plugin.define({
  id: "tracker-auto.cli",
  setup(ctx) {
    const pane = process.env.TMUX_PANE
    if (!pane) return
    const tracker = ctx.client.rpc(TrackerBinding)
    const bindings = new Map<string, Promise<void>>()

    const bindCurrent = () => {
      const route = ctx.ui.router.current()
      const sessions = new Set(ctx.ui.tabs.list().map((tab) => tab.sessionID))
      if (route.type === "session") sessions.add(route.sessionID)
      for (const sessionID of sessions) {
        const root = ctx.data.session.root(sessionID)
        const location = ctx.data.session.get(root)?.location ?? ctx.location ?? ctx.data.location.default()
        const key = `${location.directory}\x1f${root}`
        if (bindings.has(key)) continue
        const request = tracker.bind({ sessionID: root, pane }, { location }).then(() => {}).catch((error) => {
          bindings.delete(key)
          ctx.ui.toast.show({ title: "Tracker pane binding failed", message: String(error), variant: "error" })
        })
        bindings.set(key, request)
      }
    }

    const stopSlot = ctx.ui.slot({
      append: "app",
      render() {
        createEffect(bindCurrent)
        return null
      },
    })
    const stopCreated = ctx.data.on("session.created", bindCurrent)
    const stopReloaded = ctx.data.on("plugin.updated", () => {
      bindings.clear()
      bindCurrent()
    })
    const stopConnected = ctx.data.on("server.connected", () => {
      bindings.clear()
      bindCurrent()
    })
    return () => {
      stopSlot()
      stopCreated()
      stopReloaded()
      stopConnected()
    }
  },
})
