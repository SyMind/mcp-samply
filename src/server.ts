import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProfileStore } from "./profile/store.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerRecordTool } from "./tools/record.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-samply",
    version: "0.1.0",
  });
  const state = {
    latestProfilePath: null as string | null,
    profileStore: new ProfileStore(),
  };

  registerDoctorTool(server);
  registerRecordTool(server, state);
  registerProfileTools(server, state);

  return server;
}
