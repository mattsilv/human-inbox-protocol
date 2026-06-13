import type { ObjectType, Task, Decision, Entity, Actor } from "../types.js";
import { parseDoc, serializeDoc, toDoc, fromDoc } from "./frontmatter.js";

// Which structured field is routed into the markdown body for each object type.
export const BODY_FIELD: Record<ObjectType, string | undefined> = {
  task: "description",
  entity: "context",
  decision: undefined,
  actor: undefined,
};

export function serialize(type: ObjectType, obj: Record<string, unknown>): string {
  const doc = toDoc(obj, BODY_FIELD[type]);
  return serializeDoc(doc.fields, doc.body);
}

export function deserialize<T = Record<string, unknown>>(type: ObjectType, raw: string): T {
  return fromDoc<T>(parseDoc(raw), BODY_FIELD[type]);
}

// Narrow typed helpers — pure (de)serialization, no I/O.
export const parseTask = (raw: string): Task => deserialize<Task>("task", raw);
export const parseDecision = (raw: string): Decision => deserialize<Decision>("decision", raw);
export const parseEntity = (raw: string): Entity => deserialize<Entity>("entity", raw);
export const parseActor = (raw: string): Actor => deserialize<Actor>("actor", raw);
