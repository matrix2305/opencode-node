import { Rpc } from "@opencode/plugin/rpc"

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const
const summarySchema = { type: "object", additionalProperties: true } as const

export const NodeRpc = Rpc.define({
  id: "matrix2305.opencode-node",
  methods: {
    status: {
      input: emptyInput,
      output: summarySchema,
    },
    sync: {
      input: emptyInput,
      output: summarySchema,
    },
    push: {
      input: emptyInput,
      output: { type: "object", additionalProperties: true } as const,
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          summary: { type: "object", additionalProperties: true },
        },
        required: ["kind", "summary"],
        additionalProperties: true,
      },
    },
  },
})
