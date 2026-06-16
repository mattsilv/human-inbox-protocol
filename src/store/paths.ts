import { homedir } from "node:os";
import { join } from "node:path";
import type { ObjectType } from "../types.js";

export interface DataPaths {
  root: string;
  tasksDir: string;
  decisionsDir: string;
  entitiesDir: string;
  actorsDir: string;
  eventsFile: string;
  dbFile: string;
  lockFile: string;
}

const DIR_BY_TYPE: Record<ObjectType, keyof DataPaths> = {
  task: "tasksDir",
  decision: "decisionsDir",
  entity: "entitiesDir",
  actor: "actorsDir",
};

export function defaultDataRoot(): string {
  // `~/hip-data` (not `~/hip`) so the data dir is not confused with a `hip` source
  // checkout. Existing installs pin their dir in config.json (dataDir), so this only
  // changes where a fresh `hip install` puts data; HIP_DATA_DIR still overrides.
  return process.env.HIP_DATA_DIR ?? join(homedir(), "hip-data");
}

export function dataPaths(root: string = defaultDataRoot()): DataPaths {
  return {
    root,
    tasksDir: join(root, "tasks"),
    decisionsDir: join(root, "decisions"),
    entitiesDir: join(root, "entities"),
    actorsDir: join(root, "actors"),
    eventsFile: join(root, "events.jsonl"),
    dbFile: join(root, "hip.db"),
    lockFile: join(root, ".lock"),
  };
}

export function dirForType(paths: DataPaths, type: ObjectType): string {
  return paths[DIR_BY_TYPE[type]] as string;
}

export function filePath(paths: DataPaths, type: ObjectType, id: string): string {
  return join(dirForType(paths, type), `${id}.md`);
}
