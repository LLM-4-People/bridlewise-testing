/**
 * THE GUARD DOSSIER — one parser, one validator, shared by both prevention
 * estates and both runners.
 *
 * ── What a dossier is ────────────────────────────────────────────────────
 *
 * Every prevention guard carries a structured block, the DOSSIER, inside its
 * first leading doc comment (module scope — the block a reader opens the file
 * to). A dossier is a contiguous run of comment lines of the shape
 *
 *   GUARD <FIELD>: <one-line value>
 *
 * and answers, before any code is read, the questions a behavioural re-drive
 * otherwise re-derives from the guard's prose header every time:
 *
 *   GUARD SUBJECT   — the behaviour or invariant under guard, one line.
 *   GUARD OWNS      — the owning behaviour: the path or symbol where the
 *                     invariant actually lives. A relocation of the owner
 *                     updates this one line, at the guard that cares, instead
 *                     of being re-derived from the guard's body.
 *   GUARD PLANT     — the canonical mutation plant: the source string or
 *                     behaviour change the mutation harness applies to prove
 *                     this guard still bites.
 *   GUARD DRIVEN    — the path the plant enters through: the real caller's
 *                     entry point (a route, an exported function, a CLI
 *                     verb), never an inner helper the caller happens to
 *                     use.
 *   GUARD LIVENESS  — the precondition asserted BEFORE the plant's verdict
 *                     is trusted: the evidence that proves the driven path
 *                     was actually reached, so a guard measuring a refusal
 *                     cannot report on a path that never ran. Declared
 *                     whenever the plant drives behaviour; omitted only by a
 *                     guard whose claim is a pure source-text assertion with
 *                     no driven path.
 *   GUARD BOUNDARY  — the documented blind spot: the shape this guard
 *                     deliberately does not catch, so a future audit does not
 *                     report a stated gap as a discovery. Optional.
 *
 * ── Why the parser lives here ────────────────────────────────────────────
 *
 * The dossier is the convention's single source of truth: the enforcement
 * guard (web, vitest) and the mirror guard (engine, node:test) both validate
 * through THIS module, so the two runners can never disagree about what a
 * well-formed dossier is. A guard under test does not import anything — the
 * dossier is a comment, and the discovery half of the mechanism reads files,
 * not imports.
 *
 * ── Why a comment block and not a registry ───────────────────────────────
 *
 * The record lives in the file it describes. A central registry would be a
 * second answer to the same question, and the two would drift — a dossier
 * moves with its guard because it IS the guard's own header.
 */

/** The fields every dossier must carry. */
export const REQUIRED_DOSSIER_FIELDS = [
  "SUBJECT",
  "OWNS",
  "PLANT",
  "DRIVEN",
] as const;

/** Optional fields, recognised so a typo of one is a malformed dossier. */
export const OPTIONAL_DOSSIER_FIELDS = ["LIVENESS", "BOUNDARY"] as const;

const ALL_FIELDS: readonly string[] = [...REQUIRED_DOSSIER_FIELDS, ...OPTIONAL_DOSSIER_FIELDS];

/** One parsed field line of a dossier. */
export interface DossierField {
  readonly name: string;
  readonly value: string;
  /** 1-based line number in the file, for diagnostics. */
  readonly line: number;
}

/** A parsed dossier: its fields plus where in the file it was found. */
export interface Dossier {
  readonly fields: readonly DossierField[];
  /** 1-based line of the first `GUARD …:` line. */
  readonly line: number;
  /** 0 or 1 — which leading doc comment held the dossier. */
  readonly commentIndex: number;
}

/** A single validation complaint, human-readable and line-anchored. */
export interface DossierProblem {
  readonly line: number;
  readonly message: string;
}

const FIELD_LINE = /^\s*\*?\s*GUARD ([A-Z][A-Z0-9 -]*?):\s*(\S.*)?$/;

/**
 * A doc comment found at module scope, with where it sits.
 *
 * `anchor` distinguishes the two positions a dossier may live in: `leading`
 * comments precede every statement in the file (the position a reader opens
 * the file to); a comment following code is `attached` to what comes after
 * it — too late, because the reader has already read the imports to reach
 * it.
 */
interface AnchoredComment {
  readonly text: string;
  /** 1-based line where the comment's body starts (the line after `/**`). */
  readonly bodyLine: number;
  readonly anchor: "leading" | "attached";
}

