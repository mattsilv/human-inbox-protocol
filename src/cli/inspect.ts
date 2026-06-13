import type { Command } from "commander";
import { withClient } from "./run.js";
import * as cmd from "./commands.js";

export function registerInspectCommands(program: Command): void {
  program
    .command("list")
    .description("List tasks, optionally filtered by status")
    .option("--status <status>", "open | waiting | done | dropped")
    .action(async (opts: { status?: string }) => {
      await withClient((c) => cmd.listTasks(c, opts.status));
    });

  program
    .command("show <taskId>")
    .description("Show a task (orient-first: thread, references, executions)")
    .action(async (taskId: string) => {
      await withClient((c) => cmd.show(c, taskId));
    });

  program
    .command("events <taskId>")
    .description("Show the event history for a task")
    .action(async (taskId: string) => {
      await withClient((c) => cmd.events(c, { taskId }));
    });
}
