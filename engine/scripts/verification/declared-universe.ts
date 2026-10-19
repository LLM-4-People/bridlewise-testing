/**
 * DECLARED UNIVERSES — a vocabulary written by hand is a vocabulary that can
 * lose a member without anyone being told.
 *
 * ── THE CLASS THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * A finite union and a list of its members, written separately:
 *
 *   type MemorySource = "tool" | "conversation" | "llm" | "user";
 *   const MEMORY_SOURCES: readonly MemorySource[] = ["tool", "conversation", "llm", "user"];
 *
 * reads as one vocabulary and is two declarations, and the compiler cannot
 * join them: an array holding FEWER members is perfectly assignable to
 * `readonly T[]`. So adding a fifth member to the union and forgetting the
 * array typechecks — exit 0, zero errors — while every consumer built from
 * the array silently answers for four. Driven on this tree before the fix:
 * the server's memory validation set and the `/api/memory` `sources` field
 * are both built from that array, so the fifth source would have been
 * REJECTED at the boundary and ABSENT from the API, with nothing red.
 *
 * The same shape was found in a guard whose own comment said it was "DYNAMIC
 * over the level list, so a level added tomorrow cannot quietly omit
 * identity", and in a test titled "all ErrorKind values are present" — both
 * hand-written lists, both able to certify a proper subset of their subject.
 *
 * ── WHAT THE FIX IS, AND WHY THIS FILE IS STILL NEEDED AFTER IT ───────────
 *
 * The fix is to INVERT the ownership — `const X = [...] as const` with
 * `type T = typeof X[number]`, or `Object.keys(record)` over a
 * `Record<T, …>` the compiler forces to be complete. Then a member outside
 * the list is not merely discouraged, it is UNREPRESENTABLE: there is no
 * second declaration to add it to.
 *
 * That fixes the instances. It does not stop the next one being written, and
 * the next one is invisible exactly the way these were. This file is the
 * rule, so that a hand-written vocabulary is refused at the point it appears
 * rather than found by the next sweep.
 *
 * ── DENY BY DEFAULT, WITH THE EXCEPTION MADE TO SAY WHY ───────────────────
 *
 * Some annotated lists are deliberately PARTIAL — a warm-up order that names
 * two of seven rooms on purpose, a `DEFAULT_*` set that is an opinion rather
 * than a census. Those are decisions, not defects, and the difference is not
 * mechanically visible: both spellings are identical bytes. So the exception
 * must be DECLARED, and it must carry its reason, because an exemption with
 * no evidence is a claim about the world that nothing ever re-checks.
 * `DELIBERATE_SUBSET_MARKER` in the declaration's own comment, followed by a
 * reason, is that declaration.
 *
 * DEPENDENCY-FREE ON PURPOSE: node built-ins only, like its neighbour
 * `pattern-liveness.ts`. It is imported from both repositories' test suites.
 *
 * COUNTS COME FROM BYTES, NEVER FROM `grep`: a source file containing a NUL
 * byte is binary to GNU grep, which then prints nothing and exits cleanly —
 * a silently smaller universe. Everything here reads the file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sourceViewOf } from "./source-view.ts";

/**
 * The marker that turns a refusal into a recorded decision. It must be
 * followed by a reason; a bare marker is rejected exactly like no marker,
 * because "this is fine" is the claim, not the evidence for it.
 */
export const DELIBERATE_SUBSET_MARKER = "DELIBERATE SUBSET:";

/** The primitive element types that cannot be a finite vocabulary. */
const PRIMITIVE_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "boolean", "unknown", "any", "object",
  "symbol", "bigint", "never", "null", "undefined",
]);

/**
 * One annotated string-literal list found in source.
 *
 * `members` is the OUTPUT of reading the declaration, never a restatement of
 * the pattern that found it — a guard that reports its own input certifies
 * nothing about the file.
 */
