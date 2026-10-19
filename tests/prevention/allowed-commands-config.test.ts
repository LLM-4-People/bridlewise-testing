// @vitest-environment node
/**
 * Prevention: ALLOWED_COMMANDS must come from the config, NOT a
 * hardcoded Set in source.
 *
 * This test fails if `tool-executor.ts` reintroduces a hardcoded
 * `ALLOWED_COMMANDS` Set/Array literal. The allowed list must be read from
 * the harness config via `getAllowedCommands()`.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

import { modulePath } from "../helpers/module-resolver.ts";
const EXECUTOR_PATH = modulePath("tool-executor.ts");

describe("ALLOWED_COMMANDS is config-driven (not hardcoded)", () => {
  const source = readFileSync(EXECUTOR_PATH, "utf8");

  test("tool-executor.ts does not declare a hardcoded ALLOWED_COMMANDS Set/Array", () => {
    // A hardcoded literal like `new Set<string>([...])` or `= [ "node",... ]`
    // assigned to ALLOWED_COMMANDS is the violation. The config-driven path
    // uses `getAllowedCommands()` from harness-config.ts.
    const hardcodedSet = /const\s+ALLOWED_COMMANDS\s*=\s*new\s+Set/i;
    const hardcodedArray = /const\s+ALLOWED_COMMANDS\s*=\s*\[/i;
    expect(hardcodedSet.test(source), "Found hardcoded `const ALLOWED_COMMANDS = new Set(...)` — move to config").toBe(false);
    expect(hardcodedArray.test(source), "Found hardcoded `const ALLOWED_COMMANDS = [...]` — move to config").toBe(false);
  });

  test("tool-executor.ts imports getAllowedCommands from harness-config", () => {
    expect(source).toContain('getAllowedCommands');
    expect(source).toMatch(/from\s+["']\.\.\/kernel\/harness-config\.ts["']/);
  });

  test("tool-executor.ts uses getAllowedCommands at call time (not import time)", () => {
    // The allowed set must be re-read when the config changes — a module-level
    // `const allowed = getAllowedCommands()` would freeze it at import time.
    // The call must be inside the function body.
    expect(source).toMatch(/const\s+allowedCommands\s*=\s*getAllowedCommands\(\)/);
  });
});

/**
 * THE INVARIANT THAT WAS ONLY A COMMENT.
 *
 * `tool-executor.ts` stated that mutating filesystem commands — touch, mkdir,
 * cp, mv, sed, awk — are "intentionally EXCLUDED from the default config
 * list", because this server has no write-set governance over a subprocess and
 * a shell that writes files escapes both that governance and the editor's
 * recording and rollback. The config listed **all six**. The paragraph had
 * been false for as long as nobody re-read it, which is what a security
 * invariant kept in prose eventually becomes.
 *
 * Two assertions, because they fail differently: the config must not name one
 * (hygiene), and the DOOR must refuse one even when it is named (enforcement).
 * The second is the one that matters — it is the reason the invariant is now
 * true rather than merely written down.
 *
 * Deliberately NOT claimed: this does not stop file mutation through `make`,
 * `cargo`, `npm` or `python`, which write files as their purpose. The set
 * covers the shell primitives whose only use here is to bypass the editor.
 */
describe("shell commands that change files are refused by the door, not by a paragraph", () => {
  test("the config names none of them", async () => {
    const { getAllowedCommands } = await import("../../server/kernel/harness-config.ts");
    const { SHELL_FILE_MUTATION_COMMANDS } = await import("../../server/tools/tool-executor.ts");
    const allowed = getAllowedCommands();
    // Liveness: the population, as a runtime number with a floor. An empty
    // allowed list, or an empty mutation set, would satisfy the intersection
    // below by having nothing to intersect.
    expect(allowed.size, "commands the config allows").toBeGreaterThan(10);
    expect(SHELL_FILE_MUTATION_COMMANDS.size, "shell mutation commands declared").toBeGreaterThan(5);
    expect([...allowed].filter((c) => SHELL_FILE_MUTATION_COMMANDS.has(c))).toEqual([]);
  });

  test("the executor refuses every one of them, and says which tool to use instead", async () => {
    const { executeToolCall, SHELL_FILE_MUTATION_COMMANDS } = await import("../../server/tools/tool-executor.ts");
    const ctx = { runId: "mutation-gate", userId: "mutation-gate", projectRoot: process.cwd() };
    let refused = 0;
    for (const command of SHELL_FILE_MUTATION_COMMANDS) {
      const result = await executeToolCall("execute_command", { command }, ctx);
      expect(result.success, `${command} was not refused`).toBe(false);
      expect(result.output, `${command}'s refusal must name the governed alternative`).toContain("edit");
      expect(result.output).toContain("write set");
      refused += 1;
    }
    expect(refused, "commands driven through the door").toBe(SHELL_FILE_MUTATION_COMMANDS.size);
  });

  test("liveness — a command the config DOES allow still runs, so the gate is not refusing everything", async () => {
    const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
    // A TEMPORARY FOLDER, NOT `process.cwd()`, and the reason is the property
    // under test elsewhere: this repository holds the harness's own program
    // code, which is a protected subtree, so a confined command cannot be run
    // against it at all. Using the working directory here would measure that
    // refusal and report it as the allow-list refusing everything.
    const { createTempDir } = await import("../helpers/temp-dir.ts");
    const project = createTempDir("allowed-commands-liveness-");
    const result = await executeToolCall(
      "execute_command",
      { command: "echo", args: ["still-alive"] },
      { userId: "mutation-gate", projectRoot: project },
    );
    expect(result.success, "a refusal-for-everything gate would pass the test above and break the tool").toBe(true);
    expect(result.output).toContain("still-alive");
  });
});
