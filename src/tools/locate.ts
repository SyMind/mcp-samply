import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { locateSymbolsInRoots } from "../source/locate.js";

export function registerLocateTool(server: McpServer): void {
  server.registerTool(
    "samply_locate_symbols",
    {
      title: "samply locate symbols",
      description:
        "Map native stack symbols back to likely source files in one or more local code roots. This is useful after hotspot analysis when an agent needs to inspect the implementation.",
      inputSchema: {
        roots: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe("One or more local source roots to search."),
        symbols: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe("One or more stack symbols or function display names to map back to source."),
        extensions: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Optional file extensions to include, for example ['.rs', '.ts']."),
        maxFilesPerSymbol: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of candidate files to return per symbol."),
        maxHitsPerFile: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of line hits to keep for each candidate file."),
        maxFilesToScanPerRoot: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of files to scan under each root."),
      },
      outputSchema: z.object({
        roots: z.array(z.string()),
        scannedFileCount: z.number().int().nonnegative(),
        symbols: z.array(
          z.object({
            symbol: z.string(),
            functionNames: z.array(z.string()),
            typeNames: z.array(z.string()),
            moduleHints: z.array(z.string()),
            matches: z.array(
              z.object({
                root: z.string(),
                filePath: z.string(),
                score: z.number().int().nonnegative(),
                hits: z.array(
                  z.object({
                    line: z.number().int().positive(),
                    kind: z.enum(["function", "type", "module"]),
                    text: z.string(),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      roots,
      symbols,
      extensions,
      maxFilesPerSymbol,
      maxHitsPerFile,
      maxFilesToScanPerRoot,
    }) => {
      const result = await locateSymbolsInRoots({
        roots,
        symbols,
        extensions,
        maxFilesPerSymbol,
        maxHitsPerFile,
        maxFilesToScanPerRoot,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
