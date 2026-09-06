import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const browserStateSchema = z.object({
  mode: z.enum(["shared", "headless"]).nullable(),
  running: z.boolean(),
  cdpPort: z.number().int(),
  viewerPort: z.number().int().nullable(),
  display: z.string().nullable(),
  chromePid: z.number().int().nullable(),
  viewerPid: z.number().int().nullable(),
  xvfbPid: z.number().int().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  axiBrowserUrl: z.string().nullable(),
});

export const hostContract = defineRpcContract({
  start: {
    input: z
      .object({
        mode: z.enum(["shared", "headless"]),
        url: z.string().trim().min(1).max(4096).optional(),
      })
      .strict(),
    output: browserStateSchema,
  },
  stop: {
    input: z.object({}).strict(),
    output: browserStateSchema,
  },
  status: {
    input: z.object({}).strict(),
    output: browserStateSchema,
  },
  navigate: {
    input: z
      .object({
        url: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: browserStateSchema,
  },
});
