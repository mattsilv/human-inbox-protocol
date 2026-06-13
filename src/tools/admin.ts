import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, guard } from "./result.js";
import { doctor, reindex } from "../store/index.js";

/**
 * Implementation-specific admin tools (NOT HIP protocol tools — see binding.md). They
 * route store maintenance through the live daemon, which is the single writer, so the
 * CLI never touches the store while the daemon holds the lock.
 */
export function registerAdminTools(server: McpServer, { store }: ToolDeps): void {
  server.registerTool(
    "doctor_run",
    { title: "Run doctor", description: "Audit store consistency (admin).", inputSchema: {} },
    async () => guard(() => ok(doctor(store))),
  );

  server.registerTool(
    "reindex_run",
    { title: "Run reindex", description: "Rebuild derived index/timers from files (admin).", inputSchema: {} },
    async () => guard(() => ok(reindex(store))),
  );
}
