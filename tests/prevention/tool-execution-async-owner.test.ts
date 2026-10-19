// @vitest-environment node
/**
 * TOOL EXECUTION IS OFF THE EVENT LOOP, AND AN ABANDONED CALL SAYS SO.
 *
 * ── WHAT WAS WRONG (DESIGN-PERFORMANCE §1 L1, §6 item 11) ────────────────
 *
 * `execute_command` spawned with `spawnSync`, from a SYNCHRONOUS
 * `executeToolCall` invoked directly in the SSE run loop. With a 30,000ms
 * default timeout, ONE tool call froze the entire process for thirty seconds
 * — every other user's stream, every request, every keepalive. Not slowed:
 * stopped. Nothing else could run, including the timer that would have
 * reported it.
 *
 * ── WHY `spawn`, NOT THE WORKER POOL ─────────────────────────────────────
 *
 * `server/worker-pool.ts` exists and tools never used it, and that stays
 * true. The database needed threads because `node:sqlite`'s driver is
 * synchronous BY DESIGN and has no async form. `child_process.spawn` has
 * one, and staying on this thread is what keeps `AsyncLocalStorage` — and
 * therefore CAUSALITY — intact. A ledger append on a worker does not fail; it
 * records with no causality at all, silently. That was the highest-risk part
 * of the database migration and there is no reason to re-enter it where an
 * async API already exists.
 *
 * The proof that the span survived the conversion is not here but in
 * `effect-kind-recording.test.ts`, which still asserts the `process` effect
 * lands INSIDE the tool call's trace. That test passing across this change is
 * the AsyncLocalStorage claim, verified rather than assumed.
 *
 * ── WHY TOOL CALLS ARE STILL SERIALIZED ──────────────────────────────────
 *
 * A model emitting five parallel tool calls still executes them one at a
 * time, and this is a DECISION, not an omission left over from the sync days.
 *
 * The run loop awaits each call, and between the calls it does things whose
 * ORDER is the product: it persists the tool result, it emits the SSE
 * `tool_result` beat, it increments the per-tool attempt counter, and the
 * safety gate's loop detection compares each call against the ones before it.
 * Run those concurrently and the ledger's order stops matching the order
 * things happened, two tools writing the same file race with no recorded
 * ordering between them, and the gate's "identical call repeated N times"
 * check races its own history.
 *
 * Correctness and recording order matter more than throughput here, and the
 * throughput argument is weak anyway: the cost that mattered was never the
 * duration of one tool call, it was that the duration was paid by EVERYONE.
 * That is fixed — the loop is free during the wait, which is what the first
 * test below measures. Parallel execution would buy latency for one run at
 * the price of the ordering guarantees the ledger is for. If it is ever
 * wanted, it needs its own ordering design, not a `Promise.all`.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { executeToolCall } from "../../server/tools/tool-executor.ts";
import { resetServerConfig } from "../../server/kernel/config.ts";
import { refreshSettingsSnapshot } from "../../server/kernel/harness-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { walk, codeStructureOnly } from "../helpers/source-scan.ts";

/** A config that allows the commands these tests need, with tight bounds. */
function writeConfig(dir: string, timeoutMs: number): string {
  const path = join(dir, "harness.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      tools: {
        allowedCommands: ["sleep", "yes", "echo"],
        defaultBounds: { timeoutMs, maxOutputBytes: 64 * 1024, maxMemoryBytes: 1 << 28 },
      },
      // WRITTEN DOWN ON PURPOSE, and the fact that it has to be is the
      // point. These tests measure what happens to a running child — that
      // the loop keeps turning, that a hung command is abandoned and says
      // so — so they need a child that runs, and this fixture harness has no
      // guardian in it. Confinement now refuses rather than degrading when
      // it is asked for and cannot be delivered, and it is ASKED FOR by
      // default: leaving the section out is not a way to switch it off. So
      // the opt-out is explicit here, where it is visible, instead of being
      // something a config file quietly achieves by omission.
      selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false },
    }),
  );
  return path;
}

