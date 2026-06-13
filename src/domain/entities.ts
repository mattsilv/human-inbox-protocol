import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type { Entity, EntityKind } from "../types.js";
import { validation } from "./errors.js";

export interface CreateEntityInput {
  id?: string;
  kind: EntityKind;
  aliases?: string[];
  context?: string;
}

export function createEntity(store: Store, input: CreateEntityInput, actorId: string): Entity {
  if (!input.kind) throw validation("entity.kind is required");
  const now = store.nowIso();
  const entity: Entity = {
    id: input.id ?? newId("entity"),
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
  };
  if (input.aliases) entity.aliases = input.aliases;
  if (input.context) entity.context = input.context;
  store.writeObjects(
    [{ type: "entity", obj: entity as unknown as Record<string, unknown> }],
    [{ id: newId("event"), actor: actorId, task: null, decision: null, kind: "created", at: now, payload: { type: "entity", id: entity.id } }],
  );
  return entity;
}

export function getEntity(store: Store, id: string): Entity | null {
  return store.getEntity(id);
}

/** Resolve an inbound name/alias to entity ids (reconcile tier 3). */
export function findEntitiesByAlias(store: Store, alias: string): string[] {
  return store.findEntityIdsByAlias(alias);
}
