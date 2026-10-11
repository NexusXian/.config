import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const TrackerBinding = Rpc.define({
  id: "tracker-auto",
  methods: {
    bind: {
      input: z.object({ sessionID: z.string().startsWith("ses"), pane: z.string().regex(/^%\d+$/) }),
      output: z.object({}),
    },
  },
  events: {},
})
