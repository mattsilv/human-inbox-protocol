import type { ObjectType, Task, Decision, Entity, Actor } from "../types.js";
import { parseDoc, serializeDoc, toDoc, fromDoc } from "./frontmatter.js";
import { liftTaskState, lowerTaskState } from "./task-state.js";

// Which structured field is routed into the markdown body for each object type.
export const BODY_FIELD: Record<ObjectType, string | undefined> = {
  task: "description",
  entity: "context",
  decision: undefined,
  actor: undefined,
};

export function serialize(type: ObjectType, obj: Record<string, unknown>): string {
  // Disk stays flat: lower the internal task union to status/waitingOn on write.
  const flat = type === "task" ? (lowerTaskState(obj as unknown as Task) as unknown as Record<string, unknown>) : obj;
  const doc = toDoc(flat, BODY_FIELD[type]);
  return serializeDoc(doc.fields, doc.body);
}

export function deserialize<T = Record<string, unknown>>(type: ObjectType, raw: string): T {
  const obj = fromDoc<Record<string, unknown>>(parseDoc(raw), BODY_FIELD[type]);
  // Lift flat task files into the internal union; other types pass through.
  return (type === "task" ? liftTaskState(obj) : obj) as T;
}

// Narrow typed helpers — pure (de)serialization, no I/O.
export const parseTask = (raw: string): Task => deserialize<Task>("task", raw);
export const parseDecision = (raw: string): Decision => deserialize<Decision>("decision", raw);
export const parseEntity = (raw: string): Entity => deserialize<Entity>("entity", raw);
export const parseActor = (raw: string): Actor => deserialize<Actor>("actor", raw);
