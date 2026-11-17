import { Rpc } from "@opencode/plugin/rpc"

/** Settings the desktop panel can change without editing the config file. */
export const Settings = Rpc.define({
  id: "tier-router.settings",
  methods: {
    get: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          mode: { type: "string" },
          prefer: { type: "string" },
        },
        required: ["mode", "prefer"],
        additionalProperties: false,
      },
    },
    set: {
      input: {
        type: "object",
        properties: {
          mode: { type: "string" },
          prefer: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          mode: { type: "string" },
          prefer: { type: "string" },
        },
        required: ["mode", "prefer"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
