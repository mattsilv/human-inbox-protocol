import type { Store } from "../store/index.js";
import * as tasks from "./tasks.js";
import * as decisions from "./decisions.js";
import * as executions from "./executions.js";
import * as actors from "./actors.js";
import * as entities from "./entities.js";

export * from "./errors.js";
export type { CreateTaskInput, TaskView } from "./tasks.js";
export type { CreateDecisionInput } from "./decisions.js";
export type { RegisterExecutionInput } from "./executions.js";
export type { CreateActorInput } from "./actors.js";
export type { CreateEntityInput } from "./entities.js";
export { tasks, decisions, executions, actors, entities };

/** Convenience facade binding the domain functions to a single store. */
export class Domain {
  constructor(readonly store: Store) {}

  // tasks
  createTask = (i: tasks.CreateTaskInput, actor: string) => tasks.createTask(this.store, i, actor);
  updateTask = (id: string, patch: Record<string, unknown>, actor: string) =>
    tasks.updateTask(this.store, id, patch, actor);
  setWaiting = (id: string, w: Parameters<typeof tasks.setWaiting>[2], actor: string) =>
    tasks.setWaiting(this.store, id, w, actor);
  markDone = (id: string, actor: string) => tasks.markDone(this.store, id, actor);
  markDropped = (id: string, actor: string) => tasks.markDropped(this.store, id, actor);
  appendThread = (id: string, e: Parameters<typeof tasks.appendThread>[2], actor: string, k?: Parameters<typeof tasks.appendThread>[4]) =>
    tasks.appendThread(this.store, id, e, actor, k);
  orient = (id: string) => tasks.orient(this.store, id);
  resolveTaskRef = (ref: string) => tasks.resolveTaskRef(this.store, ref);
  listTasks = (f?: Parameters<typeof tasks.listTasks>[1]) => tasks.listTasks(this.store, f);
  recordNudge = (id: string, actor: string) => tasks.recordNudge(this.store, id, actor);

  // decisions
  createDecision = (i: decisions.CreateDecisionInput, actor: string) =>
    decisions.createDecision(this.store, i, actor);
  getDecision = (id: string) => decisions.getDecision(this.store, id);
  listPendingDecisions = () => decisions.listPendingDecisions(this.store);
  resolveDecision = (id: string, r: Parameters<typeof decisions.resolveDecision>[2], actor: string) =>
    decisions.resolveDecision(this.store, id, r, actor);
  dismissDecision = (id: string, actor: string) => decisions.dismissDecision(this.store, id, actor);
  snoozeDecision = (id: string, until: string, actor: string) =>
    decisions.snoozeDecision(this.store, id, until, actor);
  reopenDecision = (id: string, actor: string) => decisions.reopenDecision(this.store, id, actor);

  // executions
  registerExecution = (i: executions.RegisterExecutionInput, actor: string) =>
    executions.registerExecution(this.store, i, actor);
  getExecution = (id: string) => executions.getExecution(this.store, id);
  heartbeat = (id: string, next?: string) => executions.heartbeat(this.store, id, next);
  setExecutionStatus = (id: string, s: Parameters<typeof executions.setExecutionStatus>[2], actor: string) =>
    executions.setExecutionStatus(this.store, id, s, actor);
  block = (i: Parameters<typeof executions.block>[1], actor: string) =>
    executions.block(this.store, i, actor);

  // actors & entities
  createActor = (i: actors.CreateActorInput) => actors.createActor(this.store, i);
  ensureActor = (i: actors.CreateActorInput & { id: string }) => actors.ensureActor(this.store, i);
  getActor = (id: string) => actors.getActor(this.store, id);
  findActorByAddress = (addr: string) => actors.findActorByAddress(this.store, addr);
  createEntity = (i: entities.CreateEntityInput, actor: string) =>
    entities.createEntity(this.store, i, actor);
  getEntity = (id: string) => entities.getEntity(this.store, id);
  findEntitiesByAlias = (alias: string) => entities.findEntitiesByAlias(this.store, alias);
}