/**
 * Extract the first two module-scope doc comments of a source file. Comments
 * separated from the top only by blank lines or line comments (directives,
 * prefaces) are `leading`; the run of leading material ends at the first
 * statement.
 *
 * The dossier may sit in either of the first two LEADING blocks — several
 * guards carry a line-comment preface above the doc block, and one carries a
 * small JSDoc marker block above the main one.
 */
function moduleScopeComments(source: string): AnchoredComment[] {
  const comments: AnchoredComment[] = [];
  let rest = source;
  let line = 1;
  let seenCode = false;
  // Bound defensively; the loop's real exits are `!block`/`seenCode` and the
  // cap of two comments.
  for (let i = 0; i < 64 && comments.length < 2; i++) {
    // Skip blank lines and line comments (directives, prefaces).
    const skipped = rest.match(/^(?:[ \t]*(?:\/\/[^\n]*)?\n)+/);
    if (skipped) {
      line += (skipped[0].match(/\n/g) ?? []).length;
      rest = rest.slice(skipped[0].length);
    }
    const block = rest.match(/^\/\*\*[\s\S]*?\*\//);
    if (block) {
      comments.push({
        text: block[0],
        bodyLine: line + 1,
        anchor: seenCode ? "attached" : "leading",
      });
      line += (block[0].match(/\n/g) ?? []).length;
      rest = rest.slice(block[0].length);
      continue;
    }
    if (seenCode) break;
    seenCode = true;
    // Consume one statement line and look once more, so a doc comment
    // attached to the first statement is classified rather than missed.
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    line += 1;
    rest = rest.slice(nl + 1);
  }
  return comments;
}

/**
 * Parse the dossier out of a guard's source, or `null` when no LEADING doc
 * comment carries a `GUARD <FIELD>:` line. The dossier is the maximal run of
 * consecutive field lines (blank `*` separator lines allowed inside the run)
 * starting at the first field line.
 */
export function parseDossier(source: string): Dossier | null {
  const comments = moduleScopeComments(source);
  for (let commentIndex = 0; commentIndex < comments.length; commentIndex++) {
    const comment = comments[commentIndex]!;
    if (comment.anchor !== "leading") continue;
    const lines = comment.text.split("\n");
    const fields: DossierField[] = [];
    let started = false;
    let firstLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const match = text.match(FIELD_LINE);
      if (match) {
        if (!started) {
          started = true;
          firstLine = comment.bodyLine + i;
        }
        fields.push({ name: match[1]!.trim(), value: (match[2] ?? "").trim(), line: comment.bodyLine + i });
        continue;
      }
      if (started) {
        // A blank comment line inside the run is tolerated; anything else
        // ends it, so a dossier's fields are one contiguous block.
        if (/^\s*\*\s*$/.test(text)) continue;
        break;
      }
    }
    if (fields.length > 0) {
      return { fields, line: firstLine, commentIndex };
    }
  }
  return null;
}

/**
 * Validate a parsed dossier. Returns the list of problems; empty means the
 * dossier is well-formed. `null` input (no dossier found) yields the single
 * "missing" problem, so a caller never special-cases absence.
 */
export function validateDossier(dossier: Dossier | null, fileLabel: string): DossierProblem[] {
  if (dossier === null) {
    return [
      {
        line: 1,
        message:
          `${fileLabel} carries no guard dossier. Add a ` +
          `\`GUARD SUBJECT/OWNS/PLANT/DRIVEN:\` block to the leading doc comment ` +
          `(the convention lives in tests/helpers/prevention-dossier.ts).`,
      },
    ];
  }
  const problems: DossierProblem[] = [];
  const seen = new Map<string, DossierField>();
  for (const field of dossier.fields) {
    if (!ALL_FIELDS.includes(field.name)) {
      problems.push({
        line: field.line,
        message: `unknown dossier field ${JSON.stringify(field.name)} — known fields: ${ALL_FIELDS.join(", ")}`,
      });
      continue;
    }
    if (seen.has(field.name)) {
      problems.push({ line: field.line, message: `duplicate dossier field ${JSON.stringify(field.name)}` });
      continue;
    }
    if (field.value.length === 0) {
      problems.push({ line: field.line, message: `dossier field ${field.name} has an empty value` });
    }
    seen.set(field.name, field);
  }
  for (const required of REQUIRED_DOSSIER_FIELDS) {
    if (!seen.has(required)) {
      problems.push({
        line: dossier.line,
        message: `dossier is missing required field GUARD ${required}:`,
      });
    }
  }
  return problems;
}
