import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerRecordTool } from "./tools/record.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-samply",
    version: "0.1.0",
  });
  const state = {
    latestProfilePath: null as string | null,
  };

  registerDoctorTool(server);
  registerRecordTool(server, state);

  return server;
}
