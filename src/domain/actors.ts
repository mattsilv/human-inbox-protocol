import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type { Actor, ActorKind } from "../types.js";
import { validation, notFound, stateError } from "./errors.js";

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

/**
 * Hard-delete an actor, but ONLY when nothing references it — the "remove a mis-created
 * actor" gap. Provenance is required and immutable and the event log is append-only, so a
 * referenced actor cannot be deleted without orphaning history; we refuse rather than
 * cascade. The referential check lives here (not a separate guard) so it can't drift from
 * the delete it protects. No event is emitted: erasing a never-used mis-creation is a
 * correction, and an event would re-reference the actor we just removed.
 */
export function deleteActor(store: Store, actorId: string): { id: string } {
  if (!store.getActor(actorId)) throw notFound(`actor ${actorId} not found`);
  const refs = store.actorReferences(actorId);
  if (refs.length > 0) {
    const shown = refs.slice(0, 5).join(", ");
    const more = refs.length > 5 ? `, +${refs.length - 5} more` : "";
    throw stateError(`actor ${actorId} is in use and cannot be deleted — referenced by: ${shown}${more}`);
  }
  store.hardDeleteActor(actorId);
  return { id: actorId };
}

export function findActorByAddress(store: Store, address: string): Actor | null {
  return store.findActorByAddress(address);
}
