import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, fail, guard } from "./result.js";
import { zOption, zPriority } from "./schemas.js";

export function registerDecisionTools(server: McpServer, { domain }: ToolDeps): void {
  server.registerTool(
    "decision_create",
    {
      title: "Create decision",
      description: "File a one-tap question to the human (optionally linked to a task).",
      inputSchema: {
        actorId: z.string(),
        prompt: z.string(),
        task: z.string().nullable().optional(),
        options: z.array(zOption).optional(),
        allowFreeText: z.boolean().optional(),
        priority: zPriority.optional(),
        expiresAt: z.string().nullable().optional(),
      },
    },
    async (a) =>
      guard(() =>
        ok(
          domain.createDecision(
            {
              prompt: a.prompt,
              ...(a.task !== undefined ? { task: a.task } : {}),
              ...(a.options ? { options: a.options } : {}),
              ...(a.allowFreeText !== undefined ? { allowFreeText: a.allowFreeText } : {}),
              ...(a.priority ? { priority: a.priority } : {}),
              ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
            },
            a.actorId,
          ),
        ),
      ),
  );

  server.registerTool(
    "decision_list",
    {
      title: "List pending decisions",
      description: "Unresolved, un-snoozed decisions for the inbox (lazily expires overdue ones).",
      inputSchema: {},
    },
    async () => guard(() => ok({ decisions: domain.listPendingDecisions() })),
  );

  server.registerTool(
    "decision_get",
    {
      title: "Get decision",
      description: "Read a decision (applies lazy expiry).",
      inputSchema: { id: z.string() },
    },
    async (a) =>
      guard(() => {
        const d = domain.getDecision(a.id);
        return d ? ok(d) : fail("not_found", a.id);
      }),
  );

  server.registerTool(
    "decision_resolve",
    {
      title: "Resolve decision",
      description: "Resolve with an option or free text. Resumes any execution blocked on it.",
      inputSchema: {
        actorId: z.string(),
        id: z.string(),
        kind: z.enum(["option", "freeText", "dismissed"]),
        optionId: z.string().optional(),
        freeText: z.string().optional(),
      },
    },
    async (a) =>
      guard(() =>
        ok(
          domain.resolveDecision(
            a.id,
            {
              kind: a.kind,
              ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
              ...(a.freeText !== undefined ? { freeText: a.freeText } : {}),
            },
            a.actorId,
          ),
        ),
      ),
  );

  server.registerTool(
    "decision_snooze",
    {
      title: "Snooze decision",
      description: "Non-terminal: delay re-delivery until the given ISO time.",
      inputSchema: { actorId: z.string(), id: z.string(), until: z.string() },
    },
    async (a) => guard(() => ok(domain.snoozeDecision(a.id, a.until, a.actorId))),
  );

  server.registerTool(
    "decision_reopen",
    {
      title: "Reopen decision",
      description: "Undo: reopen a resolved or snoozed decision so it returns to the inbox (re-blocks any resumed execution).",
      inputSchema: { actorId: z.string(), id: z.string() },
    },
    async (a) => guard(() => ok(domain.reopenDecision(a.id, a.actorId))),
  );
}
