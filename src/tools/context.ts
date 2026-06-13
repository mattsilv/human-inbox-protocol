import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./deps.js";
import { ok, guard } from "./result.js";

// Minimal context surface — only what reconcile needs (scope-guardian: full
// entity/actor CRUD deferred; owner/CLI actors are seeded at install, not here).

export function registerContextTools(server: McpServer, { domain }: ToolDeps): void {
  server.registerTool(
    "actor_create",
    {
      title: "Create actor",
      description: "Register an addressable identity (person/agent/service/group).",
      inputSchema: {
        id: z.string().optional(),
        kind: z.enum(["person", "agent", "service", "group"]),
        displayName: z.string(),
        address: z.string().optional(),
      },
    },
    async (a) =>
      guard(() =>
        ok(
          domain.createActor({
            ...(a.id ? { id: a.id } : {}),
            kind: a.kind,
            displayName: a.displayName,
            ...(a.address ? { address: a.address } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "entity_create",
    {
      title: "Create entity",
      description: "A thin context node (person/vendor/place/initiative) that makes reconcile cheap.",
      inputSchema: {
        actorId: z.string(),
        id: z.string().optional(),
        kind: z.enum(["person", "vendor", "place", "initiative"]),
        aliases: z.array(z.string()).optional(),
        context: z.string().optional(),
      },
    },
    async (a) =>
      guard(() =>
        ok(
          domain.createEntity(
            {
              ...(a.id ? { id: a.id } : {}),
              kind: a.kind,
              ...(a.aliases ? { aliases: a.aliases } : {}),
              ...(a.context ? { context: a.context } : {}),
            },
            a.actorId,
          ),
        ),
      ),
  );
}
