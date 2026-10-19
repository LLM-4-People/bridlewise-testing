/**
 * ONE QUESTION, ONE OWNER: "does this file have a SECOND NAME?"
 *
 * A hard link is a second directory entry for the same inode. It defeats every
 * containment gate that works by resolving and comparing locations, because
 * there is nothing to resolve: `realpath` on a hard link returns the hard link,
 * so a name lexically inside a root can address bytes that live outside it.
 *
 * That question was answered independently in nine places across this
 * workspace — the same two or three lines written out each time, sometimes
 * `bigint`, sometimes `number`, sometimes consulting the operator's dev-mode
 * policy and sometimes not — and the one gate a model can drive, the web UI's
 * filesystem gate, did not answer it at all. Measured before the collapse: a
 * file outside a project, a hard link to it inside, and the editor bridge
 * returned the outside file's bytes, while the SYMBOLIC-link form of the same
 * attack was refused three lines earlier in the same function.
 *
 * Adding the missing lines to the tenth place would have closed the instance.
 * This file exists so the CLASS cannot come back: the verdict has one
 * implementation (`src/filesystem/link-containment.ts`), and a tenth site that
 * writes its own is a failing test rather than a divergence nobody sees.
 *
 * Two assurance classes, and the second is the one that generalises:
 *   1. BEHAVIOURAL — the repository reader is driven against a real hard link,
 *      with a planted violation and liveness in the same run.
 *   2. SINGLE-OWNER — no file in this repository compares a link count against
 *      a literal outside the owner. Population stated as a runtime number,
 *      with a planted violation for the detector.
 */

import assert from "node:assert/strict";
import { existsSync, linkSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parse } from "@babel/parser";
import { sourceViewOf } from "../../scripts/verification/source-view.ts";

