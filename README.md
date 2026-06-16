# HIP — reference implementation

A local daemon implementing **HIP** (the agent↔human interaction protocol) over an
MCP Streamable-HTTP binding. Markdown files are the human-editable truth; SQLite
holds the index, timers, and machine-only state (envelope ledger, executions); an
append-only JSONL event log is the audit + learning trail.

> Status: MVP under construction. Schema v0.1.

## Install (macOS)

One command does everything — deps, build, native binding, PATH link, and seeding:

```bash
npm run setup              # or: bash scripts/install.sh
npm run setup -- --start   # also load the LaunchAgent (daemon auto-starts at login)
```

The installer verifies each fragile step: Node 20+, `npm install`, `tsc` build,
compiling `better-sqlite3` from source when no prebuilt matches your Node ABI,
linking the `hip` command onto your PATH, and `hip install` (token, actors,
LaunchAgent). It is idempotent — safe to re-run.

Then:

```bash
hip serve     # foreground daemon (or load the LaunchAgent for background)
hip status    # liveness + doctor
hip demo      # seed one example per scenario, then walk them inline (offers the inbox)
hip inbox     # walk every pending decision interactively (stays open until cleared)
```

In a terminal, `hip demo` seeds the examples and then asks "Walk your new inbox now?"
— so it flows straight into the interactive inbox in the same session instead of
dropping you back to the shell.

### Interactive inbox

In a terminal, `hip inbox` opens a stay-open loop that walks every pending decision.
Every answer is number-keyed — type `1`, `2`, `3`… to pick an option (no arrow-scrolling
required), or `c` to type your own answer, `s` to snooze, `d` to dismiss, `k`/Enter to
skip. Snooze offers numbered presets (`1` this evening … `5` custom) and accepts
shorthand like `2h`, `3d`, or `mon`. Ctrl-C exits cleanly at any prompt.

It's TTY-gated: piping (`hip inbox | cat`), redirecting, CI, or the `--plain` flag fall
back to plain single-decision output with no prompts or ANSI escapes — safe for scripts.
Set `HIP_NO_INTERACTIVE=1` to force plain mode for a whole session; `NO_COLOR` is honored
for color (picocolors respects it). The flag-driven subcommands
(`hip answer <id> --option`, `--text`, `hip snooze`, `hip dismiss`) are unchanged.

## Update

`hip` and the launchd daemon both run from this checkout's `dist/`, so updating is
one command — it pulls (if a remote is set), rebuilds `dist/`, recompiles the native
binding if your Node ABI changed, and restarts the daemon:

```bash
hip update            # pull latest + rebuild + restart the daemon
hip update --no-pull  # rebuild the current checkout only (no git pull)
```

`npm install` (and `npm run setup`) also rebuild `dist/` automatically via the
`prepare` script, so a manual `git pull && npm install` is always consistent. If you
run the daemon by hand (`hip serve`) rather than under launchd, restart that process
after updating to pick up daemon-side changes.

## Develop

```bash
npm test            # vitest
npm run hip -- --version
```

## Storage model

The `~/hip-data/` data directory is the unit of truth — **back up that one folder**.

| Data | Home | Why |
|------|------|-----|
| tasks, decisions, entities, actors | Markdown files | human-editable, greppable, `$EDITOR`-friendly |
| envelope ledger, executions | SQLite (authoritative) | idempotency wants a UNIQUE constraint; machine-only state |
| index, timers | SQLite (derived) | rebuilt by `hip reindex` from the authoritative sources |
| event log | `events.jsonl` | portable, append-only audit + "steered" learning substrate |

`hip reindex` rebuilds the **derived** tables from markdown + the event log. It does
not invent authoritative state — that lives in the files and the authoritative
tables, which travel with the data dir.

## Docs

- `docs/spec.md` — schema v0.1 (the five primitives, two-state-machines rule)
- `docs/binding.md` — the HIP-over-MCP binding (v1 shipped mapping + RC target)
- `docs/hermes-integration.md` — connecting Hermes as the first client

## Layout

```
src/cli/      hip subcommands
src/daemon/   HTTP server, auth, MCP wiring, nudge engine
src/domain/   tasks, decisions, reconcile, entities, executions, state machines
src/store/    markdown read/write, SQLite, event log, reindex
src/tools/    MCP tool definitions (the binding)
skills/       hip-dogfood (file gaps) + hip-gaps (rank gaps, offer /ce-plan)
```