export type DeclaredUniverse = Readonly<{
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly elementType: string;
  readonly members: readonly string[];
  /** The stated reason, when the declaration carries a WELL-FORMED marker. */
  readonly deliberateSubsetReason: string | null;
  /**
   * Why a marker that IS present was not accepted — a malformed exemption is
   * louder than a missing one, because someone tried and the attempt does not
   * hold. `null` when there is no marker at all, or when it is well formed.
   */
  readonly malformedSubsetReason: string | null;
  /**
   * True when the identifier is appended to later in the same file.
   *
   * INFORMATION FOR THE MESSAGE, NOT AN EXEMPTION. It was an exemption, and it
   * was computed by testing `\bNAME\.push\s*\(` against RAW BYTES — so a
   * `LANES.push(` written only inside a comment, or only inside a string,
   * silenced the guard entirely. Both were driven. An accumulator now declares
   * itself with the marker like everything else; that is one mechanism instead
   * of two, and the one that remains is checked.
   */
  readonly appendedTo: boolean;
}>;

/**
 * The declaration shape, ANCHORED AT THE START OF A LINE.
 *
 * The anchor was, originally, the ONLY thing keeping this file from reporting
 * itself: a scanner whose universe comes from source text scans its own
 * comments, the paragraphs above contain the exact declaration this matches,
 * and a comment line begins with `*` or `/`, never with `const`. It is kept —
 * the scan now runs over a view with comment and template interiors blanked,
 * which is a stronger answer to the same question, and two answers that cannot
 * disagree cost nothing. The annotation shapes below CANNOT be anchored (they
 * occur mid-expression), so the view is what protects them, and that is
 * exactly why they came after it.
 */
const ANNOTATED_LIST =
  /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*:[ \t]*(?:readonly[ \t]+([A-Za-z_$][\w$]*)[ \t]*\[\]|ReadonlyArray[ \t]*<[ \t]*([A-Za-z_$][\w$]*)[ \t]*>|([A-Za-z_$][\w$]*)[ \t]*\[\])[ \t]*=/gm;

/**
 * THE SAME CLAIM, IN THE OTHER PLACES TYPESCRIPT LETS YOU WRITE IT.
 *
 * ── WHY THIS WIDENING IS NOT A LIST OF BLESSED SPELLINGS ──────────────────
 *
 * The rule above reads ONE piece of evidence: a literal list of strings whose
 * ELEMENT TYPE IS NAMED. Naming the type is the claim — it says "these are the
 * T's" — and the compiler cannot check it, because a list holding fewer
 * members is assignable to `readonly T[]`.
 *
 * That evidence was only ever recognised in ONE syntactic position, the
 * variable annotation. TypeScript offers three more, and they carry exactly
 * the same claim with exactly the same hole under it:
 *
 *   a constructor type argument  `new Set<Tool>([ … ])`
 *   a type assertion             `[ … ] as Tool[]`
 *   a `satisfies` clause         `[ … ] satisfies readonly Tool[]`
 *
 * So the widening is derived from the rule's own evidence rather than from a
 * survey of how people happen to write sets today. A fifth container spelling
 * — a `Map`, a class nobody has written yet, some helper taking a list — is
 * covered the moment it names its element type, because the pattern keys on
 * the TYPE ARGUMENT and not on the callee.
 *
 * ── THE HEADLINE INSTANCE, DRIVEN ─────────────────────────────────────────
 *
 * `server/harness-config.ts` held a complete copy of an eleven-member union
 * inside a constructor type argument. Adding a twelfth member to the union and
 * leaving the copy alone gave `tsc -p tsconfig.server.json` exit 0, `tsc -p
 * tsconfig.json` exit 0, this scanner `offenders=0`, and four suites 70/70 —
 * while a config naming the new kind failed the set's membership test and fell
 * through to the catch-all default. Accepted upstream, silently dropped there.
 *
 * ── WHAT THIS STILL CANNOT SEE, STATED ────────────────────────────────────
 *
 * An UNANNOTATED list that restates a union — `["forward", "reverse"]` inside
 * a bare `new Set(…)`, a `for … of [ … ]`, a `![ … ].includes(x)` — carries no
 * type at all, so nothing here can tell it from an ordinary array of strings.
 * Catching those needs a different instrument: cross-check every string list
 * against every declared union's member set.
 *
 * ── A FIGURE THAT WAS HERE, AND WHY IT IS GONE ────────────────────────────
 *
 * This paragraph used to say that instrument "was built and driven while this
 * one was written" and reported a specific number of sites over a specific
 * number of files. THE INSTRUMENT IS NOT IN THIS TREE. Two independent sweeps
 * of both repositories found no such scanner, so nobody can re-derive the
 * figure, and a later reader's own instrument — a different one, answering a
 * slightly different question — produced a materially different count. The
 * number carried its unit and carried no command and no exit code, which is
 * exactly the shape that lets a wrong count survive for months.
 *
 * So the number is WITHDRAWN rather than corrected. A corrected figure with no
 * committed instrument behind it would have the same defect and one more layer
 * of confidence. What remains is the CLASS, which is true without arithmetic:
 * an unannotated list that restates a union is invisible to this scanner, such
 * lists exist in this tree, and closing them is a migration recorded as its own
 * work rather than shipped here as hand-written exemptions — which is the
 * allowlist this whole file exists to argue against.
 *
 * WHOEVER BUILDS THAT INSTRUMENT: commit it beside this file and replace this
 * paragraph with a pointer to the receipt its own run prints. A count in prose
 * goes stale silently; a receipt cannot, because it is regenerated by the run
 * that claims it. And note the shape the argument has already settled: an
 * EQUALITY rule is red in the correct state and green in the drifted one, so
 * the instrument must ask about proper SUBSETS.
 */
