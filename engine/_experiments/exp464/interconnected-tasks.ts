/**
 * EXP464 — The 10 interconnected tasks (task N+1 depends on task N).
 *
 * These tasks form a dependency chain: each task builds on the result of
 * the previous one. This tests multi-turn conversation continuity, memory
 * recall, and the harness's ability to track state across turns.
 *
 * The tasks are about an "assertion utility" refactor — the same kind of
 * multi-step refactor EXP438 ran on babel (makeAssertNode → createAssertion).
 *
 * Per the binding directives: "10 interconnected tasks (task 2 depends on
 * task 1, etc.)" and "100 turns per task (multi-turn)."
 */

import type { InterconnectedTask } from "./types.ts";

export const INTERCONNECTED_TASKS: readonly InterconnectedTask[] = Object.freeze([
  {
    id: "ic-1",
    step: 1,
    request: "Find all assertion utilities in the codebase. Search for functions with 'assert' in their name.",
    expected: "assert",
    dependsOn: null,
  },
  {
    id: "ic-2",
    step: 2,
    request: "Rename the function makeAssertNode to createAssertion in src/sample.ts. Output the full file in a fenced block with a path=src/sample.ts annotation.",
    expected: "createAssertion",
    dependsOn: "ic-1",
    editPath: "src/sample.ts",
  },
  {
    id: "ic-3",
    step: 3,
    request: "Extract the type-checking logic from createAssertion into a new helper called checkAssertionType in src/sample.ts. Output the full file in a fenced block with a path=src/sample.ts annotation.",
    expected: "checkAssertionType",
    dependsOn: "ic-2",
    editPath: "src/sample.ts",
  },
  {
    id: "ic-4",
    step: 4,
    request: "Add a new function createShorthandAssertion that wraps createAssertion with a simpler API in src/sample.ts. Output the full file in a fenced block with a path=src/sample.ts annotation.",
    expected: "createShorthandAssertion",
    dependsOn: "ic-3",
    editPath: "src/sample.ts",
  },
  {
    id: "ic-5",
    step: 5,
    request: "Update all tests for the assertion utilities. Add tests for createAssertion, checkAssertionType, and createShorthandAssertion in test/sample.test.ts. Output the file in a fenced block with a path=test/sample.test.ts annotation.",
    expected: "test/sample.test.ts",
    dependsOn: "ic-4",
    editPath: "test/sample.test.ts",
  },
  {
    id: "ic-6",
    step: 6,
    request: "Check for issues in the assertion utilities. Run a quality check on src/sample.ts and report any diagnostics.",
    expected: "0",
    dependsOn: "ic-5",
  },
  {
    id: "ic-7",
    step: 7,
    request: "Find all callers of createAssertion across the codebase. Search for every file that calls createAssertion.",
    expected: "createAssertion",
    dependsOn: "ic-6",
  },
  {
    id: "ic-8",
    step: 8,
    request: "Add a parameter strict: boolean to the function createAssertion in src/sample.ts. When strict is true, throw an error on assertion failure. Output the full file in a fenced block with a path=src/sample.ts annotation.",
    expected: "createAssertion",
    dependsOn: "ic-7",
    editPath: "src/sample.ts",
  },
  {
    id: "ic-9",
    step: 9,
    request: "Update all callers of createAssertion to pass the new strict parameter. Find every call site and add strict=true. Output the updated files in fenced blocks with path annotations.",
    expected: "createAssertion",
    dependsOn: "ic-8",
    editPath: "src/sample.ts",
  },
  {
    id: "ic-10",
    step: 10,
    request: "Summarize all the changes we made to the assertion utilities. What did we rename, extract, add, and update?",
    expected: "createAssertion",
    dependsOn: "ic-9",
  },
]);

/** The sample file for interconnected tasks. */
export const IC_SAMPLE_CONTENT = `// src/sample.ts — assertion utility (interconnected tasks)
export function makeAssertNode(node: unknown): boolean {
  if (node === null || node === undefined) return false;
  return true;
}

export function parseStatement(input: string): string {
  return input;
}
`;