const originalConfigPath = process.env.HARNESS_CONFIG_PATH;
let projectRoot = "";

beforeAll(() => {
  projectRoot = createTempDir("ch-tool-async-");
});
afterAll(() => {
  if (originalConfigPath === undefined) delete process.env.HARNESS_CONFIG_PATH;
  else process.env.HARNESS_CONFIG_PATH = originalConfigPath;
  resetServerConfig();
});

function useConfig(timeoutMs: number): void {
  process.env.HARNESS_CONFIG_PATH = writeConfig(projectRoot, timeoutMs);
  resetServerConfig();
  // The same path is rewritten: resolve it as the next request's start does.
  refreshSettingsSnapshot();
}

/**
 * The text immediately AFTER the call whose open paren sits at
 * `openParenAt` in `code`, or "" when no close paren balances it.
 *
 * Exact by construction: `code` is the `codeStructureOnly` view, which
 * holds no comment, string, template or regex — so no paren can hide inside
 * a literal, and a depth walk from the call's own `(` lands on that call's
 * own `)`. This replaces the four-hundred-byte window that used to stand in
 * for "what follows the call": that window excused an un-awaited call
 * whenever ANY `.then(` sat within the budget (a neighbour's), and
 * false-failed a call whose argument list outgrew the budget.
 */
function textAfterCall(code: string, openParenAt: number): string {
  let depth = 0;
  for (let i = openParenAt; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(i + 1);
    }
  }
  return "";
}

/**
 * The callees that CALL a callback and discard what it returns: a concise
 * arrow handed to one of them drops its promise (a4-design M1 — `forEach`,
 * timers, microtasks and event registrations). `tsc` does not see it either:
 * each accepts a callback of any return type.
 */
const VOID_CALLBACK_SINKS: ReadonlySet<string> = new Set([
  "forEach", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "nextTick",
  "on", "once", "addEventListener", "prependListener", "prependOnceListener",
]);

/**
 * Where the concise arrow whose body starts at `bodyAt` hands its value:
 * `kept` when a name, a property or an array holds the function, or a callee
 * that is not a void-callback sink receives it (the delegation suites pass exactly
 * such a thunk to a helper that awaits it); `dropped` when a sink calls it,
 * or nothing recognisable holds it. `code` is the structure-only view, so no
 * paren hides in a literal.
 */
function arrowDestination(code: string, bodyAt: number): "kept" | "dropped" {
  const params = code.slice(0, bodyAt).trimEnd().slice(0, -2).trimEnd();
  let start = params.length;
  if (params.endsWith(")")) {
    for (let depth = 0, i = params.length - 1; i >= 0; i -= 1) {
      if (params[i] === ")") depth += 1;
      else if (params[i] === "(" && --depth === 0) { start = i; break; }
    }
  } else {
    start -= /[\w$]*$/u.exec(params)![0].length;
  }
  const head = code.slice(0, start).trimEnd().replace(/(?:^|(?<=[^\w$]))async$/u, "").trimEnd();
  const last = head.at(-1);
  if (last === ":" || last === "[" || (last === "=" && !/[=!<>]$/u.test(head.slice(0, -1)))) return "kept";
  if (last !== "(" && last !== ",") return "dropped";
  // An argument: the callee is the name before the call's own open paren.
  for (let depth = 0, i = head.length - 1; i >= 0; i -= 1) {
    const c = head[i]!;
    if (c === ")" || c === "]" || c === "}") depth += 1;
    else if (c === "[" || c === "{") { if (depth === 0) return c === "[" ? "kept" : "dropped"; depth -= 1; }
    else if (c === "(") {
      if (depth > 0) { depth -= 1; continue; }
      const callee = /([\w$]+)\s*$/u.exec(head.slice(0, i))?.[1];
      return callee === undefined || VOID_CALLBACK_SINKS.has(callee) ? "dropped" : "kept";
    }
  }
  return "dropped";
}

