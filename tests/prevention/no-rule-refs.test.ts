// @vitest-environment node
/**
 * Mechanical enforcement: no AGENTS.md rule references in source files.
 *
 * Rules belong in AGENTS.md, not in the code. The code should stand on its
 * own without referencing internal rule numbers. This test scans ALL source
 * files (dynamically discovered via readdirSync — no hardcoded file lists)
 * and fails if any `rule <number>` or `AGENTS.md` reference remains in a
 * source file (comments, UI text, test descriptions, error messages).
 *
 * Excluded (these are the docs that legitimately contain rule references):
 *   - AGENTS.md, TASKS.md, WORKFLOW.md, ALL-BUGS-AND-ISSUES.md,
 *     ALL-MERGE-MANIFESTS.json (the tracking docs themselves)
 *   - this test file (it must mention the patterns it scans for)
 *   - node_modules, dist, .git, .svelte-kit (build artifacts)
 *
 * Assurance classes:
 *   A. No `rule <number>` references (e.g. "rule N", "rule N/M", "Rule N")
 *      in any source file — comments, test descriptions, error messages, UI.
 *   B. No `AGENTS.md` references in any source file.
 *   C. No "binding rule (" or "rule (" + number/name parenthetical stragglers
 *      (a rule reference with the number inside parentheses).
 *   D. The scan is DYNAMIC: it discovers every .ts/.svelte/.mjs/.cjs/.css/.js
 *      file under the watched roots via readdirSync. A new file is
 *      automatically covered — no list to update.
 *
 * Precision: the regex `rule \d` is matched on the RAW line (comments
 * included). Legitimate uses of the word "rule" that are NOT AGENTS.md
 * references ("Horizontal rule", "boundary rule (state/memory.ts)", "rule of
 * thumb") do NOT match `rule \d` (no digit follows "rule"), so they are safe.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative, basename } from "node:path";
import { walk } from "../helpers/source-scan.ts";

/** Roots whose source files are scanned for rule references. */
const ROOTS = ["src", "server", "tests", "shared", "scripts"];
/** Doc files that legitimately reference rules (excluded from the scan). */
const DOCS = new Set([
  "AGENTS.md",
  "TASKS.md",
  "WORKFLOW.md",
  "ALL-BUGS-AND-ISSUES.md",
  "ALL-MERGE-MANIFESTS.json",
]);
/** This test file must name the patterns it scans for — exclude itself. */
const SELF = "no-rule-refs.test.ts";
/**
 * Files whose SUBJECT is the doc filename, exempted with the reason written
 * down rather than by widening `DOCS` (which excuses whole file NAMES and
 * would excuse a future `AGENTS.md` reference in any file called the same).
 *
 * EMPTY TODAY, AND ITS ONE MEMBER LEFT WITH THE FILE IT DESCRIBED. The entry
 * was `scripts/harness-root/seed-experiment.mjs`, a STALE FORK of the engine's
 * seeder that still created hardlinks and whose seed list carried `AGENTS.md`
 * as a payload. The fork is gone; the engine's seeder does not seed that file,
 * so there is nothing left to exempt. The liveness loop below is why this is a
 * deletion rather than a line that quietly aged: an exemption naming a file
 * outside the walked population reds, so removing the file forced the
 * exemption out in the same round.
 *
 * `tests/declared-root.ts` classifies every root entry git must hold BY NAME,
 * and the repository's own agent entry point is one of them: its key is the
 * file's name, data the root inventory matches, never a rule citation.
 *
 * `tests/prevention/agent-docs-liveness.test.ts` checks that the briefing
 * documents name only paths, scripts and commands that exist; the root agent
 * entry point is the first document on its list — a path it READS, never a
 * rule it cites.
 */
const NAMES_THE_DOC_AS_DATA = new Set<string>([
  "tests/declared-root.ts",
  "tests/prevention/agent-docs-liveness.test.ts",
  // Its SUBJECT is who owns each rule: it reads the process document and
  // asserts the refusal list lives there and that both contributor pages
  // point at it. The filename is data it verifies, not a rule it cites.
  "tests/public/docs.test.mjs",
]);
/** File extensions scanned. */
const EXTS = [".ts", ".svelte", ".mjs", ".cjs", ".css", ".js"] as const;
/** Directory names skipped (build artifacts, deps, unrelated). */
const SKIP_DIRS = ["node_modules", "dist", ".git", ".svelte-kit", ".bkp"] as const;

