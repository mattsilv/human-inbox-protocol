import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Generate a bearer token at `hip install`; stored 0600 in the config dir (U8). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authenticate the channel, not the actor. The bearer token proves the caller may
 * talk to this daemon; actor identity is asserted per-call in tool args (KTD).
 */
export function checkBearer(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return timingEqual(m[1]!, expected);
}
