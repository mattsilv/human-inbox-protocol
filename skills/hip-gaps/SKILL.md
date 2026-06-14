---
name: hip-gaps
description: >-
  Surface the protocol gaps that real HIP usage has hit, frequency-ranked, and offer to
  plan a fix. Use at HIP-development time when deciding what to build next — triggers on
  "what HIP gaps", "hip gaps", "what should I fix in HIP", "show protocol gaps", or
  reviewing the dogfood backlog. Reads gaps the hip-dogfood client filed as
  `protocol-gap`-tagged tasks.
---

# HIP gaps — what real usage is asking for

When a HIP client (the `hip-dogfood` skill) hits missing protocol functionality, it
stops and files the gap as a task tagged `protocol-gap` instead of working around it.
This skill is the read side: it pulls those gap tasks, ranks them by how often each gap
was hit, and offers to turn the top one into a plan. It is the dev-time complement to
`hip-dogfood`'s file-time discipline.

## Connecting

The daemon is an MCP server (Streamable HTTP). Read the connection config from the
`hip install` output / environment — same source the dogfood skill documents:

```
url      = http://127.0.0.1:4319/mcp     # or the HIP_HOST the daemon is bound to
bearer   = $(cat ~/.config/hip/token)
```

Send `Authorization: Bearer <token>` on every call. This skill is read-only — it never
mutates HIP state.

## Procedure

1. **Pull the gaps.** Call:
   ```
   task_list { tag: "protocol-gap" }
   ```
   Add `status: "open"` if you only want unresolved gaps (gaps you've already shipped
   are marked `done`, so an open-only view is usually what you want for "what's next").

2. **Fallback for pre-tag gaps.** If the tag filter returns nothing (or suspiciously
   little), also scan titles for the legacy marker — gaps filed before the `tags` field
   existed used a `PROTOCOL-GAP:` title prefix:
   ```
   task_list {}        # then keep tasks whose title starts with "PROTOCOL-GAP:"
   ```
   Merge those into the set so no gap is dropped during the transition. Note in your
   output which entries came from the title fallback.

3. **Group and rank.** Normalize each gap's title (lowercase, trim, strip a leading
   `PROTOCOL-GAP:` prefix) and group near-identical gaps together. Rank groups by
   **count** — how many times that same gap was hit is the demand signal. Break ties by
   most-recent `createdAt`.

4. **Show the ranked list.** For each group, top first:
   - the gap (normalized title) and its **hit count**,
   - the task IDs in the group,
   - a one-line excerpt from the most detailed `description` (the concrete thing the
     client tried to do and the tool it wished existed).

5. **Offer to plan.** Ask which gap to act on, then run `/ce-plan` for the selected one,
   seeding it with the gap's description and the task IDs as origin context. One gap →
   one plan; don't batch unrelated gaps into a single plan.

## What good looks like

- The output is a short, ranked backlog — highest-demand protocol gap at the top, not a
  raw task dump.
- Every listed gap traces back to real client usage (a `task_read` on any task ID shows
  the thread/description that motivated it).
- The skill stays generic: connection comes from install output / env, never hardcoded
  hosts or tokens, so any HIP contributor can run it against their own daemon.
