import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, fail, guard } from "./result.js";
import { zDelegatedBy, zReference, zWaiting, zPriority } from "./schemas.js";
// The union never crosses the wire: `wire` lowers every task to its flat DTO on return.
import { lowerTaskState as wire } from "../store/index.js";
import type { Reference } from "../types.js";

export function registerTaskTools(server: McpServer, { domain }: ToolDeps): void {
  server.registerTool(
    "task_create",
    {
      title: "Create task",
      description: "File a new task. Provenance (delegatedBy) and actorId are required.",
      inputSchema: {
        actorId: z.string().describe("Identity of the caller — explicit on every write"),
        title: z.string(),
        description: z.string().optional(),
        priority: zPriority.optional(),
        nextActionOn: z.string().optional(),
        watcher: z.string().optional(),
        due: z.string().nullable().optional(),
        place: z.string().optional(),
        delegatedBy: zDelegatedBy,
        references: z.array(zReference).optional(),
        tags: z.array(z.string()).optional().describe('Flat labels, e.g. ["protocol-gap"] for a dogfood gap'),
        waitingOn: zWaiting.optional(),
        clientKey: z
          .string()
          .optional()
          .describe(
            "Idempotency key: retrying task_create with the same key + payload returns the original task instead of duplicating (safe over a flaky link). Same key, different payload → conflict.",
          ),
        demoSeed: z
          .boolean()
          .optional()
          .describe(
            "Internal: marks a `hip demo` seed task (sets _meta.demo). Auto-cleanup removes these on first real task creation — do not set on real tasks.",
          ),
      },
    },
    async (a) =>
      guard(() => {
        const task = domain.createTask(
          {
            title: a.title,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.priority ? { priority: a.priority } : {}),
            ...(a.nextActionOn ? { nextActionOn: a.nextActionOn } : {}),
            ...(a.watcher ? { watcher: a.watcher } : {}),
            ...(a.due !== undefined ? { due: a.due } : {}),
            ...(a.place ? { place: a.place } : {}),
            delegatedBy: a.delegatedBy,
            ...(a.references ? { references: a.references as Reference[] } : {}),
            ...(a.tags ? { tags: a.tags } : {}),
            ...(a.waitingOn ? { waitingOn: a.waitingOn } : {}),
            ...(a.clientKey ? { clientKey: a.clientKey } : {}),
            ...(a.demoSeed ? { _meta: { demo: true } } : {}),
          },
          a.actorId,
        );
        return ok(wire(task), `created ${task.id} — ${task.title}`);
      }),
  );

  server.registerTool(
    "task_read",
    {
      title: "Read task (orient-first)",
      description: "Return the task, its executions, and recent events in one call.",
      inputSchema: { id: z.string() },
    },
    async (a) =>
      guard(() => {
        const id = domain.resolveTaskRef(a.id);
        const view = domain.orient(id);
        return view ? ok({ ...view, task: wire(view.task) }) : fail("not_found", a.id);
      }),
  );

  server.registerTool(
    "task_update",
    {
      title: "Update task content",
      description: "Content fields only. Use task_wait/task_done/task_drop for transitions.",
      inputSchema: {
        actorId: z.string(),
        id: z.string(),
        patch: z.record(z.string(), z.unknown()).describe("Content fields to merge"),
      },
    },
    async (a) => guard(() => ok(wire(domain.updateTask(domain.resolveTaskRef(a.id), a.patch, a.actorId)))),
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "All tasks, optionally filtered by status, tag, and/or onActor (AND-combined).",
      inputSchema: {
        status: z.enum(["open", "waiting", "done", "dropped"]).optional(),
        tag: z.string().optional().describe('Filter by a tag, e.g. "protocol-gap"'),
        onActor: z
          .string()
          .optional()
          .describe('Actor a task is waiting on, e.g. task_list { status:"waiting", onActor:"act_owner" }'),
      },
    },
    async (a) =>
      guard(() => {
        const filter = {
          ...(a.status ? { status: a.status } : {}),
          ...(a.tag ? { tag: a.tag } : {}),
          ...(a.onActor ? { onActor: a.onActor } : {}),
        };
        const tasks = domain.listTasks(Object.keys(filter).length ? filter : undefined).map(wire);
        return ok({ tasks });
      }),
  );

  server.registerTool(
    "task_wait",
    {
      title: "Set/clear waitingOn",
      description: "Set waitingOn (status→waiting) or clear it (status→open).",
      inputSchema: { actorId: z.string(), id: z.string(), waitingOn: zWaiting.nullable() },
    },
    async (a) => guard(() => ok(wire(domain.setWaiting(domain.resolveTaskRef(a.id), a.waitingOn, a.actorId)))),
  );

  server.registerTool(
    "task_done",
    {
      title: "Mark task done",
      description: "Transition a task to done.",
      inputSchema: { actorId: z.string(), id: z.string() },
    },
    async (a) => guard(() => ok(wire(domain.markDone(domain.resolveTaskRef(a.id), a.actorId)))),
  );

  server.registerTool(
    "task_drop",
    {
      title: "Mark task dropped",
      description: "Transition a task to dropped.",
      inputSchema: { actorId: z.string(), id: z.string() },
    },
    async (a) => guard(() => ok(wire(domain.markDropped(domain.resolveTaskRef(a.id), a.actorId)))),
  );

  server.registerTool(
    "task_block",
    {
      title: "Block on a human decision",
      description:
        "Agent-facing alias: file a decision and pause the calling execution (input-required). Resolving the decision resumes it.",
      inputSchema: {
        actorId: z.string(),
        taskId: z.string(),
        executionId: z.string().describe("Explicit execution identity — never inferred from the connection"),
        reason: z.string(),
        options: z
          .array(z.object({ id: z.string(), label: z.string() }))
          .optional()
          .describe("Multiple-choice answers; omit for a free-text block"),
      },
    },
    async (a) =>
      guard(() => {
        const r = domain.block(
          {
            task: domain.resolveTaskRef(a.taskId),
            execution: a.executionId,
            reason: a.reason,
            ...(a.options ? { options: a.options } : {}),
          },
          a.actorId,
        );
        return ok(r, `blocked ${a.executionId} on ${r.decision.id}`);
      }),
  );

  server.registerTool(
    "event_list",
    {
      title: "List events",
      description: "Append-only history for a task or decision.",
      inputSchema: { taskId: z.string().optional(), decisionId: z.string().optional() },
    },
    async (a) =>
      guard(() => {
        const events = a.taskId
          ? domain.store.events.forTask(domain.resolveTaskRef(a.taskId))
          : a.decisionId
            ? domain.store.events.forDecision(a.decisionId)
            : [];
        return ok({ events });
      }),
  );
}
