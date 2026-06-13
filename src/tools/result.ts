import { HipError } from "../domain/index.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [x: string]: unknown; // structural compatibility with the SDK CallToolResult
}

/** structuredContent is the canonical result; text is a human-readable mirror. */
export function ok(data: object, text?: string): ToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function fail(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: `error[${code}]: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

/** Run a tool body, mapping HipError (and anything else) to a structured error result. */
export async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HipError) return fail(e.code, e.message);
    return fail("internal", e instanceof Error ? e.message : String(e));
  }
}