const TYPE_ARGUMENT_LIST =
  /\bnew[ \t]+[A-Za-z_$][\w$.]*[ \t]*<[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*(?:\[[ \t]*\][ \t]*)?>[ \t]*\([ \t]*(\[)/g;

/** `[ … ] as T[]` / `[ … ] as readonly T[]` — the assertion says the same thing. */
const AS_ASSERTED_LIST = /(\])[ \t]*as[ \t]+(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\[[ \t]*\]/g;

/** `[ … ] satisfies readonly T[]` — likewise. */
const SATISFIES_LIST = /(\])[ \t]*satisfies[ \t]+(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\[[ \t]*\]/g;

/**
 * The `const NAME =` this expression initialises, when there is one.
 *
 * Reporting needs a name an operator can search for. A bare positional label
 * ("the list at line 244") is a location, and a location is exactly what moves
 * when someone edits the file above it.
 */
const ENCLOSING_CONST = /(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[^=;]*=[^=;]*$/;

/** A list body that is nothing but string literals — i.e. a vocabulary. */
const ONLY_STRING_LITERALS = /^\s*(?:(?:"[^"\\]*"|'[^'\\]*')\s*,?\s*)+$/;

/**
 * The initializer, which must BE a list — optionally inside freezing wrappers.
 *
 * The first draft took "the next `[` within 200 characters" as the list, and
 * on the first real run that grabbed the bracket of an INDEXED ACCESS TYPE:
 * `const edges: TimelineEdgeRecord[] = rows.map(e => ({ … edgeType: x as
 * TimelineEdgeRecord["edgeType"] … }))` was reported as a four-member
 * vocabulary whose sole member was `edgeType`. The declaration is a mapped
 * database read; nothing about it is a vocabulary.
 *
 * That is the same defect three separate helpers on this project have already
 * produced — taking the next bracket or brace after a name as the construct
 * it belongs to, and then reporting confidently about two bytes. Bracket
 * hunting is not parsing. So the bracket must be the initializer's FIRST
 * token, after at most a few `identifier(` wrappers (`deepFreeze([…])`,
 * `Object.freeze([…])`), and anything else is not a literal list at all.
 */
const LIST_INITIALIZER = /^[ \t]*(?:[A-Za-z_$][\w$.]*[ \t]*\([ \t]*){0,3}\[/;

/** How far past the `=` a newline-tolerant initializer may start. */
const INITIALIZER_SEARCH_CHARS = 200;

/**
 * Every annotated string-literal vocabulary in one file's BYTES.
 *
 * The initializer is deliberately not pinned to `= [`: the same defect is
 * written `= deepFreeze([...])` and `= Object.freeze([...])`, and a matcher
 * that required a bare bracket missed six real instances on this tree — the
 * silently smaller universe, in the instrument built to find silently smaller
 * universes.
 */
export function findDeclaredUniverses(source: string, file: string): readonly DeclaredUniverse[] {
  // THE VIEW IS THE UNIVERSE, AND IT IS CHOSEN HERE RATHER THAN DEFAULTED.
  //
  // Comments blanked: this file's own prose spells out the declaration it
  // refuses, and so does its test's. Template interiors blanked: a test tree
  // holds source-as-DATA, and a fixture quoting a declaration is not that
  // declaration — driven on the sibling tier guard, where a template literal
  // holding three tiers was compared against the owner and agreed while the
  // real declaration beneath it held two. Quoted-string interiors KEPT,
  // because the members ARE quoted string literals and a string-blanking view
  // would return an empty vocabulary from every file and pass on `[] === []`.
  //
  // Every view the reader hands back preserves offsets, so an index into it is
  // an index into the file: `lineAt` reports the line a reader will open, and
  // `declaredSubsetVerdict` below can go back to the ORIGINAL bytes at the
  // same index to read the comment block it needs.
  const view = sourceViewOf(source, file);
  const code = view.codeWithStrings();
  const found: DeclaredUniverse[] = [];

  const record = (
    at: number,
    name: string,
    elementType: string,
    openBracket: number,
  ): void => {
    if (PRIMITIVE_ELEMENT_TYPES.has(elementType)) return;
    const close = code.indexOf("]", openBracket);
    if (close === -1) return;
    const body = code.slice(openBracket + 1, close);
    if (!ONLY_STRING_LITERALS.test(body)) return;
    const members = (body.match(/"[^"\\]*"|'[^'\\]*'/g) ?? []).map((s) => s.slice(1, -1));
    const verdict = declaredSubsetVerdict(source, at, members.length);
    found.push({
      file,
      line: view.lineAt(at),
      name,
      elementType,
      members,
      deliberateSubsetReason: verdict.kind === "declared" ? verdict.reason : null,
      malformedSubsetReason: verdict.kind === "malformed" ? verdict.why : null,
      appendedTo: new RegExp(`\\b${name}\\.push\\s*\\(`).test(code),
    });
  };

  ANNOTATED_LIST.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANNOTATED_LIST.exec(code)) !== null) {
    const elementType = match[2] ?? match[3] ?? match[4];
    if (elementType === undefined) continue;

    // The initializer starts at the `=` the pattern consumed. Take it as
    // written, newlines and all, and require it to BE a list.
    const initializer = code.slice(ANNOTATED_LIST.lastIndex, ANNOTATED_LIST.lastIndex + INITIALIZER_SEARCH_CHARS)
      .replace(/^[ \t]*\r?\n/, "");
    if (!LIST_INITIALIZER.test(initializer)) continue;

    const open = code.indexOf("[", ANNOTATED_LIST.lastIndex);
    if (open === -1) continue;
    record(match.index, match[1]!, elementType, open);
  }

  // ── THE SAME EVIDENCE, IN THE OTHER THREE POSITIONS ───────────────────────
  //
  // A type argument precedes its list; an assertion and a `satisfies` follow
  // it. Both are located from the bracket the pattern actually captured, never
  // from "the next bracket within N characters" — bracket-hunting is not
  // parsing, and it has produced a wrong finding on this project four times,
  // most recently by reading the bracket of an INDEXED ACCESS TYPE as a
  // one-member vocabulary.
  TYPE_ARGUMENT_LIST.lastIndex = 0;
  while ((match = TYPE_ARGUMENT_LIST.exec(code)) !== null) {
    const open = match.index + match[0].length - match[2]!.length;
    record(match.index, nameFor(code, match.index), match[1]!, open);
  }
  for (const pattern of [AS_ASSERTED_LIST, SATISFIES_LIST]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      // The closing bracket is what matched; walk back to its opener. A list of
      // string literals holds no nested brackets, so the previous `[` is it —
      // and if what is between them is not a pure list, `record` refuses.
      const close = match.index;
      const open = code.lastIndexOf("[", close);
      if (open === -1) continue;
      record(open, nameFor(code, open), match[2]!, open);
    }
  }
  return found;
}

/**
 * The identifier a list is being assigned to, or a positional stand-in.
 *
 * The stand-in names the SHAPE rather than pretending to a name, so an
 * operator reading the refusal is told what to look for instead of being sent
 * after an identifier that does not exist.
 */
function nameFor(code: string, at: number): string {
  const before = code.slice(Math.max(0, at - 200), at);
  return ENCLOSING_CONST.exec(before)?.[1] ?? "(an unnamed list)";
}

/**
 * A line that is part of a comment BLOCK, judged from the line alone.
 *
 * Not a lexer, and it does not need to be: the only lines this is ever asked
 * about are the contiguous run directly above a declaration that is itself
 * anchored at the start of a line. A JS/TS comment line begins with `//`,
 * `/*`, `*` or `*​/` after its indentation, and no other construct does.
 */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/;

/**
 * Why an exemption must state a COUNT, in digits, that this guard re-checks.
 *
 * ── SEVEN PLANTS, ALL SILENCED, ALL DRIVEN ────────────────────────────────
 *
 * This function used to return any non-empty text following the marker, and
 * `unownedUniverses` filtered on `!== null`. There was NO member-count check
 * of any kind: the "8 of 9 / 5 of 13" arithmetic in the four live exemptions
 * was done by hand and nothing ever re-checked it — the exact
 * "an exemption with no evidence is a claim nothing re-checks" this file's own
 * header demands. Every one of these came back `offenders=0`:
 *
 *   1. the marker above a FULL 3-of-3 vocabulary
 *   2. a reason stating a FALSE count ("two of the four lanes") above a 4-of-4
 *   3. the marker inside an unrelated STRING literal — the reason came back
 *      ending `";`, proving it had read a string interior
 *   4. the marker inside a TEMPLATE-LITERAL fixture
 *   5. `LANES.push(` appearing only inside a COMMENT elsewhere in the file
 *   6. the same, only inside a STRING
 *   7. two declarations on ADJACENT LINES with no blank between them — the
 *      second silently inherited the first's exemption, and the permanent test
 *      could not see it because its fixture joined the parts with a blank line
 *
 * ── WHAT CHANGED, AND WHICH PLANT EACH PART ANSWERS ───────────────────────
 *
 *   * The marker must sit on a COMMENT LINE (3, 4). A string or template
 *     interior can hold the marker text, but the line it sits on does not
 *     begin with a comment opener unless someone writes one there.
 *   * The upward walk stops at the first line that is neither blank nor a
 *     comment (7). A declaration is not blank and is not a comment, so the
 *     second of two adjacent declarations can no longer reach past the first.
 *   * The reason must state `N of M` IN DIGITS, and `N` is compared against
 *     the members this guard actually extracted (1, 2). A full list is not
 *     forbidden — `src/quality/config.ts` names all eight signals on purpose
 *     and says so — but it must be WRITTEN as `8 of 8`, which is a claim
 *     someone had to make rather than one nobody checked.
 *   * `appendedTo` is no longer an exemption at all (5, 6). Its input was a
 *     raw-byte `X.push(` test, unfixable at the line level for the string
 *     case, and it SILENCED the guard. An accumulator now declares itself
 *     like everything else; the flag is kept as information for the message.
 *
 * ── RESIDUAL, STATED ──────────────────────────────────────────────────────
 *
 * `M` is the author's claim about the union's size and is NOT re-derived: the
 * union may be declared in another file, and finding it is a second scan with
 * a second universe. `N` is checked, so a list that loses a member reds; `M`
 * going stale is still a claim nobody re-checks, and it is the next rung.
 */
const STATED_COUNT = /(\d+)\s+of\s+(\d+)\b/;

type SubsetVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "declared"; readonly reason: string; readonly stated: number; readonly total: number }
  | { readonly kind: "malformed"; readonly why: string };

function declaredSubsetVerdict(source: string, declIndex: number, memberCount: number): SubsetVerdict {
  const lines = source.slice(0, declIndex).split("\n");
  // `declIndex` sits at the START of the declaration's line, so the split's
  // last element is that line's (empty) prefix, not a preceding line. Reading
  // it as one made every marker look like it was separated from its
  // declaration by a blank line, and the first run reported four correctly
  // annotated declarations as unmarked — a guard refusing the exemption it
  // had just been given.
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") break;
    // STOP at anything that is not a comment. Code above a declaration is a
    // wall, not a window: without this the second of two adjacent
    // declarations inherited the first's exemption in silence.
    if (!COMMENT_LINE.test(trimmed)) break;
    const at = trimmed.indexOf(DELIBERATE_SUBSET_MARKER);
    if (at === -1) continue;
    const reason = trimmed.slice(at + DELIBERATE_SUBSET_MARKER.length).trim();
    if (reason.length === 0) {
      return { kind: "malformed", why: "the marker carries no reason" };
    }
    // The count may continue onto the following comment lines, which is how
    // every live exemption is written. Read the whole contiguous comment block
    // from the marker down to the declaration.
    const block = lines.slice(i).map((l) => l.trim().replace(COMMENT_LINE, "").trim()).join(" ");
    const counted = STATED_COUNT.exec(block);
    if (counted === null) {
      return {
        kind: "malformed",
        why:
          `the reason states no machine-checkable count. Write "${DELIBERATE_SUBSET_MARKER} ` +
          `${String(memberCount)} of <total> — <why>": the count is the evidence, and prose ` +
          `alone is a claim nothing re-checks`,
      };
    }
    const stated = Number(counted[1]);
    const total = Number(counted[2]);
    if (stated !== memberCount) {
      return {
        kind: "malformed",
        why:
          `the reason claims ${String(stated)} member(s) and the declaration holds ` +
          `${String(memberCount)}. One of the two moved and nothing said so`,
      };
    }
    if (total < stated) {
      return {
        kind: "malformed",
        why: `the reason claims ${String(stated)} of ${String(total)}, which is more than the whole`,
      };
    }
    return { kind: "declared", reason, stated, total };
  }
  return { kind: "none" };
}

/**
 * The ones that must be refused: a vocabulary, not an accumulator, with no
 * declared reason to be partial.
 *
 * An accumulator (`const required: CapabilityName[] = ["text"]` followed by
 * `required.push(…)`) is a working value that happens to start with a literal
 * — it is not claiming to enumerate anything, and refusing it would be the
 * guard reporting on the wrong subject.
 */
export function unownedUniverses(all: readonly DeclaredUniverse[]): readonly DeclaredUniverse[] {
  return all.filter((u) => u.deliberateSubsetReason === null);
}

/**
 * The operator-facing refusal.
 *
 * It names the two fixes that make the class impossible rather than telling
 * anyone to be careful, because a remedy is part of the guard: advice that
 * does not survive being followed is a guard certifying the thing it just
 * rejected.
 */
export function declaredUniverseFailure(
  offenders: readonly DeclaredUniverse[],
): string | null {
  if (offenders.length === 0) return null;
  const lines = offenders.map(
    (u) =>
      `  ${u.file}:${u.line}  const ${u.name}: readonly ${u.elementType}[] = [${u.members.length} members]` +
      // A MALFORMED exemption is reported as itself. "No marker" and "a marker
      // that does not hold" send a reader to different places, and printing
      // them identically is how the second gets fixed by adding a third.
      (u.malformedSubsetReason === null ? "" : `\n      MARKER PRESENT BUT REJECTED: ${u.malformedSubsetReason}`) +
      (u.appendedTo ? `\n      (${u.name} is appended to later in this file — an accumulator still declares itself)` : ""),
  );
  return [
    `${offenders.length} hand-written vocabular${offenders.length === 1 ? "y" : "ies"} can lose a member silently:`,
    ...lines,
    "",
    "A list annotated with a union type accepts any SUBSET of that union, so a member",
    "added to the type and forgotten here compiles with zero errors while every consumer",
    "built from the list answers for the smaller set.",
    "",
    "Make the omission unrepresentable, either way round:",
    `  - the ARRAY owns it:  const X = [...] as const;  type T = typeof X[number];`,
    `  - a RECORD owns it:   const BY_T: Record<T, …> = {...};  const X = Object.keys(BY_T) as readonly T[];`,
    "",
    `If the list is deliberately PARTIAL — or deliberately COMPLETE — say so where it is`,
    `declared, in a comment directly above it, with the COUNT and the reason:`,
    `  // ${DELIBERATE_SUBSET_MARKER} 5 of 13 — <why this names these members and not the others>`,
    `The count is the evidence. It is compared against the members actually declared, so a`,
    `list that later loses one is refused rather than silently re-certified by its own note.`,
  ].join("\n");
}

const SCANNED_EXTENSIONS: readonly string[] = [".ts", ".mts", ".svelte"];
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build"]);

/** Every scannable file under `root`/`dir`, as repository-relative paths. */
export function sourceFilesUnder(root: string, dir: string): readonly string[] {
  const start = join(root, dir);
  let entry;
  try {
    entry = statSync(start);
  } catch {
    return [];
  }
  if (!entry.isDirectory()) return [];
  const out: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(item.name)) continue;
      const full = join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (SCANNED_EXTENSIONS.some((e) => item.name.endsWith(e))) out.push(full);
    }
  }
  return out.map((f) => relative(root, f).split(sep).join("/")).sort();
}

