import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type { ObjectType, HipEvent } from "../types.js";
import { notFound, validation } from "./errors.js";

/**
 * Disciplined single-markdown mutation: read FRESH from disk, detect an external
 * edit (append an `external-edit` event so R10 stays true and the mutator revalidates
 * against current truth, never a stale cache), run the mutator, bump updatedAt, and
 * commit through the store. The mutator returns the domain events for the change and
 * may throw a HipError to reject an illegal transition.
 */
export function mutateMarkdown<T extends { id: string; updatedAt: string }>(
  store: Store,
  type: ObjectType,
  id: string,
  actorId: string,
  loader: (id: string) => { obj: T; hash: string } | null,
  mutator: (obj: T) => HipEvent[],
): T {
  requireActor(actorId);
  const fresh = loader(id);
  if (!fresh) throw notFound(`${type} ${id} not found`);

  const events: HipEvent[] = [];
  if (store.externalEditDetected(type, id, fresh.hash)) {
    events.push({
      id: newId("event"),
      task: type === "task" ? id : null,
      decision: type === "decision" ? id : null,
      actor: actorId,
      kind: "external-edit",
      payload: { type, id },
      at: store.nowIso(),
    });
  }

  events.push(...mutator(fresh.obj));
  fresh.obj.updatedAt = store.nowIso();
  store.writeObjects(
    [{ type, obj: fresh.obj as unknown as Record<string, unknown> }],
    events,
  );
  return fresh.obj;
}

export function requireActor(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw validation("actorId is required on every write");
  }
  return actorId;
}
