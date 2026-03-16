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
  const recordTool = tools.tools.find((tool) => tool.name === "samply_record");
  const summaryTool = tools.tools.find(
    (tool) => tool.name === "samply_summarize_profile",
  );
  const inspectTool = tools.tools.find(
    (tool) => tool.name === "samply_inspect_thread",
  );
  const searchTool = tools.tools.find(
    (tool) => tool.name === "samply_search_functions",
  );
  const subsystemTool = tools.tools.find(
    (tool) => tool.name === "samply_breakdown_subsystems",
  );
  const focusTool = tools.tools.find(
    (tool) => tool.name === "samply_focus_functions",
  );

  assert.ok(doctorTool);
  assert.ok(recordTool);
  assert.ok(summaryTool);
  assert.ok(inspectTool);
  assert.ok(searchTool);
  assert.ok(subsystemTool);
  assert.ok(focusTool);

  const result = await client.callTool({
    name: "samply_doctor",
    arguments: {},
  });
  const structuredContent = result.structuredContent as
    | { ok?: boolean; cwd?: string; version?: string | null }
    | undefined;

  assert.equal(result.isError, undefined);
  assert.equal(typeof structuredContent?.ok, "boolean");
  assert.equal(structuredContent?.cwd, process.cwd());
  assert.equal(
    structuredContent?.version === null ||
      typeof structuredContent?.version === "string",
    true,
  );

  await Promise.all([clientTransport.close(), serverTransport.close()]);
});
