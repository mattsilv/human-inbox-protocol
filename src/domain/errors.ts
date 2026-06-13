export type HipErrorCode = "validation" | "not_found" | "conflict" | "state";

/** Domain errors carry a code the tool layer maps to MCP error responses. */
export class HipError extends Error {
  constructor(
    readonly code: HipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HipError";
  }
}

export const validation = (m: string): HipError => new HipError("validation", m);
export const notFound = (m: string): HipError => new HipError("not_found", m);
export const conflict = (m: string): HipError => new HipError("conflict", m);
export const stateError = (m: string): HipError => new HipError("state", m);
