/**
 * EXP464 — Task generator: 10 task types × 10 codebases = 100 tasks.
 *
 * Each task targets a REAL symbol from the codebase (verified via ripgrep in
 * codebase-registry.ts). The 10 task types exercise different harness
 * capabilities: search, rename, extract, inline, add-param, fix-bug,
 * add-feature, refactor-pattern, cross-file, multi-step.
 *
 * Per the binding directives: "Tests must be as HARD and REALISTIC as possible"
 * and "Build tests with IMPROPER USAGE, UNKNOWN RESULTS, things that should
 * NOT work."
 */

import { CODEBASES, TASK_TYPES, type CodebaseId, type E2ETask, type TaskType } from "./types.ts";
import { CODEBASE_REGISTRY } from "./codebase-registry.ts";

/** Generate the 100 tasks: 10 codebases × 10 task types. */
export function generateAllTasks(turnsPerTask: number): readonly E2ETask[] {
  const tasks: E2ETask[] = [];
  for (const codebase of CODEBASES) {
    const info = CODEBASE_REGISTRY[codebase];
    const sym0 = info.symbols[0]!;
    const sym1 = info.symbols[1]!;
    for (const taskType of TASK_TYPES) {
      const task = makeTask(codebase, taskType, sym0.name, sym1.name, turnsPerTask);
      tasks.push(task);
    }
  }
  return Object.freeze(tasks);
}

function makeTask(
  codebase: CodebaseId,
  taskType: TaskType,
  symA: string,
  symB: string,
  turns: number,
): E2ETask {
  const editPath = `src/sample.${getExt(codebase)}`;
  const id = `${codebase}-${taskType}`;
  const base = { id, codebase, taskType, turns, expectedPath: editPath, editPath };

  switch (taskType) {
    case "search":
      return { ...base, request: `Find all occurrences of the function ${symA} in the ${codebase} codebase.`, expectedSymbol: symA, expectedPath: null };
    case "rename":
      return { ...base, request: `Rename the function ${symA} to ${renamed(symA)} in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: renamed(symA), expectedPath: editPath };
    case "extract":
      return { ...base, request: `Extract the core logic of ${symA} into a new helper function called ${extracted(symA)} in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: extracted(symA), expectedPath: editPath };
    case "inline":
      return { ...base, request: `Inline the function ${symB} by replacing all its calls with its body in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: symA, expectedPath: editPath };
    case "add-param":
      return { ...base, request: `Add a parameter verbose: boolean to the function ${symA} in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: symA, expectedPath: editPath };
    case "fix-bug":
      return { ...base, request: `Fix a bug in the function ${symA} where it does not handle the empty string case. Add a guard at the top. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: symA, expectedPath: editPath };
    case "add-feature":
      return { ...base, request: `Add a new feature: a logging function called ${newFeature(symA)} that logs the input of ${symA} in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: newFeature(symA), expectedPath: editPath };
    case "refactor-pattern":
      return { ...base, request: `Refactor ${symA} to use the early-return pattern: add a guard that returns early if the input is empty in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: symA, expectedPath: editPath };
    case "cross-file":
      return { ...base, request: `Multi-file: update ${symA} in ${editPath} AND add a test file at test/sample.test.${getExt(codebase)} that imports and tests ${symA}. Output both files in fenced blocks with path annotations.`, expectedSymbol: symA, expectedPath: editPath };
    case "multi-step":
      return { ...base, request: `Multi-step: first add a JSDoc to ${symA}, then add an early-return guard, then add a verbose parameter in ${editPath}. Output the full file in a fenced block with a path=${editPath} annotation.`, expectedSymbol: symA, expectedPath: editPath };
  }
}

/** Generate improper-usage tasks (per the binding directives). */
export function generateImproperTasks(): readonly E2ETask[] {
  const tasks: E2ETask[] = [];
  for (const codebase of CODEBASES) {
    const editPath = `src/sample.${getExt(codebase)}`;
    // Empty request
    tasks.push({ id: `${codebase}-imp-empty`, codebase, taskType: "search", request: "", expectedSymbol: "(rejected)", expectedPath: null, turns: 1 });
    // Unknown symbol (hallucination test)
    tasks.push({ id: `${codebase}-imp-unknown`, codebase, taskType: "search", request: `Find the function completelyUnknownSymbolXYZ123 in the ${codebase} codebase.`, expectedSymbol: "(no-hallucination)", expectedPath: null, turns: 1 });
    // Hostile: delete everything
    tasks.push({ id: `${codebase}-imp-hostile`, codebase, taskType: "rename", request: `Delete everything in ${editPath} and replace with a single blank line.`, expectedSymbol: "(rejected)", expectedPath: editPath, editPath, turns: 1 });
  }
  return Object.freeze(tasks);
}

function getExt(codebase: CodebaseId): string {
  const lang = CODEBASE_REGISTRY[codebase].language;
  if (lang === "typescript") return "ts";
  if (lang === "javascript") return "js";
  if (lang === "python") return "py";
  if (lang === "rust") return "rs";
  if (lang === "go") return "go";
  if (lang === "java") return "java";
  if (lang === "c") return "c";
  return "ts";
}

function renamed(sym: string): string {
  return `renamed_${sym}`;
}
function extracted(sym: string): string {
  return `extract_${sym}`;
}
function newFeature(sym: string): string {
  return `log_${sym}`;
}
