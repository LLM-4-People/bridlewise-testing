/**
 * THE RATCHET BASELINES AND THEIR GENERATOR (a2b-design H2) — every
 * shrink-only baseline (`ratchet.ts`) is registered here WITH THE SCAN ITS
 * GUARD JUDGES, so a baseline's keys are a pure function of that scan: the
 * guard (the suite) and this generator call the same function, and no key is
 * ever typed by hand.
 *
 *   - `harness sync` (`harness regenerate`) PRUNES each baseline: an entry no
 *     finding matches (the debt fell) is removed, its reason with it. A key
 *     is NEVER added: a new site fails its guard, and a baseline that grew
 *     fails the commit guard against `HEAD`.
 *   - `harness check` reports a stale entry as drift (a second sync would
 *     change the file).
 *   - A NEW baseline is introduced once, explicitly, with the reason every
 *     entry carries (`--introduce <id> --reason <tracker id>`); it refuses a
 *     baseline that exists — growth is never an introduction.
 *
 * A baseline whose file this tree does not carry (a product-only tree has no
 * test surface) is converged by absence.
 *
 * Usage: node scripts/verification/ratchet-baselines.ts [--check|--write]
 *        node scripts/verification/ratchet-baselines.ts --introduce <id> --reason <text>
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { declaredTreeKind } from "../../src/workflow/promotion/tree-kind.ts";
import { deadMarkdownLinks } from "../../src/workflow/record-links.ts";
import { findCatchBlocks } from "./catch-blocks.ts";
import { judgeRatchet, parseRatchetBaseline, RATCHET_SCHEMA, ratchetGrowthSince, type RatchetEntry } from "./ratchet.ts";
import { readSourceView, type SourceView } from "./source-view.ts";
import { experimentExclusion, walk } from "./source-walk.ts";

/** One finding of a guard: its baseline key, and where it is (for the guard's message). */
export type RatchetFinding = Readonly<{ key: string; where: string }>;

export type RatchetBaselineSpec = Readonly<{
  id: string;
  /** The baseline document, relative to the repository top. */
  path: string;
  /** The guard's scan over the repository: the keys the baseline is judged against. */
  findings: (repositoryRoot: string) => readonly RatchetFinding[];
  /**
   * The gate belongs to the source tree's testing floor: wherever the tree is not the DECLARED product
   * projection (`declaredTreeKind`, the promotion's one owner of that classification), the baseline MUST
   * be there — a missing one is refused, and a missing instrument refuses by name; the declared product
   * does not run the gate, and says so. Never inferred from what a tree lacks.
   */
  testingFloor?: true;
}>;

// ── The engine's inline-literal defaults (engine/test/prevention/no-generic-errors.test.ts) ──

// STRUCTURAL, not a denylist: any numeric literal other than the trivial
// 0 / 1 / 2 / -1 (by VALUE, in any spelling) in a default or fallback
// position — `?? <lit>` / `|| <lit>`, `= <lit>` before `,` `)` `}`,
// `.default(<lit>)` / `.catch(<lit>)` — where a literal is any spelling a
// number takes (`_`, a fraction, an exponent, a trailing `.`, hex/binary/
// octal, a bigint `n`, a sign, parentheses). No line exemption. Matched over
// the code view, so comments and strings never count.
const NUMBER = String.raw`(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?)n?`;
const LITERAL = String.raw`\(?\s*([+-]?\s*${NUMBER})\s*\)?`;
const DEFAULT_POSITION_PATTERNS = [
  new RegExp(String.raw`(?:\?\?|\|\|)\s*${LITERAL}(?![\w.$])`, "gu"),
  new RegExp(String.raw`(?<![=!<>+\-*/%&|^?])=(?![=>])\s*${LITERAL}\s*(?=[,)}])`, "gu"),
  new RegExp(String.raw`\.(?:default|catch)\(\s*${LITERAL}\s*\)`, "gu"),
];
const TRIVIAL_VALUES: ReadonlySet<number> = new Set([0, 1, 2, -1]);

/** The literal's value, whatever its spelling (`0x2`, `2n`, `+ 2`, `2.`). */
function literalValue(literal: string): number {
  return Number(literal.replace(/[\s_+]/gu, "").replace(/n$/u, "").replace(/\.$/u, ""));
}

/** Every inline literal default in one file, as `{ line, text }` (the trimmed source line). */
export function inlineLiteralDefaults(view: SourceView): readonly Readonly<{ line: number; text: string }>[] {
  const code = view.code();
  const lines = view.codeWithStrings().split("\n");
  const found: { line: number; text: string }[] = [];
  for (const pattern of DEFAULT_POSITION_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (TRIVIAL_VALUES.has(literalValue(match[1]!))) continue;
      const line = view.lineAt(match.index);
      found.push({ line, text: lines[line - 1]!.trim() });
    }
  }
  return found;
}

