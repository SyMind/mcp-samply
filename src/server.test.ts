import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";

test("server exposes the doctor tool", async () => {
  const server = createServer();
  const client = new Client({
    name: "mcp-samply-test-client",
    version: "0.1.0",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  const doctorTool = tools.tools.find((tool) => tool.name === "samply_doctor");

  assert.ok(doctorTool);

  const result = await client.callTool({
    name: "samply_doctor",
    arguments: {},
  });
  const structuredContent = result.structuredContent as
    | { ok?: boolean; cwd?: string }
    | undefined;

  assert.equal(result.isError, undefined);
  assert.equal(typeof structuredContent?.ok, "boolean");
  assert.equal(structuredContent?.cwd, process.cwd());

  await Promise.all([clientTransport.close(), serverTransport.close()]);
});
