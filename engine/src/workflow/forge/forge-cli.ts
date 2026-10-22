/**
 * `harness forge <verb>` — the forge's command door: it parses argv and hands
 * the domain its request; every refusal is the domain's typed one.
 *
 * - `import-history <source> --to <target> [--review <file>]`: the one
 *   path a history enters the forge (`history-import.ts`): scanned by the
 *   catalogue and the oracle, purged, re-scanned to zero, receipted, pushed
 *   into an empty target.
 */
import { resolve } from "node:path";

import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { InputError } from "../../kernel/errors.ts";
import { resolveGitExecutable } from "../../git/git-adapter.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { trackedTop } from "../evidence-store.ts";
import { ForgeError } from "./codes.ts";
import { admitImportHome, importHistory, type HistoryImportReceipt, type HistoryImportRequest } from "./history-import.ts";

const FORGE_VERBS = Object.freeze(["import-history"] as const);

const IMPORT_USAGE = "harness forge import-history <source> --to <target> [--review <file>]";

/** The request `argv` (after `import-history`) names, or `history_import_usage`. */
export function parseImportHistoryArguments(argv: readonly string[]): HistoryImportRequest {
  let source: string | undefined;
  let target: string | undefined;
  let review: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--to" || argument === "--review") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ForgeError("history_import_usage", `${argument} needs a value: ${IMPORT_USAGE}`);
      if (argument === "--to") target = value;
      else review = resolve(value);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new ForgeError("history_import_usage", `unknown option ${argument}: ${IMPORT_USAGE}`);
    } else if (source === undefined) {
      source = argument;
    } else {
      throw new ForgeError("history_import_usage", `one source only: ${IMPORT_USAGE}`);
    }
  }
  if (source === undefined || target === undefined) throw new ForgeError("history_import_usage", `a source and --to are required: ${IMPORT_USAGE}`);
  return Object.freeze({ source, target, ...(review === undefined ? {} : { review }) });
}

export async function runForgeCli(root: string, argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer<HistoryImportReceipt>> {
  const verb = argv[0];
  if (verb !== "import-history") throw new InputError(`harness forge takes one of: ${FORGE_VERBS.join(", ")}`, "command_unavailable");
  const request = parseImportHistoryArguments(argv.slice(1));
  const home = admitImportHome(trackedTop(root));
  const git = resolveGitExecutable(loadPinnedConfigSnapshot().document.workspaceGit?.gitExecutablePath);
  const receipt = await importHistory(request, { home, git, onProgress });
  return { result: wrapResult("forge", receipt, { status: "pass" }) };
}