/** The engine's `src/` (non-test `.ts`/`.mjs`, experiments excluded): each inline literal default as `<engine path>: <line text>`. */
function inlineLiteralDefaultFindings(repositoryRoot: string): readonly RatchetFinding[] {
  const engineRoot = join(repositoryRoot, "engine");
  const findings: RatchetFinding[] = [];
  for (const file of walk(join(engineRoot, "src"), { exts: [".ts", ".mjs"], exclude: experimentExclusion(engineRoot) })) {
    if (file.endsWith(".test.ts")) continue;
    const path = relative(engineRoot, file).replaceAll("\\", "/");
    for (const finding of inlineLiteralDefaults(readSourceView(file))) findings.push({ key: `${path}: ${finding.text}`, where: `${path}:${finding.line}` });
  }
  return findings;
}

// ── The web's unhandled catches (tests/prevention/no-empty-catch.test.ts) ──

/** `src/` and `server/`: each catch the shared classifier calls unhandled, as `<path>: <excerpt>`. */
function webUnhandledCatchFindings(repositoryRoot: string): readonly RatchetFinding[] {
  const findings: RatchetFinding[] = [];
  for (const root of ["src", "server"]) {
    for (const file of walk(join(repositoryRoot, root))) {
      const path = relative(repositoryRoot, file).replaceAll("\\", "/");
      for (const block of findCatchBlocks(readSourceView(file))) {
        if (block.verdict === "unhandled") findings.push({ key: `${path}: ${block.excerpt}`, where: `${path}:${block.line}` });
      }
    }
  }
  return findings;
}

// ── The repository's dead Markdown links (engine/test/prevention/markdown-links.test.ts) ──
// The scan is the runtime's own (src/workflow/record-links.ts): every link of
// every owned Markdown document names a file or folder of the tree, or a
// recorded evidence path (`evidence:<path>`), keyed `<document>: <target>`.

// ── The derived architecture judge (scripts/tooling/s1-verification.ts) ──
// Every module of the census is judged by its decision or its folder's
// default: its layer against its imports, its effects against what its source
// does, its sinks against the governed set. A module that takes a folder
// default which does not fit it is a NEW finding here, refused by
// `harness check` — a silent default never passes. EVERY finding kind of the
// judge is a key (none escapes through a prefix filter); the debt that
// predates the derivation is the baseline, and it only shrinks.

/**
 * The judge's instrument: S1's structural verifier, a testing-floor module the
 * promotion strips from the product, so this shipped module asks it as a
 * subprocess (`--root . --structure`) and never imports it. A tree that holds
 * this baseline but not the instrument is refused by name, never passed.
 */
const ARCHITECTURE_JUDGE_INSTRUMENT = "engine/scripts/tooling/s1-verification.ts";

/**
 * The architecture judge's baseline: a FIXED path declared here, never a policy-editable one, so no edit
 * can point the gate elsewhere. The generators' engine-only copies carry it as a declared generator input
 * (`GENERATOR_INPUTS_BEYOND_ENGINE`), so every tree that runs the judge has it.
 */
export const ARCHITECTURE_JUDGE_BASELINE = VERIFICATION_PATHS.architectureJudgeBaseline;

/** What the judge found that is not gated, shown by `harness check`: the run's evidence and the findings other generators own. */
let architectureJudgeShown: Readonly<Record<string, readonly string[]>> = {};

/** Every TREE-STRUCTURAL finding of the engine's structural judge (S1 over the census), each as its own key. */
function architectureJudgeFindings(repositoryRoot: string): readonly RatchetFinding[] {
  const instrument = join(repositoryRoot, ARCHITECTURE_JUDGE_INSTRUMENT);
  if (!existsSync(instrument)) {
    throw new InputError(`the architecture judge's instrument ${ARCHITECTURE_JUDGE_INSTRUMENT} is not in this tree`, "ratchet_instrument_absent");
  }
  const answer = spawnSync(process.execPath, [instrument, "--root", ".", "--structure"], { cwd: join(repositoryRoot, "engine"), encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes });
  if (answer.status !== 0) throw new InputError(`the architecture judge did not answer (exit ${String(answer.status)}): ${(answer.stderr ?? "").slice(0, 2000)}`, "ratchet_instrument_failed");
  const { structural, shown } = JSON.parse(answer.stdout) as { structural: readonly string[]; shown: Readonly<Record<string, readonly string[]>> };
  architectureJudgeShown = shown;
  return structural.map((violation) => ({ key: violation, where: violation.slice(violation.indexOf(":") + 1) }));
}

