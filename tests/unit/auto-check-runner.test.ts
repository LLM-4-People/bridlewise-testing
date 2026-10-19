// @vitest-environment node
/**
 * Unit tests for the auto-check runner — verifies the "Run
 * typecheck" and "Run lint" buttons execute REAL checks and return
 * completed outcomes (not "running" stubs).
 */
import { describe, test, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { runAutoCheck, isRunnableCheck } from "../../server/awareness/auto-check-runner.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let projectRoot = "";

beforeEach(() => {
  projectRoot = createTempDir("ch-autock-");
});

describe("auto-check runner", () => {
  test("typecheck and lint are runnable; unknown checks are not", () => {
    expect(isRunnableCheck("typecheck")).toBe(true);
    expect(isRunnableCheck("lint")).toBe(true);
    expect(isRunnableCheck("custom-thing")).toBe(false);
  });

  test("typecheck PASSES on a project with no type errors", async () => {
    // A project with a valid tsconfig + a clean.ts file typechecks clean.
    writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, lib: ["es2022"], module: "esnext", moduleResolution: "bundler", target: "es2022" },
      include: ["*.ts"],
    }));
    writeFileSync(join(projectRoot, "ok.ts"), "export const x: number = 1;\n");
    const outcome = await runAutoCheck("typecheck", projectRoot);
    expect(outcome.status).toBe("passed");
    expect(outcome.output.exitCode).toBe(0);
    expect(outcome.output.errorCount).toBe(0);
  }, 60_000);

  test("typecheck FAILS on a project with a type error", async () => {
    writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, lib: ["es2022"], module: "esnext", moduleResolution: "bundler", target: "es2022" },
      include: ["*.ts"],
    }));
    // A type error: assigning a string to a number.
    writeFileSync(join(projectRoot, "bad.ts"), "export const x: number = \"not a number\";\n");
    const outcome = await runAutoCheck("typecheck", projectRoot);
    expect(outcome.status).toBe("failed");
    expect(outcome.output.exitCode).not.toBe(0);
    expect(outcome.output.errorCount).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("an UNEXPECTED error is thrown, never returned as a lint verdict", async () => {
    // A CRASH IS NOT A DOMAIN ANSWER. The lint path catches to retry a
    // worker-not-ready failure, and it used to catch EVERYTHING: a
    // `ReferenceError` from a shadowed binding reached the user as
    // `{"error":"lint_failed"}` — a defect in this program, reported as a
    // finding about theirs. The instance was renamed away and the loop was not
    // touched, so this drives the loop with something it does not know.
    //
    // The plant enters where a real caller enters: `runAutoCheck` with an
    // ownership gate, exactly as a route supplies one. A gate whose `decisions`
    // is not a Map makes `gate.decisions.has(...)` throw a TypeError from
    // inside the bridge — an error of a type this loop has no meaning for.
    const brokenGate = { decisions: null } as unknown as Parameters<typeof runAutoCheck>[2];
    await expect(runAutoCheck("lint", projectRoot, brokenGate)).rejects.toThrowError(TypeError);
  }, 60_000);

  test("lint returns a quality score and a status", async () => {
    writeFileSync(join(projectRoot, "a.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    const outcome = await runAutoCheck("lint", projectRoot);
    expect(["passed", "warning", "failed"]).toContain(outcome.status);
    expect(typeof outcome.output.score).toBe("number");
    expect(outcome.output).toHaveProperty("grade");
    expect(outcome.output).toHaveProperty("recommendations");
  }, 60_000);

  test("unknown check name returns a typed not-runnable outcome", async () => {
    const outcome = await runAutoCheck("nonexistent", projectRoot);
    expect(outcome.status).toBe("warning");
    expect(outcome.output.error).toBe("check_not_runnable");
  });
});
