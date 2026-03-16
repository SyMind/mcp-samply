import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  breakdownBySubsystem,
  focusFunctions,
  inspectThread,
  searchFunctions,
  summarizeProfile,
} from "../profile/analyze.js";
import { resolveRequestedProfilePath, type SamplyToolState } from "./state.js";

const hotFunctionSchema = z.object({
  name: z.string(),
  resourceName: z.string().nullable(),
  displayName: z.string(),
  selfSamples: z.number().int().nonnegative(),
  stackSamples: z.number().int().nonnegative(),
});

const markerSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
});

const threadSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  processName: z.string().nullable(),
  pid: z.number().int().nullable(),
  tid: z.number().int().nullable(),
  sampleCount: z.number().int().nonnegative(),
  startTimeMs: z.number().nullable(),
  endTimeMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  topSelfFunctions: z.array(hotFunctionSchema),
  topStackFunctions: z.array(hotFunctionSchema),
  topMarkers: z.array(markerSchema),
});

const functionThreadSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  processName: z.string().nullable(),
  selfSamples: z.number().int().nonnegative(),
  stackSamples: z.number().int().nonnegative(),
});

const hotspotThreadSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  processName: z.string().nullable(),
  sampleCount: z.number().int().nonnegative(),
});

const subsystemGroupSchema = z.object({
  name: z.string(),
  selfSamples: z.number().int().nonnegative(),
  stackSamples: z.number().int().nonnegative(),
  exampleFunctions: z.array(hotFunctionSchema),
  threads: z.array(functionThreadSchema),
});

const contextSchema = z.object({
  match: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
  sampleCount: z.number().int().nonnegative(),
});

const pathContextSchema = z.object({
  match: z.string(),
  path: z.array(z.string()),
  sampleCount: z.number().int().nonnegative(),
});

