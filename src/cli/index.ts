#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { HIP_VERSION } from "../index.js";
import { registerInboxCommands } from "./inbox.js";
import { registerInspectCommands } from "./inspect.js";
import { registerLifecycleCommands } from "./lifecycle.js";
import { registerDemoCommands } from "./demo.js";
import { forcePlain } from "./tty.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("hip")
    .description("HIP — agent↔human interaction protocol, local reference daemon")
    .version(HIP_VERSION, "-v, --version", "print the hip version")
    .option("--plain", "disable interactivity and color (machine-readable output)");

  registerInboxCommands(program);
  registerInspectCommands(program);
  registerLifecycleCommands(program);
  registerDemoCommands(program);

  // `--plain` is accepted in either position (`hip --plain inbox` or `hip inbox
  // --plain`), so register it on every subcommand too — a root-only option errors
  // as "unknown" when placed after the subcommand.
  for (const c of program.commands) {
    c.option("--plain", "disable interactivity and color (machine-readable output)");
  }

  // A single global gate: `--plain` forces every command onto the non-interactive
  // path before its action runs (same effect as a pipe or HIP_NO_INTERACTIVE=1).
  program.hook("preAction", (thisCommand, actionCommand) => {
    if (thisCommand.opts().plain || actionCommand.opts().plain) forcePlain(true);
  });

  return program;
}

// Only parse argv when run as the actual binary, not when imported by tests.
// argv[1] may be a symlink (npm's bin shim, e.g. /usr/local/bin/hip) — resolve it
// to the real dist path before comparing, and build the URL with pathToFileURL so
// paths with spaces/special chars encode correctly. A bare `file://${path}` compare
// silently no-ops under `npm link`/global install: the guard never matches, parse()
// never runs, and the binary exits 0 with no output.
if (isMainModule()) {
  buildProgram().parse(process.argv);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = entry;
  }
  return import.meta.url === pathToFileURL(resolved).href;
}
