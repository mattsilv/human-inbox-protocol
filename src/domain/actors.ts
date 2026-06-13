import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type { Actor, ActorKind } from "../types.js";
import { validation } from "./errors.js";

export interface CreateActorInput {
  id?: string;
  kind: ActorKind;
  displayName: string;
  address?: string;
}

export function createActor(store: Store, input: CreateActorInput): Actor {
  if (!input.displayName) throw validation("actor.displayName is required");
  const now = store.nowIso();
  const actor: Actor = {
    id: input.id ?? newId("actor"),
    kind: input.kind,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  };
  if (input.address) actor.address = input.address;
  store.writeObjects(
    [{ type: "actor", obj: actor as unknown as Record<string, unknown> }],
    [{ id: newId("event"), actor: actor.id, task: null, decision: null, kind: "created", at: now, payload: { type: "actor" } }],
  );
  return actor;
}

/** Idempotent seed used by `hip install` to bootstrap the owner + CLI identities. */
export function ensureActor(store: Store, input: CreateActorInput & { id: string }): Actor {
  const existing = store.getActor(input.id);
  if (existing) return existing;
  return createActor(store, input);
}

export function getActor(store: Store, id: string): Actor | null {
  return store.getActor(id);
}

export function findActorByAddress(store: Store, address: string): Actor | null {
  return store.findActorByAddress(address);
}