export function registerProfileTools(
  server: McpServer,
  state: SamplyToolState,
): void {
  server.registerTool(
    "samply_summarize_profile",
    {
      title: "samply summarize profile",
      description:
        "Load a samply / Firefox Profiler JSON file and return a compact, agent-friendly performance summary. If profilePath is omitted, the latest profile from this MCP session is used.",
      inputSchema: {
        profilePath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Path to a profile JSON or JSON.GZ file."),
        maxThreads: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of threads to include."),
        maxFunctions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of hot functions per section."),
        maxMarkers: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of marker categories per thread."),
        includeEmptyThreads: z
          .boolean()
          .optional()
          .describe("Include threads with zero samples."),
      },
      outputSchema: z.object({
        profilePath: z.string(),
        sidecarPath: z.string().nullable(),
        presymbolicated: z.boolean(),
        product: z.string().nullable(),
        oscpu: z.string().nullable(),
        intervalMs: z.number().nullable(),
        processCount: z.number().int().nonnegative(),
        threadCount: z.number().int().nonnegative(),
        totalSamples: z.number().int().nonnegative(),
        sampleTimeRangeMs: z.number().nullable(),
        hottestSelfFunctionsOverall: z.array(hotFunctionSchema),
        hottestStackFunctionsOverall: z.array(hotFunctionSchema),
        threads: z.array(threadSummarySchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profilePath, maxThreads, maxFunctions, maxMarkers, includeEmptyThreads }) => {
      const resolvedPath = resolveRequestedProfilePath(state, profilePath);
      const loadedProfile = await state.profileStore.load(resolvedPath);
      state.latestProfilePath = loadedProfile.profilePath;
      const result = summarizeProfile(loadedProfile, {
        maxThreads,
        maxFunctions,
        maxMarkers,
        includeEmptyThreads,
      });

      return toToolResult(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "samply_inspect_thread",
    {
      title: "samply inspect thread",
      description:
        "Inspect one thread in detail, including its hottest functions and most common stacks. The thread argument accepts either the numeric thread index from samply_summarize_profile or a thread name substring.",
      inputSchema: {
        profilePath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Path to a profile JSON or JSON.GZ file."),
        thread: z
          .union([z.number().int().nonnegative(), z.string().trim().min(1)])
          .describe("Thread index or thread name / substring."),
        maxFunctions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of hot functions to include."),
        maxMarkers: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of marker categories to include."),
        maxStacks: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of representative stacks to include."),
      },
      outputSchema: z.object({
        profilePath: z.string(),
        sidecarPath: z.string().nullable(),
        presymbolicated: z.boolean(),
        thread: threadSummarySchema.extend({
          topStacks: z.array(
            z.object({
              stack: z.array(z.string()),
              sampleCount: z.number().int().nonnegative(),
            }),
          ),
        }),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profilePath, thread, maxFunctions, maxMarkers, maxStacks }) => {
      const resolvedPath = resolveRequestedProfilePath(state, profilePath);
      const loadedProfile = await state.profileStore.load(resolvedPath);
      state.latestProfilePath = loadedProfile.profilePath;
      const result = inspectThread(loadedProfile, thread, {
        maxFunctions,
        maxMarkers,
        maxStacks,
      });

      return toToolResult(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "samply_search_functions",
    {
      title: "samply search functions",
      description:
        "Search for function names or library names within a profile and return per-thread sample counts for matching hotspots.",
      inputSchema: {
        profilePath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Path to a profile JSON or JSON.GZ file."),
        query: z
          .string()
          .trim()
          .min(1)
          .describe("Case-insensitive search term."),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of aggregated function matches to return."),
        maxThreadsPerResult: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of thread breakdowns per matching function."),
      },
      outputSchema: z.object({
        profilePath: z.string(),
        sidecarPath: z.string().nullable(),
        presymbolicated: z.boolean(),
        query: z.string(),
        matchCount: z.number().int().nonnegative(),
        matches: z.array(
          hotFunctionSchema.extend({
            threads: z.array(functionThreadSchema),
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
    async ({ profilePath, query, maxResults, maxThreadsPerResult }) => {
      const resolvedPath = resolveRequestedProfilePath(state, profilePath);
      const loadedProfile = await state.profileStore.load(resolvedPath);
      state.latestProfilePath = loadedProfile.profilePath;
      const result = searchFunctions(loadedProfile, query, {
        maxResults,
        maxThreadsPerResult,
      });

      return toToolResult(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "samply_breakdown_subsystems",
    {
      title: "samply breakdown subsystems",
      description:
        "Group hot functions by Rust / C++ namespace prefix so agents can identify which native subsystems dominate a profile. This is useful for Rspack and other native-heavy builds.",
      inputSchema: {
        profilePath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Path to a profile JSON or JSON.GZ file."),
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional case-insensitive filter applied to function names and resources before grouping."),
        resourceQuery: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional case-insensitive filter applied to resource / library names before grouping."),
        thread: z
          .union([z.number().int().nonnegative(), z.string().trim().min(1)])
          .optional()
          .describe("Optional thread index or name filter."),
        prefixSegments: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many namespace segments to keep when building subsystem names."),
        maxGroups: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of subsystem groups to return."),
        maxExamplesPerGroup: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of example functions to keep for each group."),
        maxThreadsPerGroup: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of thread breakdown entries to keep for each group."),
      },
      outputSchema: z.object({
        profilePath: z.string(),
        sidecarPath: z.string().nullable(),
        presymbolicated: z.boolean(),
        query: z.string().nullable(),
        resourceQuery: z.string().nullable(),
        prefixSegments: z.number().int().positive(),
        groupCount: z.number().int().nonnegative(),
        totalGroupedStackSamples: z.number().int().nonnegative(),
        totalGroupedSelfSamples: z.number().int().nonnegative(),
        groups: z.array(subsystemGroupSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      profilePath,
      query,
      resourceQuery,
      thread,
      prefixSegments,
      maxGroups,
      maxExamplesPerGroup,
      maxThreadsPerGroup,
    }) => {
      const resolvedPath = resolveRequestedProfilePath(state, profilePath);
      const loadedProfile = await state.profileStore.load(resolvedPath);
      state.latestProfilePath = loadedProfile.profilePath;
      const result = breakdownBySubsystem(loadedProfile, {
        query,
        resourceQuery,
        thread,
        prefixSegments,
        maxGroups,
        maxExamplesPerGroup,
        maxThreadsPerGroup,
      });

      return toToolResult(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "samply_focus_functions",
    {
      title: "samply focus functions",
      description:
        "Find the hottest sample contexts around a target function or namespace. Each matching sample is counted once using its deepest matching frame.",
      inputSchema: {
        profilePath: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Path to a profile JSON or JSON.GZ file."),
        query: z
          .string()
          .trim()
          .min(1)
          .describe("Case-insensitive function / namespace substring to focus on."),
        resourceQuery: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional case-insensitive resource / library name filter."),
        thread: z
          .union([z.number().int().nonnegative(), z.string().trim().min(1)])
          .optional()
          .describe("Optional thread index or name filter."),
        beforeDepth: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How many ancestor frames to include before the match."),
        afterDepth: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How many descendant frames to include after the match."),
        maxMatches: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of matching functions to return."),
        maxThreads: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of matching threads to return."),
        maxContexts: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of caller/callee/context entries to return."),
      },
      outputSchema: z.object({
        profilePath: z.string(),
        sidecarPath: z.string().nullable(),
        presymbolicated: z.boolean(),
        query: z.string(),
        resourceQuery: z.string().nullable(),
        totalMatchedSamples: z.number().int().nonnegative(),
        matchedFunctionCount: z.number().int().nonnegative(),
        matches: z.array(
          z.object({
            name: z.string(),
            resourceName: z.string().nullable(),
            displayName: z.string(),
            sampleCount: z.number().int().nonnegative(),
          }),
        ),
        threads: z.array(hotspotThreadSchema),
        topContexts: z.array(contextSchema),
        topCallers: z.array(pathContextSchema),
        topCallees: z.array(pathContextSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      profilePath,
      query,
      resourceQuery,
      thread,
      beforeDepth,
      afterDepth,
      maxMatches,
      maxThreads,
      maxContexts,
    }) => {
      const resolvedPath = resolveRequestedProfilePath(state, profilePath);
      const loadedProfile = await state.profileStore.load(resolvedPath);
      state.latestProfilePath = loadedProfile.profilePath;
      const result = focusFunctions(loadedProfile, query, {
        resourceQuery,
        thread,
        beforeDepth,
        afterDepth,
        maxMatches,
        maxThreads,
        maxContexts,
      });

      return toToolResult(result as unknown as Record<string, unknown>);
    },
  );
}

function toToolResult(result: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}