/** Recursively collect source files under `dir`. Dynamic — no hardcoded list. */
function scanSource(dir: string): string[] {
  return walk(dir, { exts: [...EXTS], ignore: [...SKIP_DIRS] });
}

/** `rule <digit>` reference (e.g. "rule N", "rule N/M", "Rule N"). */
const RULE_NUM_RE = /\brule \d/i;
/** `rule #<digit>` reference (e.g. "rule #35" — number after a hash). */
const RULE_HASH_RE = /\brule #\d/i;
/** `AGENTS.md` reference. */
const AGENTS_RE = /AGENTS\.md/i;
/** Straggler: "rule (" + digit (number inside parentheses). */
const RULE_PAREN_RE = /\brule \(\d/i;
/** "binding rule" in any form (colon, plural, parenthetical) — a direct
 * reference to the binding rules. Case-insensitive to catch "Binding rule:",
 * "binding rules:", "binding rule (". */
const BINDING_RULE_RE = /\bbinding rule/i;
/** "directive <digit>" — an alternate AGENTS.md rule reference form (e.g.
 * "directive 22/56", "directive 57"). The single-line scanners above only
 * catch `rule \d`; a comment that says "directive 22" instead of "rule 22"
 * would slip past them. This closes that gap. */
const DIRECTIVE_NUM_RE = /\bdirective \d/i;
/** "rule-<digit>" — the hyphen form of a rule reference (e.g. "rule-22",
 * "rule-22/56", "rule-31"). The space-form scanner (`rule \d`) misses the
 * hyphen separator; this catches the alternate spelling so a comment
 * cannot dodge the check by writing "rule-22" instead of "rule 22". */
const RULE_HYPHEN_RE = /\brule-\d/i;
/** "Round <digit>" — a task/round reference (e.g. "Round 8", "SPO Round 53"). */
const ROUND_NUM_RE = /\bRound \d/i;
/** "Task <digit>" / "TASK <digit>" — an AGENTS.md task-number reference
 * (e.g. a comment or describe name that labels itself with the task
 * number it implements). The code should stand on its own without
 * referencing internal task numbers; the substance (the WHY) belongs in
 * the comment, not the task label. Case-insensitive "Task" catches both
 * spellings; the trailing digit + word boundary avoids false positives on
 * the word "Task" used as a plain noun. */
const TASK_NUM_RE = /\bTask \d/i;
/** "Bug <digit>" / "BUG <digit>" — an internal bug-tracker reference (e.g.
 * a describe name or comment that labels itself with the bug number it
 * fixes). Same class as a task-number reference: the code should stand on
 * its own. The trailing digit avoids false positives on the plain word
 * "bug"; case-insensitive "Bug" catches "BUG N" and "Bug N". */
const BUG_NUM_RE = /\bBug \d/i;
/** "R<digit+>" — abbreviated round reference (e.g. "R8", "R17", "R51").
 * Matches one or more digits. Verified safe: no production code uses bare
 * `R<digit>` identifiers; in comments these are always round references. */
const R_NUM_RE = /\bR\d+\b/;
/** "ON TOP of all rounds" — a workflow-scheduling phrase from the docs. */
const ON_TOP_RE = /\bON TOP of all rounds\b/i;
/** Multi-line "rule" reference — the keyword is at the end of a line and
 * the number is on the next line (after a JSDoc `*` or `//` marker). The
 * single-line scanners miss these; this catches the cross-line pattern. */
  const MULTILINE_RULE_RE = /\brule[\t ]*\n[\t ]*(?:\*[ \t]*|\/\/[ \t]*)\d/i;
  const MULTILINE_ROUND_RE = /\bRound[\t ]*\n[\t ]*(?:\*[ \t]*|\/\/[ \t]*)\d/i;
  /** Broken comment artifact: a `//` comment marker immediately followed by
   * `.` then whitespace or end-of-line — the residue of a stripped rule/round
   * reference (e.g. `// R9. trim` → strip "R9" → `//. trim`; or `// R9.`
   * alone → `//.`). A legitimate comment never starts with `//.` (it starts
   * with `// ` + text). Anchored to the start of a comment line (leading
   * whitespace, then the marker, then a dot, then whitespace/END) so URLs
   * (`https` + colon + `//`) and dotfile/extension refs (`//.svelte`,
   * `//.hidden`) — where a letter follows the dot — are excluded. Zero false
   * positives: every line starting with the marker + a dot + space/END is a
   * stripped reference artifact. */
  const BROKEN_COMMENT_RE = /^\s*\/\/\.(?:\s|$)/;

describe("no rule references in source files (sentence-case + remove-rule-refs task)", () => {
  // Dynamically discover every source file across the watched roots.
  const files: string[] = [];
  for (const r of ROOTS) files.push(...scanSource(r));

  // Sanity: the dynamic discovery must find a non-trivial number of files.
  // If it found zero, the roots are misconfigured and the test is vacuous.
  test("dynamic discovery finds source files (scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("A: no `rule <number>` or `rule #<number>` references in source files", () => {
    const findings: string[] = [];
    for (const file of files) {
      if (basename(file) === SELF) continue;
      if (DOCS.has(basename(file))) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (RULE_NUM_RE.test(lines[i]!) || RULE_HASH_RE.test(lines[i]!) || TASK_NUM_RE.test(lines[i]!) || BUG_NUM_RE.test(lines[i]!)) {
          findings.push(`${relative(".", file)}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("B: no `AGENTS.md` references in source files", () => {
    const findings: string[] = [];
    // LIVENESS: the exemption must name a file that is actually in the walk,
    // or it is an exemption for nothing and the reason above is stale.
    for (const exempt of NAMES_THE_DOC_AS_DATA) {
      expect(
        files.map((f) => relative(".", f)),
        `${exempt} is exempted but is not in the scanned population`,
      ).toContain(exempt);
    }
    for (const file of files) {
      if (basename(file) === SELF) continue;
      if (DOCS.has(basename(file))) continue;
      if (NAMES_THE_DOC_AS_DATA.has(relative(".", file))) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (AGENTS_RE.test(lines[i]!)) {
          findings.push(`${relative(".", file)}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("C: no binding-rule / directive / round-number / workflow-phrase stragglers", () => {
    const findings: string[] = [];
    for (const file of files) {
      if (basename(file) === SELF) continue;
      if (DOCS.has(basename(file))) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (
          RULE_PAREN_RE.test(line) ||
          BINDING_RULE_RE.test(line) ||
          DIRECTIVE_NUM_RE.test(line) ||
          RULE_HYPHEN_RE.test(line) ||
          ROUND_NUM_RE.test(line) ||
          R_NUM_RE.test(line) ||
          ON_TOP_RE.test(line)
        ) {
          findings.push(`${relative(".", file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("D: discovery is dynamic (readdirSync, no hardcoded file list)", () => {
    // The walk function must discover files by reading directories, not by
    // iterating a static array. Re-walk and confirm the count is stable and
    // that a known source file is present in the discovered set.
    const rediscovered: string[] = [];
    for (const r of ROOTS) rediscovered.push(...scanSource(r));
    expect(rediscovered.length).toBe(files.length);
    // A known file must be in the set (proves the walk reaches src/lib).
    const hasKnown = rediscovered.some((f) => f.includes("src") && f.endsWith(".svelte"));
    expect(hasKnown).toBe(true);
  });

  test("E: no multi-line rule/round references (keyword on one line, number on the next)", () => {
    const findings: string[] = [];
    for (const file of files) {
      if (basename(file) === SELF) continue;
      if (DOCS.has(basename(file))) continue;
      const src = readFileSync(file, "utf8");
      if (MULTILINE_RULE_RE.test(src)) {
        const m = src.match(MULTILINE_RULE_RE);
        findings.push(`${relative(".", file)}: multi-line "rule" ref: ${m?.[0]?.replace(/\n/g, " ")}`);
      }
      if (MULTILINE_ROUND_RE.test(src)) {
        const m = src.match(MULTILINE_ROUND_RE);
        findings.push(`${relative(".", file)}: multi-line "Round" ref: ${m?.[0]?.replace(/\n/g, " ")}`);
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("F: no broken comment artifacts (//. from a stripped rule/round reference)", () => {
    const findings: string[] = [];
    for (const file of files) {
      if (basename(file) === SELF) continue;
      if (DOCS.has(basename(file))) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (BROKEN_COMMENT_RE.test(lines[i]!)) {
          findings.push(`${relative(".", file)}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