/** Each registered baseline's guard scan, by the id the root policy declares its path under. */
const SCANS: Readonly<Record<string, RatchetBaselineSpec["findings"]>> = Object.freeze({
  "inline-literal-defaults": inlineLiteralDefaultFindings,
  "web-unhandled-catch": webUnhandledCatchFindings,
  "dead-markdown-links": deadMarkdownLinks,
});

/** Where a source tree holds its promotion profiles (`promotion.profileDirectory` of the pinned config): a typed refusal when unconfigured. */
function configuredProfileDirectory(): string {
  const directory = loadPinnedConfigSnapshot().document.promotion?.profileDirectory;
  if (directory === undefined) throw new InputError("promotion.profileDirectory is not configured: the tree's kind cannot be read", "tree_kind_unconfigured");
  return directory;
}

/**
 * THE REGISTERED BASELINES: each path the root policy declares
 * (`verification.ratchetBaselines`, which also makes it a generated output)
 * with its guard's scan. An id with no scan, or a scan with no declared
 * path, refuses at load: a baseline nobody can regenerate is the gap this
 * module closes.
 */
export const RATCHET_BASELINES: readonly RatchetBaselineSpec[] = (() => {
  const declared = Object.entries(ROOT_POLICY.verification.ratchetBaselines);
  const unscanned = declared.filter(([id]) => SCANS[id] === undefined).map(([id]) => id);
  const undeclared = Object.keys(SCANS).filter((id) => !declared.some(([declaredId]) => declaredId === id));
  if (unscanned.length > 0 || undeclared.length > 0) {
    throw new InputError(`ratchet baselines and their scans disagree: declared without a scan [${unscanned.join(", ")}], scanned without a declared path [${undeclared.join(", ")}]`, "ratchet_baseline_registry_invalid");
  }
  return Object.freeze([
    ...declared.map(([id, path]): RatchetBaselineSpec => Object.freeze({ id, path, findings: SCANS[id]! })),
    Object.freeze({ id: "architecture-judge", path: ARCHITECTURE_JUDGE_BASELINE, findings: architectureJudgeFindings, testingFloor: true as const }),
  ]);
})();

/** The registered baseline `id`, or a typed refusal naming the ids there are. */
export function ratchetBaseline(id: string, baselines: readonly RatchetBaselineSpec[] = RATCHET_BASELINES): RatchetBaselineSpec {
  const spec = baselines.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new InputError(`No ratchet baseline "${id}" is registered (${baselines.map((candidate) => candidate.id).join(", ")})`, "ratchet_baseline_unknown");
  return spec;
}

/**
 * A NEW baseline is a tracked test-surface file: created group-readable like
 * every tracked file (`ROOT_POLICY.filesystem.rawFileModes.test`), never at
 * the atomic writer's private default (the `dead-markdown-links` baseline was
 * introduced 0600 and the git-freshness guard refused it). An existing
 * baseline keeps its own mode.
 */
const BASELINE_FILE_MODE = ROOT_POLICY.filesystem.rawFileModes.test;

/** A baseline document's text, in the one layout (two-space JSON, final newline). */
function baselineText(id: string, entries: readonly RatchetEntry[]): string {
  return `${JSON.stringify({ schema: RATCHET_SCHEMA, id, entries }, null, 2)}\n`;
}

/** `entries` without one occurrence of each key in `stale` (a multiset removal, order kept). */
function withoutStale(entries: readonly RatchetEntry[], stale: readonly string[]): readonly RatchetEntry[] {
  const remaining = new Map<string, number>();
  for (const key of stale) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  return entries.filter((entry) => {
    const left = remaining.get(entry.key) ?? 0;
    if (left === 0) return true;
    remaining.set(entry.key, left - 1);
    return false;
  });
}