/**
 * Drive the rule over a real tree.
 *
 * `extraFiles` exists so a caller can inject a PLANTED file that is not part
 * of the repository. A mutation canary must never be a live tracked file:
 * two guards once chose the same real module, ran in parallel, and left it at
 * zero bytes.
 */
export function scanForDeclaredUniverses(
  root: string,
  dirs: readonly string[],
  extraFiles: readonly string[] = [],
): Readonly<{ scanned: number; universes: readonly DeclaredUniverse[] }> {
  const files = [...dirs.flatMap((d) => sourceFilesUnder(root, d)), ...extraFiles];
  const universes: DeclaredUniverse[] = [];
  let vanished = 0;
  for (const f of files) {
    const abs = f.startsWith("/") ? f : join(root, f);
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch (error) {
      // A FILE THAT DISAPPEARED BETWEEN THE LISTING AND THE READ, AND NOTHING
      // ELSE. Other guards in this suite plant temporary probe files inside
      // real source directories and delete them again, so a concurrent run
      // walks a name that no longer exists — driven, `ENOENT` on
      // `tests/prevention/__planted-window.probe.ts` mid-suite. A file that is
      // gone cannot hold a violation, so it is dropped from the population
      // rather than crashing the scan. Every OTHER failure is re-thrown: an
      // unreadable file (EACCES) or a directory in the list IS a shrunken
      // universe wearing an exception, and swallowing it would be the silent
      // narrowing this whole module exists to refuse.
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
      vanished += 1;
      continue;
    }
    universes.push(...findDeclaredUniverses(source, f));
  }
  return { scanned: files.length - vanished, universes };
}
