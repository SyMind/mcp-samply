#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

type JsonObject = Record<string, unknown>;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    case "list":
    case "list-tools":
      await handleList(args);
      return;
    case "call":
    case "call-tool":
      await handleCall(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleList(args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new Error("list-tools does not accept extra arguments.");
  }

  const result = await withClient(async (client) => {
    const [toolsResult, promptsResult, resourcesResult] = await Promise.allSettled([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
    ]);

    return {
      server: client.getServerVersion() ?? null,
      capabilities: client.getServerCapabilities() ?? null,
      tools:
        toolsResult.status === "fulfilled"
          ? toolsResult.value.tools
          : [],
      prompts:
        promptsResult.status === "fulfilled"
          ? promptsResult.value.prompts
          : [],
      resources:
        resourcesResult.status === "fulfilled"
          ? resourcesResult.value.resources
          : [],
      warnings: [
        ...(promptsResult.status === "rejected"
          ? [`prompts unavailable: ${formatError(promptsResult.reason)}`]
          : []),
        ...(resourcesResult.status === "rejected"
          ? [`resources unavailable: ${formatError(resourcesResult.reason)}`]
          : []),
      ],
    };
  });

  printJson(result);
}

async function handleCall(args: string[]): Promise<void> {
  const [toolName, ...rest] = args;
  if (!toolName) {
    throw new Error("Missing tool name. Usage: debug-mcp.ts call <toolName> [--args '{...}']");
  }

  const parsedArguments = await parseToolArguments(rest);
  const result = await withClient(async (client) =>
    client.callTool({
      name: toolName,
      arguments: parsedArguments,
    }),
  );

  printJson({
    name: toolName,
    arguments: parsedArguments,
    result,
  });

  if ("isError" in result && result.isError) {
    process.exitCode = 1;
  }
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer();
  const client = new Client({
    name: "mcp-samply-debug-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([clientTransport.close(), serverTransport.close()]);
  }
}

async function parseToolArguments(args: string[]): Promise<JsonObject> {
  let inlineJson: string | undefined;
  let argsFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--args") {
      inlineJson = expectValue(args[index + 1], "--args");
      index += 1;
      continue;
    }

    if (token === "--args-file") {
      argsFile = expectValue(args[index + 1], "--args-file");
      index += 1;
      continue;
    }

    if (inlineJson === undefined) {
      inlineJson = token;
      continue;
    }

    throw new Error(`Unexpected argument: ${token}`);
  }

  if (inlineJson !== undefined && argsFile !== undefined) {
    throw new Error("Use either --args or --args-file, not both.");
  }

  const raw = argsFile
    ? await readFile(path.resolve(process.cwd(), argsFile), "utf8")
    : inlineJson;

  if (raw === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse tool arguments as JSON: ${formatError(error)}`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool arguments must be a JSON object.");
  }

  return parsed as JsonObject;
}

function expectValue(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npm run debug:mcp -- list-tools",
      "  npm run debug:mcp -- call samply_doctor",
      "  npm run debug:mcp -- call samply_summarize_profile --args '{\"profilePath\":\".samply/presym-smoke.json.gz\"}'",
      "  npm run debug:mcp -- call samply_locate_symbols --args-file ./tool-args.json",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`debug-mcp failed: ${formatError(error)}\n`);
  process.exit(1);
});