export type RatchetBaselineResult = Readonly<{
  id: string;
  path: string;
  /**
   * current: nothing stale; pruned: stale entries removed (write); stale: a sync would remove them (check);
   * grown: it holds entries the base it lands on does not (the one growth judgement, by id);
   * missing: a testing-floor gate's baseline is not in a tree that is not the declared product — refused;
   * not-in-this-tree: the tree is the DECLARED product projection, which does not run testing-floor gates;
   * absent: a baseline of a gate that is not the testing floor's, which this tree does not carry.
   */
  status: "current" | "pruned" | "stale" | "grown" | "missing" | "not-in-this-tree" | "absent";
  stale: readonly string[];
  /** Findings the baseline does not hold (new debt): reported, never added — the guard fails on them. */
  unbaselined: readonly string[];
  /** Entries the baseline holds that the base it lands on does not: a ratchet only shrinks. */
  grown: readonly string[];
  /** Findings the guard reports but does not gate, by family (shown by `harness check`). */
  shown: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * Judge every registered baseline against its guard's scan; with `write`,
 * remove the stale entries (never add one). `allCurrent` is true when no
 * baseline carries a stale entry after the run.
 */
export function syncRatchetBaselines(
  repositoryRoot: string,
  write: boolean,
  baselines: readonly RatchetBaselineSpec[] = RATCHET_BASELINES,
  grownSince?: string,
): Readonly<{ allCurrent: boolean; results: readonly RatchetBaselineResult[] }> {
  const growth = grownSince === undefined ? new Map<string, readonly string[]>() : new Map(ratchetGrowthSince(repositoryRoot, grownSince).map((entry) => [entry.id, entry.grown] as const));
  const results = baselines.map((spec): RatchetBaselineResult => {
    const grown = growth.get(spec.id) ?? [];
    const empty = { stale: [], unbaselined: [], grown, shown: {} } as const;
    if (spec.testingFloor === true && declaredTreeKind(repositoryRoot, configuredProfileDirectory()) === "product") {
      return Object.freeze({ id: spec.id, path: spec.path, status: "not-in-this-tree", ...empty });
    }
    const absolute = resolve(repositoryRoot, spec.path);
    if (!existsSync(absolute)) return Object.freeze({ id: spec.id, path: spec.path, status: spec.testingFloor === true ? "missing" : "absent", ...empty });
    const baseline = parseRatchetBaseline(readFileSync(absolute, "utf8"), spec.path);
    const verdict = judgeRatchet(spec.findings(repositoryRoot).map((finding) => finding.key), baseline, undefined);
    // A baseline that does not carry its registry id (or another one) drifts like a stale entry: the id is how HEAD finds it.
    const drifted = verdict.stale.length > 0 || baseline.id !== spec.id;
    if (drifted && write) atomicWriteFile(absolute, baselineText(spec.id, withoutStale(baseline.entries, verdict.stale)), { createMode: BASELINE_FILE_MODE });
    return Object.freeze({
      id: spec.id,
      path: spec.path,
      status: grown.length > 0 ? "grown" : !drifted ? "current" : write ? "pruned" : "stale",
      stale: verdict.stale,
      unbaselined: verdict.unbaselined,
      grown,
      shown: spec.id === "architecture-judge" ? architectureJudgeShown : {},
    });
  });
  return Object.freeze({ allCurrent: results.every((result) => result.status !== "stale" && result.status !== "missing" && result.status !== "grown"), results: Object.freeze(results) });
}

/**
 * INTRODUCE a registered baseline: its guard's current findings, each with
 * `reason` (who pays the debt — a tracker id). Refused when the baseline
 * exists: a baseline is introduced once, and never grows afterwards.
 */
export function introduceRatchetBaseline(repositoryRoot: string, id: string, reason: string, baselines: readonly RatchetBaselineSpec[] = RATCHET_BASELINES): Readonly<{ id: string; path: string; entries: number }> {
  const spec = ratchetBaseline(id, baselines);
  if (reason.trim().length === 0) throw new InputError(`A baseline is introduced with the reason every entry carries (who pays the debt): --reason <tracker id>`, "ratchet_baseline_unjustified");
  const absolute = resolve(repositoryRoot, spec.path);
  if (existsSync(absolute)) throw new InputError(`${spec.path} exists: a ratchet baseline is introduced once, and only shrinks afterwards (harness sync prunes it)`, "ratchet_baseline_exists");
  const entries = spec.findings(repositoryRoot).map((finding): RatchetEntry => ({ key: finding.key, reason }));
  atomicWriteFile(absolute, baselineText(spec.id, entries), { createMode: BASELINE_FILE_MODE });
  return Object.freeze({ id: spec.id, path: spec.path, entries: entries.length });
}

function run(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { check: { type: "boolean" }, write: { type: "boolean" }, introduce: { type: "string" }, reason: { type: "string" }, "grown-since": { type: "string" } } });
  const repositoryRoot = dirname(fileURLToPath(new URL("../../", import.meta.url)));
  if (values.introduce !== undefined) {
    process.stdout.write(`${JSON.stringify(introduceRatchetBaseline(repositoryRoot, values.introduce, values.reason ?? ""))}\n`);
    return 0;
  }
  if (values.check === values.write) throw new InputError("Usage: ratchet-baselines [--check [--grown-since <ref>]|--write] | --introduce <id> --reason <text>", "input_error");
  // `--grown-since <base>`: the required check's question — a ratchet only shrinks against the base it lands on.
  const report = syncRatchetBaselines(repositoryRoot, values.write === true, RATCHET_BASELINES, values["grown-since"]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.allCurrent ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
