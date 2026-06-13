import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, guard } from "./result.js";
import { zReference } from "./schemas.js";
import { reconcile, resolveEscalation } from "../domain/reconcile.js";
import type { InboundEnvelope } from "../types.js";

export function registerReconcileTools(server: McpServer, { store }: ToolDeps): void {
  server.registerTool(
    "reconcile_submit",
    {
      title: "Reconcile an inbound envelope",
      description:
        "Map inbound context (email/message/webhook) to a task: attach silently, or escalate a one-tap decision. Idempotent on envelope id. Content is stored as data, never executed.",
      inputSchema: {
        actorId: z.string(),
        envelope: z.object({
          id: z.string().describe("Idempotency key — same envelope twice = one reconcile"),
          kind: z.string(),
          from: z.string().describe("Actor id, or raw address if unresolved"),
          content: z.string(),
          receivedAt: z.string().optional(),
          reference: zReference.optional(),
        }),
      },
    },
    async (a) =>
      guard(() => ok(reconcile(store, a.envelope as InboundEnvelope, a.actorId))),
  );

  server.registerTool(
    "reconcile_resolve",
    {
      title: "Resolve a reconcile escalation",
      description:
        "Resolve an escalation decision into a steered action: attach to a candidate task, create a new task, or ignore. Records a steered event (the learning substrate).",
      inputSchema: {
        actorId: z.string(),
        decisionId: z.string(),
        optionId: z.string().describe("A candidate task id, 'new', or 'ignore'"),
      },
    },
    async (a) => guard(() => ok(resolveEscalation(store, a.decisionId, a.optionId, a.actorId))),
  );
}
