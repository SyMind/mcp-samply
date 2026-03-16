#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("mcp-samply is running on stdio");
}

main().catch((error: unknown) => {
  console.error("mcp-samply failed to start:", error);
  process.exit(1);
});
