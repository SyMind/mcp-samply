import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { runSamplyRecord } from "../samply/record.js";

export interface SamplyToolState {
  latestProfilePath: string | null;
}

export function registerRecordTool(
  server: McpServer,
  state: SamplyToolState,
): void {
  server.registerTool(
    "samply_record",
    {
      title: "samply record",
      description:
        "Run `samply record --save-only` and write a profile to disk. Use exactly one recording mode: command, pid, or all=true.",
      inputSchema: {
        samplyPath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional path to a specific samply executable."),
        cwd: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Working directory for the profiled command and output path."),
        outputPath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Where to save the profile. Relative paths are resolved from cwd.",
          ),
        command: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Command and arguments to profile."),
        pid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Existing process ID to attach to."),
        all: z
          .boolean()
          .optional()
          .describe("Profile the whole system with `samply record --all`."),
        rateHz: z
          .number()
          .positive()
          .optional()
          .describe("Sampling rate in Hz."),
        durationSec: z
          .number()
          .positive()
          .optional()
          .describe("Optional recording duration in seconds."),
        profileName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Custom profile name."),
        mainThreadOnly: z
          .boolean()
          .optional()
          .describe("Only include the main thread when supported by samply."),
        reuseThreads: z
          .boolean()
          .optional()
          .describe("Enable `--reuse-threads`."),
        gfx: z
          .boolean()
          .optional()
          .describe("Enable Graphics-related event capture."),
        extraArgs: z
          .array(z.string())
          .optional()
          .describe("Additional raw arguments appended to `samply record`."),
      },
      outputSchema: {
        ok: z.boolean(),
        mode: z.enum(["command", "pid", "all", "invalid"]),
        samplyPath: z.string(),
        cwd: z.string(),
        profilePath: z.string().nullable(),
        args: z.array(z.string()),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        durationMs: z.number(),
        stdout: z.string(),
        stderr: z.string(),
        error: z.string().nullable(),
        installHint: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await runSamplyRecord(input);
      const structuredContent = result as unknown as Record<string, unknown>;

      if (result.ok && result.profilePath !== null) {
        state.latestProfilePath = result.profilePath;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );
}
