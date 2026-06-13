import type { Command } from "commander";
import { withClient, withClientVoid } from "./run.js";
import * as cmd from "./commands.js";
import { isInteractive } from "./tty.js";
import { interactiveInbox } from "./interactive.js";

export function registerInboxCommands(program: Command): void {
  program
    .command("inbox")
    .description("Walk every pending decision (interactive in a terminal)")
    .action(async () => {
      // In a TTY, stay open and walk all decisions; piped/--plain falls back to
      // today's single-decision plain output (R1/R7).
      if (isInteractive()) {
        await withClientVoid((c, cfg) => interactiveInbox(c, cfg.actorId));
      } else {
        await withClient((c) => cmd.inbox(c));
      }
    });

  program
    .command("answer <decisionId>")
    .description("Answer a decision with an option or free text")
    .option("--option <id>", "option id to choose")
    .option("--text <text>", "free-text answer")
    .action(async (decisionId: string, opts: { option?: string; text?: string }) => {
      await withClient((c, cfg) =>
        cmd.answer(c, cfg.actorId, decisionId, {
          ...(opts.option ? { option: opts.option } : {}),
          ...(opts.text !== undefined ? { text: opts.text } : {}),
        }),
      );
    });

  program
    .command("snooze <decisionId> <until>")
    .description("Snooze a decision until an ISO time (non-terminal)")
    .action(async (decisionId: string, until: string) => {
      await withClient((c, cfg) => cmd.snooze(c, cfg.actorId, decisionId, until));
    });

  program
    .command("dismiss <decisionId>")
    .description("Dismiss a decision (terminal)")
    .action(async (decisionId: string) => {
      await withClient((c, cfg) => cmd.dismiss(c, cfg.actorId, decisionId));
    });
}
