import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * A parsed markdown object: structured frontmatter fields plus an optional free-text
 * body. The serializer routes one designated field (e.g. task.description) into the
 * body; everything else — including unknown keys — lives in YAML frontmatter and is
 * preserved verbatim on rewrite.
 */
export interface ParsedDoc {
  fields: Record<string, unknown>;
  body: string;
}

const FENCE = "---";

export function parseDoc(raw: string): ParsedDoc {
  if (!raw.startsWith(FENCE)) {
    // No frontmatter — treat the whole file as body.
    return { fields: {}, body: raw.trimEnd() };
  }
  const end = raw.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    return { fields: {}, body: raw.trimEnd() };
  }
  const yamlText = raw.slice(FENCE.length + 1, end);
  const rest = raw.slice(end + 1 + FENCE.length + 1);
  const fields = (parseYaml(yamlText) as Record<string, unknown> | null) ?? {};
  return { fields, body: rest.replace(/^\n+/, "").trimEnd() };
}

export function serializeDoc(fields: Record<string, unknown>, body: string): string {
  // Drop undefined keys so they don't serialize as `null`; keep explicit nulls.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) clean[k] = v;
  }
  const yamlText = stringifyYaml(clean).trimEnd();
  const trimmedBody = body.trim();
  const bodyPart = trimmedBody.length > 0 ? `\n${trimmedBody}\n` : "";
  return `${FENCE}\n${yamlText}\n${FENCE}\n${bodyPart}`;
}

/**
 * Split a typed object into (frontmatter, body) given the name of the body field.
 * Returns a shallow clone for frontmatter so the live object is never mutated.
 */
export function toDoc(obj: Record<string, unknown>, bodyField?: string): ParsedDoc {
  if (!bodyField) return { fields: { ...obj }, body: "" };
  const { [bodyField]: body, ...fields } = obj;
  return { fields, body: typeof body === "string" ? body : "" };
}

export function fromDoc<T>(doc: ParsedDoc, bodyField?: string): T {
  if (!bodyField) return doc.fields as T;
  const obj: Record<string, unknown> = { ...doc.fields };
  if (doc.body.length > 0 || !(bodyField in obj)) obj[bodyField] = doc.body;
  return obj as T;
}
