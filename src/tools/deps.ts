import type { Domain } from "../domain/index.js";
import type { Store } from "../store/index.js";

export interface ToolDeps {
  domain: Domain;
  store: Store;
}
