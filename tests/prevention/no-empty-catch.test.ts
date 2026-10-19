// @vitest-environment node
/**
 * Mechanical enforcement: no empty (or comment-only) catch blocks.
 *
 * "All catch blocks must be properly implemented —
 * handle the error, rethrow as typed error, or log it. Empty catch blocks
 * with comments are prohibited." This covers both try/catch handlers and
 * inline-block promise `.catch()` handlers.
 *
 * The classification is the ONE shared catch classifier
 * (`engine/scripts/verification/catch-blocks.ts`), which the engine's
 * empty-catch and unhandled-error guards also use: a body that is blank,
 * comment-only, or only no-op statements (`void e;`, a bare `e;`) is empty.
 * Bodies are read through the sanctioned source view, so braces and the word
 * `catch` inside strings, templates or comments never confuse the scan.
 */
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { findCatchBlocks } from "../../engine/scripts/verification/catch-blocks.ts";
import { committedRatchetBaseline, judgeRatchet, parseRatchetBaseline, ratchetFailure } from "../../engine/scripts/verification/ratchet.ts";
import { ratchetBaseline } from "../../engine/scripts/verification/ratchet-baselines.ts";
import { readSourceView, sourceViewOf } from "../../engine/scripts/verification/source-view.ts";
import { walk } from "../helpers/source-scan.ts";

const ROOTS = ["src", "server"] as const;
/**
 * The web's UNHANDLED catches (the engine's rule, a2-design M4): the debt that
 * existed when the rule reached the web tree is a shrink-only ratchet
 * (`engine/scripts/verification/ratchet.ts`): a new unhandled catch fails, a
 * fixed one must leave the list (`harness sync` prunes it), and the list may
 * not grow past HEAD. The scan is the baseline generator's own
 * (`ratchet-baselines.ts`, a2b-design H2), so the keys are never typed by hand.
 */
const UNHANDLED_RATCHET = ratchetBaseline("web-unhandled-catch");

describe("no empty catch blocks", () => {
  const findings: { file: string; line: number; form: string }[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      for (const block of findCatchBlocks(readSourceView(file))) {
        if (block.verdict === "empty") findings.push({ file: relative(process.cwd(), file), line: block.line, form: block.form });
      }
    }
  }

  test("src/ and server/ add no unhandled catch body (the web ratchet)", () => {
    const unhandled = UNHANDLED_RATCHET.findings(process.cwd()).map((finding) => finding.key);
    const baseline = parseRatchetBaseline(readFileSync(UNHANDLED_RATCHET.path, "utf8"), UNHANDLED_RATCHET.path);
    const failure = ratchetFailure(UNHANDLED_RATCHET.path, judgeRatchet(unhandled, baseline, committedRatchetBaseline(process.cwd(), UNHANDLED_RATCHET.id)));
    if (failure !== undefined) {
      throw new Error(`${failure}\n\nHandle what a catch caught: rethrow a typed error, return, use the error, or call a central handler (webHandleError, webWarn, webAuditEvent).`);
    }
  });

  test("src/ and server/ have no empty/comment-only catch bodies", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  (${f.form === "promise" ? ".catch handler" : "catch block"})`).join("\n");
      throw new Error(
        `Empty catch blocks found — handle/rethrow/log the error (comments, \`void e;\` and a bare \`e;\` are not enough):\n${detail}`,
      );
    }
  });

  test("the shared classifier refuses the empty shapes and admits real handling", () => {
    const verdicts = (source: string) => findCatchBlocks(sourceViewOf(source, "probe.ts")).map((block) => block.verdict);
    for (const empty of ["try { a(); } catch { /* nothing */ }", "try { a(); } catch (e) { void e; }", "p.catch(() => { // ignore\n});"]) {
      if (verdicts(empty).join() !== "empty") throw new Error(`must be empty: ${empty}`);
    }
    for (const handled of ["try { a(); } catch (e) { report(e); }", "p.catch((error) => { throw error; });"]) {
      if (verdicts(handled).join() !== "handled") throw new Error(`must be handled: ${handled}`);
    }
    if (verdicts('const s = "catch { }"; // catch {}').length !== 0) throw new Error("a catch inside a string or comment is not code");
  });
});