import { hasSecondName, pathHasSecondName, pathIsRefusedSecondName, refusesSecondNames } from "../../src/filesystem/link-containment.ts";
import {
  NODE_FS_REPOSITORY_READER,
  generateRepositoryMap,
} from "../../src/intelligence/repository-map.ts";
import { resolveRepositoryReadLimits } from "../../src/intelligence/repository-stat-scan.ts";
import { astNode, walkAst, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { exportedFunctionParameters, parseableRegionsOf } from "../../src/shared/source-structure.ts";
import { createTempDir, systemTempRoot } from "../support/temp-dir.ts";
import { initTreeSitterBackend } from "../../src/intelligence/tree-sitter-backend.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

await initTreeSitterBackend(["javascript", "typescript"]);

// ── 1. BEHAVIOURAL ────────────────────────────────────────────────────────

test("LinkContainment: the repository reader refuses a file that has a second name", () => {
  // THE OWNER CREATES AND REMOVES. `mkdtempSync(join(tmpdir(), …))` creates a
  // directory nobody has registered for removal, which is how 688 call sites
  // came to leak.
  const root = createTempDir("link-containment-repo-");
  const outside = createTempDir("link-containment-outside-");
  {
    // LIVENESS FIRST: an ordinary source file in the same tree is read, so the
    // refusal below is a refusal and not an outage.
    writeFileSync(join(root, "ordinary.ts"), "export const a = 1;\n");
    const clean = generateRepositoryMap(root).map;
    assert.ok(
      clean.files.some((f) => f.path === "ordinary.ts"),
      "a one-named source file must still be mapped",
    );

    // THE PLANT: a second name inside the tree for a file that lives outside it.
    const secret = join(outside, "secret.ts");
    writeFileSync(secret, "export const SECRET = 1;\n");
    const second = join(root, "innocent.ts");
    try {
      linkSync(secret, second);
    } catch {
      // A cross-device temp layout cannot host a hard link. Say so rather than
      // reporting a pass for an attack that was never attempted.
      assert.fail("this host could not create a hard link, so the refusal is untested");
    }
    // THE PLANT IS VERIFIED THROUGH THE OWNER, not through a tenth copy of the
    // comparison — this test is the one that forbids those.
    assert.ok(hasSecondName(statSync(second).nlink), "the plant must really create a second name");
    assert.equal(refusesSecondNames(), true, "the policy floor must be on for this run to mean anything");
    assert.equal(pathIsRefusedSecondName(second), true, "the shared owner must see the second name");

    // THE WALK skips it rather than mapping bytes from outside the tree…
    const mapped = generateRepositoryMap(root).map;
    assert.ok(
      !mapped.files.some((f) => f.path === "innocent.ts"),
      "a file with a second name must not enter the repository map",
    );
    // …and the READER refuses it BY NAME, with the SPECIFIC code. Driven on
    // the reader itself, because the walk skipping the file and the read
    // refusing it are two different decisions and the walk cannot prove the
    // second one.
    const limits = resolveRepositoryReadLimits(undefined);
    assert.equal(
      NODE_FS_REPOSITORY_READER.readFile(root, "ordinary.ts").content,
      "export const a = 1;\n",
      "liveness: the reader still reads a one-named file",
    );
    assert.throws(
      () => NODE_FS_REPOSITORY_READER.readFile(root, "innocent.ts"),
      (error: unknown) => (error as { code?: string }).code === "intelligence_hardlink_rejected",
      "reading it by name must be refused with intelligence_hardlink_rejected",
    );
    assert.ok(limits.maximumDepth > 0, "the limits resolver must be live for the walk above");
  }
});

test("LinkContainment: the repository reader's refusal is UNCONDITIONAL — the self-protection opt-out does not reach it", () => {
  // ── THE COLLATERAL WEAKENING THIS EXISTS TO CATCH ────────────────────────
  //
  // Consolidating the second-name question onto one owner put the harness's
  // SELF-PROTECTION policy in front of this reader, which had refused
  // unconditionally since it was written. It was the only one of ten converted
  // sites where that happened, and it appeared in neither the commit message
  // nor the report — a relaxation wearing a refactor's clothes.
  //
  // The two questions are not the same. Self-protection asks whether the
  // HARNESS's own `cp -rl`-seeded tree may be read; this reader walks somebody
  // ELSE'S repository, and the seeding of the harness says nothing about
  // whether a file in a user's project also lives outside it. So the opt-out is
  // SET here and the refusal is driven through it.
  const saved = process.env["HARNESS_REJECT_HARDLINKS"];
  const root = createTempDir("link-containment-unconditional-");
  const outside = createTempDir("link-containment-unconditional-outside-");
  writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
  writeFileSync(join(root, "ordinary.ts"), "export const a = 1;\n");
  linkSync(join(outside, "secret.ts"), join(root, "innocent.ts"));
  try {
    process.env["HARNESS_REJECT_HARDLINKS"] = "0";
    assert.equal(refusesSecondNames(), false, "the opt-out must really be in force for this to mean anything");
    // LIVENESS FIRST: a one-named source file is still read and still mapped,
    // so the refusals below are refusals and not an outage.
    assert.equal(
      NODE_FS_REPOSITORY_READER.readFile(root, "ordinary.ts").content,
      "export const a = 1;\n",
    );
    const mapped = generateRepositoryMap(root).map;
    assert.ok(mapped.files.some((f) => f.path === "ordinary.ts"), "a one-named file must still be mapped");
    // THE CONCLUSION, on both doors, with the SPECIFIC code.
    assert.ok(
      !mapped.files.some((f) => f.path === "innocent.ts"),
      "the walk must skip a second-named file even with the self-protection opt-out set",
    );
    assert.throws(
      () => NODE_FS_REPOSITORY_READER.readFile(root, "innocent.ts"),
      (error: unknown) => (error as { code?: string }).code === "intelligence_hardlink_rejected",
      "the read must be refused even with the self-protection opt-out set",
    );
  } finally {
    // RESTORE BEFORE ANYTHING ELSE RUNS: a test that mutates shared state to
    // prove a refusal must put it back, or the next probe measures a workspace
    // this test broke.
    if (saved === undefined) delete process.env["HARNESS_REJECT_HARDLINKS"];
    else process.env["HARNESS_REJECT_HARDLINKS"] = saved;
  }
  assert.equal(process.env["HARNESS_REJECT_HARDLINKS"], saved, "the shared environment must be restored");
});

test("LinkContainment: the owner separates the FACT from the POLICY", () => {
  // The fact is width-agnostic, because `lstatSync` returns `number` and
  // `lstatSync(…, { bigint: true })` returns `bigint`, and `stats.nlink !== 1n`
  // against a `number` is ALWAYS true — a silent always-refuse that reads
  // exactly like the correct check.
  assert.equal(hasSecondName(1n), false);
  assert.equal(hasSecondName(2n), true);
  assert.equal(hasSecondName(1), false);
  assert.equal(hasSecondName(2), true);
  // A path that does not exist has no second name, so a write to a new file is
  // gated rather than refused.
  assert.equal(pathIsRefusedSecondName(join(systemTempRoot(), "link-containment-absent-xyz")), false);
  // A directory always has two or more names; the count says nothing, so the
  // owner must not answer "yes" for one.
  assert.equal(pathIsRefusedSecondName(systemTempRoot()), false);

  // ── AND THE FACT DOOR ANSWERS THE SAME WAY WITH THE POLICY OFF ──────────
  //
  // Containment asks `pathHasSecondName`, which has no policy in it, because
  // one environment variable answering both self-protection AND tenant
  // containment is one owner for two questions.
  const saved = process.env["HARNESS_REJECT_HARDLINKS"];
  const root = createTempDir("link-containment-fact-");
  const outside = createTempDir("link-containment-fact-outside-");
  writeFileSync(join(outside, "secret.txt"), "s\n");
  const plain = join(root, "plain.txt");
  writeFileSync(plain, "p\n");
  const second = join(root, "second.txt");
  linkSync(join(outside, "secret.txt"), second);
  try {
    process.env["HARNESS_REJECT_HARDLINKS"] = "0";
    assert.equal(refusesSecondNames(), false, "the opt-out must really be in force");
    assert.equal(pathIsRefusedSecondName(second), false, "the POLICY door admits it, which is the policy working");
    assert.equal(pathHasSecondName(second), true, "the FACT door is not reachable by the policy switch");
    assert.equal(pathHasSecondName(plain), false, "liveness: a one-named file is not a second name");
    assert.equal(pathHasSecondName(join(root, "absent.txt")), false, "a file that does not exist has no second name");
    assert.equal(pathHasSecondName(root), false, "a directory's link count says nothing");
  } finally {
    if (saved === undefined) delete process.env["HARNESS_REJECT_HARDLINKS"];
    else process.env["HARNESS_REJECT_HARDLINKS"] = saved;
  }
  assert.equal(process.env["HARNESS_REJECT_HARDLINKS"], saved, "the shared environment must be restored");
});

// ── 2. SINGLE-OWNER ───────────────────────────────────────────────────────

/**
 * The owner module, named once. A test that hard-codes the same path twice is
 * a test that can be half-updated.
 */
const OWNER = join("src", "filesystem", "link-containment.ts");

/**
 * A link-count VERDICT, decided from the SHAPE OF THE CODE rather than from the
 * spelling of one operand.
 *
 * ── WHY THE PREVIOUS DETECTOR WAS NOT ENOUGH ─────────────────────────────
 *
 * It required a NUMERIC LITERAL next to `nlink`, for a good reason — recording
 * a count (`links: stats.nlink`) and comparing two of them
 * (`left.nlink === right.nlink`) are different questions, and flagging those
 * would make the guard something people route around. But the consequence was
 * that hoisting the literal into a constant defeated it, and hoisting a literal
 * is the first thing anybody does. Four mutations escaped, all measured:
 *
 *     const ONE_NAME = 1n; if (st.nlink > ONE_NAME) throw …   ESCAPED
 *     if (st.nlink - 1n > 0n) throw …                          ESCAPED
 *     if (st.nlink.toString(10) !== "1") throw …               ESCAPED
 *     if (Boolean(st.nlink >> 1)) throw …                      ESCAPED
 *
 * So the question is asked structurally instead: is a link count USED AS A
 * DECISION here — inside a comparison, a logical operator, a negation, or the
 * test of an `if`/`while`/ternary — without going through the owner? None of
 * the four can escape that, because all four ARE decisions, and neither of the
 * two honest shapes is one.
 *
 * TWO EXEMPTIONS, both structural rather than named:
 *   - a comparison of one link count to ANOTHER link count is a different
 *     question ("are these the same file"), and the whole comparison is exempt;
 *   - a link count handed to one of the OWNER'S OWN EXPORTS is the owner
 *     answering. Those names are DISCOVERED from the owner's source, so adding
 *     an export to the owner does not require an edit here.
 *
 * WHAT IT STILL CANNOT SEE, stated rather than left to be discovered: a
 * comparison expressed through an assertion library —
 * `expect(statSync(p).nlink).toBeGreaterThan(1)` — is a call to a method whose
 * meaning lives in the library, and nothing structural distinguishes it from
 * any other method call. The two sites in the web repository that were written
 * that way were converted to `hasSecondName`; a third would be invisible here.
 */
const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">="]);

