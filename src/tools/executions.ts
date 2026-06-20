import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, fail, guard } from "./result.js";

export function registerExecutionTools(server: McpServer, { domain }: ToolDeps): void {
  server.registerTool(
    "execution_register",
    {
      title: "Register execution",
      description: "Register an agent work session against a task (A2A lifecycle).",
      inputSchema: {
        actorId: z.string(),
        task: z.string(),
        actor: z.string().describe("Actor id of the agent doing the work"),
        runtime: z.object({ system: z.string(), externalId: z.string().optional() }).optional(),
        status: z
          .enum(["submitted", "working", "completed", "failed", "canceled"])
          .optional(),
        expectedNextHeartbeatAt: z.string().optional(),
        clientKey: z
          .string()
          .optional()
          .describe(
            "Idempotency key: retrying execution_register with the same key + payload returns the original execution instead of duplicating. Same key, different payload → conflict.",
          ),
      },
    },
    async (a) =>
      guard(() =>
        ok(
          domain.registerExecution(
            {
              task: a.task,
              actor: a.actor,
              ...(a.runtime ? { runtime: a.runtime } : {}),
              ...(a.status ? { status: a.status } : {}),
              ...(a.expectedNextHeartbeatAt
                ? { expectedNextHeartbeatAt: a.expectedNextHeartbeatAt }
                : {}),
              ...(a.clientKey ? { clientKey: a.clientKey } : {}),
            },
            a.actorId,
          ),
        ),
      ),
  );

  server.registerTool(
    "execution_get",
    {
      title: "Get execution",
      description: "Read execution state — poll this to observe a block resolving.",
      inputSchema: { id: z.string() },
    },
    async (a) =>
      guard(() => {
        const e = domain.getExecution(a.id);
        return e ? ok(e) : fail("not_found", a.id);
      }),
  );

  server.registerTool(
    "execution_heartbeat",
    {
      title: "Heartbeat execution",
      description: "Liveness ping; optionally update the expected next heartbeat time.",
      inputSchema: { id: z.string(), expectedNextHeartbeatAt: z.string().optional() },
    },
    async (a) =>
      guard(() => ok(domain.heartbeat(a.id, a.expectedNextHeartbeatAt))),
  );
}
