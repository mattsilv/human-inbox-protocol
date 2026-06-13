import { z } from "zod";

// Shared nested zod object schemas used as field types in tool inputSchemas.

export const zDelegatedBy = z.object({
  actor: z.string().describe("Actor id of the creator/delegator"),
  role: z.enum(["creator", "delegator"]),
});

export const zReference = z.object({
  id: z.string().optional(),
  type: z.string(),
  system: z.string().optional(),
  externalId: z.string().optional(),
  globalId: z.string().optional().describe("Upsert idempotency key; reconcile tier-1 match"),
  url: z.string().optional(),
  displayName: z.string().optional(),
  role: z.enum(["source", "check-for-updates", "publish-updates-to"]).optional(),
});

export const zWaiting = z.object({
  onActor: z.string().describe("Actor id we are waiting on"),
  since: z.string().describe("ISO date the wait started"),
  via: z.string().optional().describe("Reference id where the ask lives"),
  cadence: z.string().nullable().optional().describe("ISO-8601 duration; null = never auto-nudge"),
  lastNudge: z.string().nullable().optional(),
});

export const zOption = z.object({
  id: z.string(),
  label: z.string(),
});

export const zPriority = z.enum(["low", "normal", "high"]);