/** Value forms that make a comparison a POLICY rather than a re-measurement. */
const LITERAL_TYPES = new Set(["NumericLiteral", "BigIntLiteral", "StringLiteral"]);

/** The owner's exported answers, read from the owner rather than listed. */
function ownerAnswers(): ReadonlySet<string> {
  return new Set(exportedFunctionParameters(readFileSync(OWNER, "utf8"), OWNER).keys());
}

type Span = readonly [number, number];

function spanOf(node: AstNode): Span {
  return [typeof node.start === "number" ? node.start : -1, typeof node.end === "number" ? node.end : -1];
}

function within(inner: Span, outer: Span): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

/**
 * Every place in `source` where a link count is used as a decision without the
 * owner deciding it. Offsets, so a caller can name the line.
 */
function linkCountVerdicts(source: string, owners: ReadonlySet<string>): readonly number[] {
  const found: number[] = [];
  // A COMPONENT IS NOT TYPESCRIPT, and its script blocks are. The region split
  // is the shared owner's, so this guard and the structural matchers agree
  // about what part of a `.svelte` file is code.
  for (const region of parseableRegionsOf(source, "link-count verdicts")) {
    found.push(...verdictsInRegion(region.text, owners).map((at) => at + region.offset));
  }
  return found;
}

function verdictsInRegion(source: string, owners: ReadonlySet<string>): readonly number[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"], attachComment: false }) as unknown as AstNode;

  // 1. Where the OWNER is answering — a link count inside one of these is not a
  //    second answer, it is the first one being consulted.
  const delegated: Span[] = [];
  // 2. Which identifiers name a constant, so `> ONE_NAME` is seen for what it
  //    is. Hoisting a literal into a name is the first thing anybody does, and
  //    it is what defeated the previous detector.
  const constants = new Set<string>();
  walkAst(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = astNode(node.callee);
      if (callee?.type === "Identifier" && typeof callee.name === "string" && owners.has(callee.name)) {
        delegated.push(spanOf(node));
      }
      return;
    }
    if (node.type !== "VariableDeclarator") return;
    const id = astNode(node.id);
    const init = astNode(node.init);
    if (id?.type !== "Identifier" || typeof id.name !== "string" || init === undefined) return;
    const value = init.type === "UnaryExpression" ? astNode(init.argument) : init;
    if (value !== undefined && LITERAL_TYPES.has(value.type)) constants.add(id.name);
  });

  const isConstantValue = (node: AstNode | undefined): boolean => {
    if (node === undefined) return false;
    const value = node.type === "UnaryExpression" ? astNode(node.argument) ?? node : node;
    if (LITERAL_TYPES.has(value.type)) return true;
    return value.type === "Identifier" && typeof value.name === "string" && constants.has(value.name);
  };

  // 3. Every link-count reference. A comment or a string cannot contain one,
  //    because this is the parsed program rather than its text — which is what
  //    the previous version needed a stateful comment stripper for.
  const references: Span[] = [];
  walkAst(ast, (node) => {
    if (node.type === "Identifier" && node.name === "nlink") references.push(spanOf(node));
  });
  const isDelegated = (ref: Span): boolean => delegated.some((call) => within(ref, call));

  const decisions: Span[] = [];
  const exempt: Span[] = [];
  const collect = (linkCounts: readonly Span[]): void => {
    decisions.length = 0;
    exempt.length = 0;
    const mentions = (span: Span): boolean => linkCounts.some((ref) => within(ref, span));
    walkAst(ast, (node) => {
      if (node.type === "BinaryExpression" && typeof node.operator === "string" && COMPARISONS.has(node.operator)) {
        const left = astNode(node.left);
        const right = astNode(node.right);
        const other = mentions(spanOf(left ?? node)) ? right : left;
        // ── THE TWO EQUALITY QUESTIONS ARE NOT THE SAME QUESTION ─────────
        //
        // An EQUALITY against a recorded observation ("the file I measured must
        // still have the link count I wrote down", `stats.nlink === binding.links`)
        // asks whether something CHANGED. An equality against a CONSTANT
        // ("`nlink !== 1n`") decides how many names a file is allowed to have,
        // and that decision has one owner. An ORDERING comparison is always the
        // second kind: there is no reason to ask whether one observation is
        // greater than another.
        //
        // Both live in this tree — `preflight.ts` and `immutable-receipt.ts`
        // compare against a recorded count — and flagging them would make the
        // guard noise people route around, which is how a guard stops working.
        if ((node.operator === "===" || node.operator === "!==" || node.operator === "==" || node.operator === "!=")
          && !isConstantValue(other)) {
          exempt.push(spanOf(node));
          return;
        }
        decisions.push(spanOf(node));
        return;
      }
      if (node.type === "LogicalExpression") { decisions.push(spanOf(node)); return; }
      if (node.type === "UnaryExpression" && node.operator === "!") { decisions.push(spanOf(node)); return; }
      const test = astNode(node["test"]);
      if (test !== undefined) decisions.push(spanOf(test));
    });
  };

  const direct = references.filter((ref) => !isDelegated(ref));
  collect(direct);

  // 4. ONE HOP OF PROPAGATION. `const n = Number(st.nlink); if (n !== 1)` moves
  //    the decision off the property and onto a copy, and a detector that only
  //    looks at the property sees nothing. One hop is deliberate rather than
  //    lazy: it covers the shape a developer actually writes, and a full
  //    data-flow analysis in a guard would be a second compiler. A copy of a
  //    copy is NOT covered, and that is stated rather than left to be found.
  const copies: Span[] = [];
  walkAst(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = astNode(node.id);
    const init = astNode(node.init);
    if (id?.type !== "Identifier" || typeof id.name !== "string" || init === undefined) return;
    const initSpan = spanOf(init);
    const carries = direct.some((ref) => within(ref, initSpan) && !exempt.some((allowed) => within(ref, allowed)));
    if (!carries) return;
    const copied = id.name;
    walkAst(ast, (use) => {
      if (use.type === "Identifier" && use.name === copied) copies.push(spanOf(use));
    });
  });

  const linkCounts = [...direct, ...copies];
  collect(linkCounts);

  return linkCounts
    .filter((ref) => decisions.some((decision) => within(ref, decision)))
    .filter((ref) => !exempt.some((allowed) => within(ref, allowed)))
    .map((ref) => ref[0])
    .sort((a, b) => a - b)
    .filter((offset, index, all) => index === 0 || all[index - 1] !== offset);
}

