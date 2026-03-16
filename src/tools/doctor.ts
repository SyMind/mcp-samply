import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { DEFAULT_SAMPLY_BIN, findExecutable } from "../samply/executable.js";
import { runCommand } from "../samply/process.js";

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "samply_doctor",
    {
      title: "samply doctor",
      description:
        "Check whether the samply binary is available for this MCP server and report the current execution environment.",
      inputSchema: {
        samplyPath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional path to a specific samply executable."),
      },
      outputSchema: {
        ok: z.boolean(),
        samplyPath: z.string(),
        version: z.string().nullable(),
        cwd: z.string(),
        nodeVersion: z.string(),
        platform: z.string(),
        installHint: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ samplyPath }) => {
      const requestedPath = samplyPath ?? DEFAULT_SAMPLY_BIN;
      const resolvedPath = await findExecutable(requestedPath);
      const version = resolvedPath
        ? await getExecutableVersion(resolvedPath)
        : null;
      const ok = resolvedPath !== null;
      const installHint = ok
        ? null
        : [
            "Install samply first, for example:",
            "cargo install --locked samply",
            "or use the official installer from https://github.com/mstange/samply",
          ].join("\n");

      const structuredContent = {
        ok,
        samplyPath: resolvedPath ?? requestedPath,
        version,
        cwd: process.cwd(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        installHint,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );
}

async function getExecutableVersion(
  executablePath: string,
): Promise<string | null> {
  try {
    const result = await runCommand(executablePath, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const output = `${result.stdout}\n${result.stderr}`.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
