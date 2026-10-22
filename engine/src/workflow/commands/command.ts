/**
 * ONE HARNESS VERB, DECLARED BY ITSELF (#221): every verb is one file in this
 * folder exporting `COMMAND`, and the registry (`registry.ts`) is generated from
 * the folder by `harness sync`. Adding a verb therefore touches only its own
 * file and one generated line, never a central hand-edited list or dispatch
 * chain (the chokepoint every PR that added a verb conflicted on).
 */
import { InputError } from "../../kernel/errors.ts";
import type { CommandAnswer } from "../command-result.ts";

/** What a verb is handed: the harness root, its own arguments, and the progress sink (stderr lines). */
export type CommandContext = Readonly<{
  root: string;
  rest: readonly string[];
  onProgress: (message: string) => void;
}>;

/** A harness verb: its name and its run (heavy owners are imported inside `run`, so the CLI's start stays light). */
export type HarnessCommand = Readonly<{
  verb: string;
  run: (context: CommandContext) => Promise<CommandAnswer>;
}>;

/** The typed refusal of a flag a verb does not take, naming the ones it does. */
export function unknownFlag(subcommand: string, flag: string, supported: readonly string[]): InputError {
  const supportedText = supported.length === 0 ? "no flags supported" : `supported: ${supported.join(", ")}`;
  return new InputError(`unknown ${subcommand} flag: ${flag} (${supportedText})`, "unknown_flag");
}