/**
 * THE UNIVERSE IS BOTH REPOSITORIES, because the defect lived in the other one.
 *
 * The previous walk was `["src", "scripts", "test"]` relative to this package —
 * and `web/server/fs-gate.ts`, the one gate that had no link-count check at all,
 * was not in it. A single-owner guard whose universe excludes the repository
 * where the second owner appeared is a guard that cannot fail for the reason it
 * exists. §0's recorded history is three rounds of subprocess confinement
 * failing for exactly this.
 */
// After the monorepo assembly the web tree is the ENCLOSING root, not a
// sibling, and it is named by its subdirectories below rather than by a
// repository name — a bare root would swallow this package and scan it twice.
const WEB_REPOSITORY = join(process.cwd(), "..");

const SCANNED_ROOTS: readonly string[] = [
  join("src"), join("scripts"), join("test"),
  join(WEB_REPOSITORY, "src"), join(WEB_REPOSITORY, "server"),
  join(WEB_REPOSITORY, "shared"), join(WEB_REPOSITORY, "tests"),
];

/** Format only outside-owner verdicts, using one position index per input. */
function linkCountDiagnosticRows(source: string, file: string, verdicts: readonly number[]): readonly string[] {
  if (file === OWNER || verdicts.length === 0) return [];
  const view = sourceViewOf(source, file);
  return verdicts.map((offset) => {
    const start = offset === 0 ? 0 : source.lastIndexOf("\n", offset - 1) + 1;
    const next = source.indexOf("\n", offset);
    return `${file}:${view.lineAt(offset)}  ${source.slice(start, next === -1 ? source.length : next).trim().slice(0, 100)}`;
  });
}

