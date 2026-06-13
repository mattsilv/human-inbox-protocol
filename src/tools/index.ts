import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { registerTaskTools } from "./tasks.js";
import { registerDecisionTools } from "./decisions.js";
import { registerExecutionTools } from "./executions.js";
import { registerContextTools } from "./context.js";
import { registerReconcileTools } from "./reconcile.js";
import { HIP_VERSION } from "../index.js";

export type { ToolDeps } from "./deps.js";

/**
 * Build a fully-wired MCP server exposing the HIP tool surface. The SDK import is
 * confined to src/tools and src/daemon (KTD: SDK isolation). `extra` registrars layer
 * in implementation-specific admin tools (e.g. doctor/reindex from U8).
 */
export function buildMcpServer(
  deps: ToolDeps,
  extra: ((server: McpServer, deps: ToolDeps) => void)[] = [],
): McpServer {
  const server = new McpServer({ name: "hip", version: HIP_VERSION });
  registerTaskTools(server, deps);
  registerDecisionTools(server, deps);
  registerExecutionTools(server, deps);
  registerContextTools(server, deps);
  registerReconcileTools(server, deps);
  for (const reg of extra) reg(server, deps);
  return server;
}