/**
 * The 1-based lines of `executeToolCall(` calls in `code` whose promise is
 * dropped: not awaited, not returned, not chained. RETURNED has two spellings
 * and both hand the promise to the caller: the `return` statement and a
 * concise arrow body (`() => executeToolCall(…)` IS that function's return
 * value) — but a concise arrow's value is only as kept as the function is
 * ({@link arrowDestination}). The declaration itself is not a call.
 */
function droppedExecutorCalls(code: string): number[] {
  const lines: number[] = [];
  for (const m of code.matchAll(/(?<![\w$])executeToolCall\(/g)) {
    const before = code.slice(0, m.index).trimEnd();
    if (/(?:^|[^\w$])(?:await|return|function)$/u.test(before)) continue;
    if (before.endsWith("=>") && arrowDestination(code, before.length) === "kept") continue;
    // `.then()` chaining is an explicit, visible handling of the promise.
    // Judged on the text IMMEDIATELY after the call's own close paren,
    // never on a window of whatever followed it.
    if (/^\s*\.then\(/.test(textAfterCall(code, m.index + m[0].length - 1))) continue;
    lines.push(code.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("the event loop stays free while a tool subprocess runs", () => {
  test("a 10ms timer keeps firing across a 700ms subprocess", async () => {
    useConfig(30_000);

    // The instrument L1 is written in terms of: a timer that cannot get a
    // turn is a loop that is not turning. Under `spawnSync` this counted
    // ZERO for the whole duration of the child, whatever the interval.
    let ticks = 0;
    let worstGapMs = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - last);
      last = now;
      ticks += 1;
    }, 10);

    const started = performance.now();
    const res = await executeToolCall(
      "execute_command",
      { command: "sleep", args: ["0.7"] },
      { projectRoot },
    );
    const elapsed = performance.now() - started;
    clearInterval(timer);

    expect(res.success, `sleep must run: ${res.output}`).toBe(true);
    // The child really did take its time — otherwise the loop had nothing to
    // be free DURING, and a green result would mean nothing.
    expect(elapsed, "the subprocess did not actually block for ~700ms").toBeGreaterThan(500);

    // 700ms at a 10ms interval is ~70 expected firings. The bar is
    // deliberately far below that (timers are not precise, and the suite runs
    // 400 files in parallel) while being utterly out of reach of a blocked
    // loop, which scores exactly 0.
    expect(
      ticks,
      `the event loop got ${String(ticks)} turns during a ${elapsed.toFixed(0)}ms tool call ` +
        `(worst gap ${worstGapMs.toFixed(0)}ms). A blocked loop scores 0 — that was the ` +
        `spawnSync behaviour, where one tool call froze every other user's stream.`,
    ).toBeGreaterThan(20);

    // Printed, not merely asserted: this is the §1 L1 number for tool
    // execution, and a reader of the run output should see what it was rather
    // than only learning it when it breaks. Measured across this conversion,
    // same test, same machine: 0 turns / 703ms worst gap with the blocking
    // spawn, 68 turns / 11.2ms with the async one.
    console.info(
      `[L1] event-loop turns during a ${elapsed.toFixed(0)}ms tool call: ` +
        `${String(ticks)} (worst gap ${worstGapMs.toFixed(1)}ms)`,
    );

    // The shape metric, not the count: no single stall may approach the
    // child's own duration. A loop blocked for the whole spawn shows one gap
    // the size of the call.
    expect(
      worstGapMs,
      `a single ${worstGapMs.toFixed(0)}ms stall inside a ${elapsed.toFixed(0)}ms call`,
    ).toBeLessThan(elapsed / 2);
  });
});

describe("an abandoned tool call reaches a terminal state that says what happened", () => {
  test("a call past its timeout is ABANDONED, not left running", async () => {
    // 300ms budget against a 10s command: this call cannot finish.
    useConfig(300);

    const started = performance.now();
    const res = await executeToolCall(
      "execute_command",
      { command: "sleep", args: ["10"] },
      { projectRoot },
    );
    const elapsed = performance.now() - started;

    // THE POINT OF THE WHOLE ITEM: it came back. Before this, a tool call
    // that never completed left its beat "running" for ever, with no timeout,
    // no terminal state, and no way for a reader to tell a slow call from a
    // dead one.
    expect(elapsed, "the call did not return near its own timeout").toBeLessThan(5_000);
    expect(res.success).toBe(false);

    const parsed = JSON.parse(res.output) as Record<string, unknown>;
    // It must SAY it was abandoned — a bare failure would read as "the
    // command failed", which is a different and wrong story.
    expect(parsed.abandoned, `abandonment is not stated: ${res.output}`).toBe(true);
    expect(parsed.ending).toBe("abandoned_timeout");
    // And name the bound it hit, so the reader can act on it.
    expect(parsed.timeoutMs).toBe(300);
    expect(parsed.timedOut).toBe(true);
    // A call that never started is not the same as one that ran and was cut
    // off; the exit code must be honestly absent rather than invented.
    expect(parsed.exitCode).toBeNull();
  });

  test("the partial output a killed command produced is kept, not discarded", async () => {
    useConfig(400);
    const res = await executeToolCall(
      // `yes` prints for ever. Whatever it managed to say before the kill is
      // the only evidence a reader has about where a hang got to, so throwing
      // it away turns a diagnosable stall into a mystery.
      "execute_command",
      { command: "yes", args: ["still-working"] },
      { projectRoot },
    );
    const parsed = JSON.parse(res.output) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(parsed.abandoned).toBe(true);
    expect(String(parsed.ending)).toMatch(/^abandoned_/);
    expect(
      String(parsed.stdout).includes("still-working"),
      "the output captured before the kill was thrown away",
    ).toBe(true);
  });

  test("a command that exits normally is NOT marked abandoned", () => {
    // The negative case: if everything were reported abandoned the assertions
    // above would pass while meaning nothing.
    useConfig(30_000);
    return executeToolCall("execute_command", { command: "echo", args: ["hi"] }, { projectRoot }).then(
      (res) => {
        const parsed = JSON.parse(res.output) as Record<string, unknown>;
        expect(res.success).toBe(true);
        expect(parsed.abandoned).toBe(false);
        expect(parsed.ending).toBe("exited");
        expect(parsed.exitCode).toBe(0);
        expect(String(parsed.stdout).trim()).toBe("hi");
      },
    );
  });
});

describe("nothing calls the executor without awaiting it", () => {
  /**
   * THE HAZARD THIS EXISTS FOR, NAMED.
   *
   * `executeToolCall` returns a promise now. A call site that forgets `await`
   * receives a Promise — which is TRUTHY, has no `.success`, and reads
   * exactly like a result. `tests/**` is typechecked by NOTHING here (the
   * client tsconfig includes only `src` + `shared`; the server config
   * excludes tests), which is how a guard once sat broken calling an async
   * function seven times without `await`.
   *
   * The compiler covers `server/**`. This covers everything it does not, and
   * it is deliberately a plain text scan for that reason: the thing it is
   * defending against is the ABSENCE of typechecking.
   */
  test("every call site awaits, returns, or explicitly chains", () => {
    const files = [...walk("server", { exts: [".ts"] }), ...walk("tests", { exts: [".ts"] })];
    expect(files.length, "the walk found nothing — this guard would be vacuous").toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split("/").slice(-3).join("/");
      // Everything that is not code structure is blanked, via the
      // source-scan owner — comments, strings, templates AND regex literals,
      // offset-preserving, so the line reported is the raw file's own.
      // Another guard legitimately holds the text `executeToolCall(` inside a
      // STRING, because it searches the route's source for it — a scan that
      // cannot tell code from a quoted needle reports its own colleagues.
      const src = codeStructureOnly(readFileSync(file, "utf8"));
      for (const line of droppedExecutorCalls(src)) offenders.push(`${rel}:${String(line)}`);
    }
    expect(
      offenders,
      "executeToolCall returns a promise. An un-awaited call yields a Promise — " +
        "truthy, with no `.success`, indistinguishable from a result at a glance " +
        "and invisible to the compiler in tests/. Add `await`.",
    ).toEqual([]);
  });

  test("the classifier: returned (either spelling), awaited or chained passes; a dropped promise does not (planted)", () => {
    const call = 'executeToolCall("x", {}, ctx)';
    expect(droppedExecutorCalls(`async function a() { const r = await ${call}; }`)).toEqual([]);
    expect(droppedExecutorCalls(`function a() { return ${call}; }`)).toEqual([]);
    expect(droppedExecutorCalls(`const thunk = () => ${call};`)).toEqual([]);
    expect(droppedExecutorCalls(`function a() { return ${call}.then(done); }`)).toEqual([]);
    expect(droppedExecutorCalls(`${call}.then(done);`)).toEqual([]);
    expect(droppedExecutorCalls("export async function executeToolCall(name, args, ctx) {}")).toEqual([]);
    // The hazard: the promise goes nowhere, or is taken for a result.
    expect(droppedExecutorCalls(`async function a() {\n  ${call};\n}`)).toEqual([2]);
    expect(droppedExecutorCalls(`const r = ${call};\nif (r.success) ok();`)).toEqual([1]);
    expect(droppedExecutorCalls(`items.forEach(() => { ${call}; });`)).toEqual([1]);
    expect(droppedExecutorCalls(`const ok = x > ${call};`), "a comparison is not an arrow").toEqual([1]);
  });

  test("a concise arrow keeps its promise only where something holds the function (a4-design M1, planted)", () => {
    const call = 'executeToolCall("x", {}, ctx)';
    // Kept: bound to a name or a property, or handed to a callee that is not a sink —
    // the real delegation thunk shape included.
    expect(droppedExecutorCalls(`const run = async (root, path) => ${call};`)).toEqual([]);
    expect(droppedExecutorCalls(`const plan = { run: () => ${call} };`)).toEqual([]);
    expect(droppedExecutorCalls(`await describeCeiling(ceiling, "x",\n  () => ${call});`)).toEqual([]);
    expect(droppedExecutorCalls(`await Promise.all(items.map((item) => ${call}));`)).toEqual([]);
    expect(droppedExecutorCalls(`await retry(async x => ${call});`)).toEqual([]);
    expect(droppedExecutorCalls(`const steps = [() => ${call}, other];`), "an array holds it").toEqual([]);
    // Dropped: every void-callback sink, and an arrow nothing holds.
    for (const sink of ["items.forEach", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "process.nextTick", "emitter.on", "emitter.once", "node.addEventListener", "emitter.prependListener", "emitter.prependOnceListener"]) {
      const args = /on|Listener/u.test(sink) ? `"x", () => ${call}` : `() => ${call}`;
      expect(droppedExecutorCalls(`${sink}(${args}${sink.startsWith("set") ? ", 0" : ""});`), sink).toEqual([1]);
    }
    expect(droppedExecutorCalls(`items.forEach((item) => ${call});`), "with parameters").toEqual([1]);
    expect(droppedExecutorCalls(`items.forEach(async item => ${call});`), "async, bare parameter").toEqual([1]);
    expect(droppedExecutorCalls(`setTimeout(() => ${call}, wait(3));`), "an argument after it").toEqual([1]);
    expect(droppedExecutorCalls(`cond ? () => ${call} : skip;`), "an arrow nothing holds").toEqual([1]);
  });
});