/** Every first-party source file in BOTH repositories. */
function firstPartySources(): string[] {
  return SCANNED_ROOTS.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".svelte"] }));
}

test("LinkContainment: only the owner decides how many names a file may have", () => {
  // A SCAN ROOT THAT DOES NOT EXIST IS NOT AN EMPTY ONE. The sibling repository
  // is required rather than probed: a guard that quietly halves its universe
  // when a directory is missing reports a clean tree for the wrong reason, and
  // that is the failure this whole file is about. A genuinely backend-only
  // checkout must remove the root deliberately, and see this line when it does.
  for (const root of SCANNED_ROOTS) {
    assert.ok(existsSync(root), `scan root ${root} is missing — a missing root is not an empty one`);
  }
  const files = firstPartySources();
  const owners = ownerAnswers();
  assert.ok(
    owners.size >= 3,
    `owner exports discovered from ${OWNER}: ${owners.size} — a collapse would exempt every call site`,
  );

  // POPULATION AS A RUNTIME NUMBER, per repository, so a walk that reached only
  // the nearer tree fails here rather than reporting the other one clean.
  const web = files.filter((f) => f.startsWith(WEB_REPOSITORY)).length;
  assert.ok(
    files.length >= 1900 && web >= 700,
    `first-party sources scanned for a link-count verdict: ${files.length} total, ${web} in the web repository`,
  );

  const offenders: string[] = [];
  let ownerSeen = 0;
  let mentioningFiles = 0;
  for (const file of files) {
    // BYTES, NEVER `grep`: eight first-party files here contain a legitimate
    // NUL, and GNU grep treats such a file as binary and prints nothing while
    // exiting cleanly — a silently smaller universe.
    const source = readFileSync(file, "utf8");
    // Only a file that mentions a link count can hold a verdict about one, and
    // parsing the other 1,900 would cost seconds for nothing.
    // `\bnlink\b`, not `includes("nlink")`: `unlink` is not a link count, and a
    // component that merely calls it would otherwise have to parse.
    if (!/\bnlink\b/.test(source)) continue;
    mentioningFiles += 1;
    let verdicts: readonly number[];
    try {
      verdicts = linkCountVerdicts(source, owners);
    } catch (error) {
      // A FILE THAT MENTIONS A LINK COUNT AND CANNOT BE PARSED IS A HOLE IN THE
      // UNIVERSE, not a file to skip. Skipping it is how a scan reports clean.
      throw new Error(`${file} mentions a link count and could not be parsed: ${String(error)}`);
    }
    if (file === OWNER) { ownerSeen += verdicts.length; continue; }
    offenders.push(...linkCountDiagnosticRows(source, file, verdicts));
  }

  assert.ok(
    mentioningFiles >= 20,
    `files mentioning a link count across both repositories: ${mentioningFiles} — a collapse would make this vacuous`,
  );
  // LIVENESS FOR THE DETECTOR ON REAL SOURCE: the owner really does contain the
  // verdict, so a detector that has stopped matching anything fails here rather
  // than reporting every other file clean.
  assert.ok(
    ownerSeen > 0,
    `${OWNER} must contain the link-count verdict — the detector found ${ownerSeen} in it, so it is not looking at code`,
  );

  assert.deepEqual(
    offenders,
    [],
    `a link-count verdict outside ${OWNER} is a second answer to a question that has one owner ` +
      `(use hasSecondName / pathHasSecondName / pathIsRefusedSecondName):\n${offenders.join("\n")}`,
  );
});

