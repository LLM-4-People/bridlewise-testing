/**
 * THE DECISION INDEX GENERATOR: `docs/decisions/README.md`'s index, rebuilt
 * from the decision files' front matter (`tracker-entries.ts`
 * `renderDecisionIndex`), between its generated markers, and the
 * decision-status figure the index opens with: a light and a dark SVG
 * (`DECISION_STATUS_FIGURE`), drawn by `shared/figures.ts` in the token
 * owner's colours. Both are outputs of the same records, so they can never
 * disagree.
 *
 *   node scripts/verification/decision-index.ts --check   # exit 1 when the index is stale
 *   node scripts/verification/decision-index.ts --write   # rewrite the index
 *
 * `harness check` runs it with `--check` and `harness sync` with `--write`
 * (`src/workflow/harness-commands.ts`, the decision-index arm), so the index
 * is a generated value with its generator, never a hand edit (UR-02). It
 * prints ONE JSON line, the last: `{ allCurrent, status, changed }`. A tree
 * without the decisions folder (a product-only tree) is converged by absence.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { figureFiles, partBarFigure } from "../../../shared/figures.ts";
import { readTokenOwner, THEMES } from "../../../shared/token-reader.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { DECISION_INDEX, spliceGeneratedBlock } from "../../src/kernel/verification-paths.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { readEntries } from "../../src/workflow/failure-owners.ts";
import { DECISION_STATUS_FIGURE, DECISIONS_DIRECTORY, decisionStatus, renderDecisionIndex } from "./tracker-entries.ts";

/** The one design system's token owner (repository-relative). */
const TOKEN_OWNER = "src/cockpit/tokens.css";


export type DecisionIndexReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "regenerated" | "stale" | "absent";
  changed: readonly string[];
}>;

/** Judges (and with `write`, rewrites) the decision index of the repository at `repositoryRoot`. */
export function syncDecisionIndex(repositoryRoot: string, write: boolean): DecisionIndexReport {
  const path = join(repositoryRoot, DECISION_INDEX.path);
  if (!existsSync(path)) return Object.freeze({ allCurrent: true, status: "absent", changed: [] });
  const readme = readFileSync(path, "utf8");
  const entries = readEntries(repositoryRoot, DECISIONS_DIRECTORY);
  const next = spliceGeneratedBlock(readme, DECISION_INDEX, renderDecisionIndex(entries));
  if (next === null) {
    throw new HarnessError(`${DECISION_INDEX.path} carries no generated index block (its begin and end markers, DECISION_INDEX in src/kernel/verification-paths.ts)`, "decision_index_block_missing");
  }
  const owner = readTokenOwner(readFileSync(join(repositoryRoot, TOKEN_OWNER), "utf8"));
  const status = decisionStatus(entries);
  const files = figureFiles(DECISION_STATUS_FIGURE.stem);
  const outputs = new Map<string, string>([[DECISION_INDEX.path, next]]);
  for (const theme of THEMES) outputs.set(`${DECISION_STATUS_FIGURE.directory}/${files[theme]}`, partBarFigure(status, owner, theme));
  const changed = [...outputs].filter(([relative, text]) => {
    const target = join(repositoryRoot, relative);
    return !existsSync(target) || readFileSync(target, "utf8") !== text;
  }).map(([relative]) => relative);
  if (changed.length === 0) return Object.freeze({ allCurrent: true, status: "current", changed: [] });
  if (!write) return Object.freeze({ allCurrent: false, status: "stale", changed });
  for (const relative of changed) {
    const target = join(repositoryRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    const written = atomicWriteFile(target, outputs.get(relative)!);
    if (!written.success) throw new HarnessError(`Failed to write ${relative}: ${written.reason ?? "unknown error"}`, "decision_index_write_failed");
  }
  return Object.freeze({ allCurrent: true, status: "regenerated", changed });
}

function run(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { check: { type: "boolean" }, write: { type: "boolean" } } });
  if (values.check === values.write) throw new InputError("Usage: decision-index [--check|--write]", "input_error");
  const repositoryRoot = dirname(fileURLToPath(new URL("../../", import.meta.url)));
  const report = syncDecisionIndex(repositoryRoot, values.write === true);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.allCurrent ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
