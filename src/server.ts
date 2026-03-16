import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const SERVER_VERSION = "0.1.0";
const DEFAULT_SAMPLY_BIN = process.env.MCP_SAMPLY_BIN || "samply";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-samply",
    version: SERVER_VERSION,
  });

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
        cwd: z.string(),
        nodeVersion: z.string(),
        platform: z.string(),
        installHint: z.string().nullable(),
      },
    },
    async ({ samplyPath }) => {
      const requestedPath = samplyPath ?? DEFAULT_SAMPLY_BIN;
      const resolvedPath = await findExecutable(requestedPath);
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

  return server;
}

async function canAccessPath(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(filePath: string): Promise<string | null> {
  if (filePath.includes("/") || filePath.includes("\\")) {
    const absolutePath = path.resolve(filePath);
    return (await canAccessPath(absolutePath)) ? absolutePath : null;
  }

  const searchPath = process.env.PATH ?? "";
  const pathEntries = searchPath.split(path.delimiter).filter(Boolean);
  const windowsExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of windowsExtensions) {
      const candidate = path.join(pathEntry, `${filePath}${extension}`);
      if (await canAccessPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