test("LinkContainment: the single-owner detector catches a verdict it has never seen", () => {
  const owners = ownerAnswers();
  for (const ending of ["\n", "\r\n"]) {
    const source = [`// 😀\0 diagnostic witness`, "if (st.nlink > 1) drop();", "if (stat.nlink !== 1n) refuse();", ""].join(ending);
    const offsets = linkCountVerdicts(source, owners);
    const originalSplit = String.prototype.split;
    let lineArrays = 0;
    let diagnostics: readonly string[];
    try {
      String.prototype.split = new Proxy(originalSplit, {
        apply(target, receiver, args) {
          if (args[0] === "\n" && typeof receiver === "string" && source.startsWith(receiver)) lineArrays += 1;
          return Reflect.apply(target, receiver, args);
        },
      });
      diagnostics = linkCountDiagnosticRows(source, "witness.ts", offsets);
      assert.deepEqual(linkCountDiagnosticRows(source, OWNER, offsets), []);
      assert.deepEqual(linkCountDiagnosticRows("", "empty.ts", []), []);
    } finally { String.prototype.split = originalSplit; }
    assert.deepEqual(diagnostics, ["witness.ts:2  if (st.nlink > 1) drop();", "witness.ts:3  if (stat.nlink !== 1n) refuse();"]);
    assert.equal(lineArrays, 0, "useful diagnostic rows never allocate prefix/full-source line arrays");
  }
  const flags = (code: string): boolean => linkCountVerdicts(code, owners).length > 0;

  // PLANTED VIOLATIONS. The first four are the shapes the LITERAL-based
  // detector let through, each measured escaping it; the rest are shapes not in
  // either tree. The point is the class, not the instances.
  for (const planted of [
    "const ONE_NAME = 1n;\nfunction f(st: Stats) { if (st.nlink > ONE_NAME) throw new Error('no'); }",
    "function f(st: Stats) { if (st.nlink - 1n > 0n) throw new Error('no'); }",
    "function f(st: Stats) { if (st.nlink.toString(10) !== '1') throw new Error('no'); }",
    "function f(st: Stats) { if (Boolean(st.nlink >> 1)) throw new Error('no'); }",
    "function f(stats: Stats) { if (stats.nlink !== 1n) throw new Error('no'); }",
    "function f(info: Stats) { if (info.nlink > 1) return false; return true; }",
    "function f(entry: Stats) { const ok = 1 === entry.nlink; return ok; }",
    "function f(st: Stats) { if (st.nlink >= 2) skip(); }",
    "function f(st: Stats) { while (st.nlink > 1) { retry(); } }",
    "function f(st: Stats) { return st.nlink === 1 ? keep() : drop(); }",
    "const LIMIT = 1;\nfunction f(st: Stats) { return !(st.nlink <= LIMIT); }",
    "function f(st: Stats) { return st.nlink > 1 && st.isFile(); }",
    "function f(st: Stats) { const n = Number(st.nlink); if (n !== 1) throw new Error('no'); }",
  ]) {
    assert.ok(flags(planted), `the detector must recognise: ${planted.replace(/\n/g, " ")}`);
  }

  // CLEAN CONTROLS. Recording a link count, comparing two of them, and asking
  // the owner are different questions and must not be flagged, or the guard
  // becomes noise people route around.
  for (const clean of [
    "const record = { links: stats.nlink.toString(10) };",
    "function f(left: Stats, right: Stats) { return left.nlink === right.nlink && left.ino === right.ino; }",
    "function f(stats: Stats) { return hasSecondName(stats.nlink); }",
    "function f(stats: Stats) { if (hasSecondName(stats.nlink)) throw new Error('no'); }",
    "function f(stats: Stats) { if (!hasSecondName(stats.nlink)) return; }",
    "function f(i: Stats, uid: bigint) { return i.uid === uid && !hasSecondName(i.nlink) && i.dev === 1n; }",
    "// a tree seeded with cp -rl has nlink=2 and that is fine\nconst x = 1;",
    "const message = 'no file may have nlink > 1';",
    "/**\n * refuses when stats.nlink !== 1n\n */\nconst x = 1;",
  ]) {
    assert.ok(!flags(clean), `the detector must not flag: ${clean.replace(/\n/g, " ")}`);
  }

  // THE COMMENT AND STRING CASES ARE NOT A STRIPPER'S JOB ANY MORE. The
  // previous detector needed a stateful block-comment scanner because it read
  // raw text, and two of its own failure messages were reported as violations
  // before that scanner existed. A parser has no such problem: prose is not a
  // program. Asserted rather than assumed, because it is the reason the
  // stripper could be deleted.
  assert.equal(linkCountVerdicts("/**\n * if (st.nlink !== 1n) throw\n */\nconst x = 1;\n", owners).length, 0);
  assert.equal(linkCountVerdicts('const m = "if (st.nlink !== 1n) throw";\n', owners).length, 0);

  // …AND A COMPONENT'S SCRIPT BLOCK IS IN THE UNIVERSE, which the extension
  // filter alone would not tell you.
  assert.equal(
    linkCountVerdicts("<script lang=\"ts\">\n  function f(st: Stats) { if (st.nlink > 1) drop(); }\n</script>\n<div />\n", owners).length,
    1,
    "a verdict inside a component's script block must be found",
  );
});
