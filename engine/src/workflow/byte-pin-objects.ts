/**
 * THE BYTE-PIN STRUCTURE — one reader for every `{path, byteLength, sha256}`
 * object, wherever it lives.
 *
 * ── WHY THIS IS SHARED ───────────────────────────────────────────────────
 *
 * The pin-authority driver (`scripts/pin-authority-regeneration.ts`) rewrites
 * the byte measurement of every structural pin it finds in a registered
 * source-authority file. The hash-binding registry
 * (`src/workflow/hash-binding-registry.ts`) must normalize exactly those same
 * literals when it asks "is this generated-output change regeneration-only?",
 * or the two answers drift: the registry used to normalize ANY
 * `sha256: "<64 hex>"` field, so an authored pin written in the same shape was
 * exempted from the lease and write-set checks the driver never owns. The
 * driver's own comment says why a regex is the wrong reader here: a regex keys
 * on field ORDER and whitespace and silently misses a pin written in a
 * different (still valid) shape, while the AST keys on what the object IS.
 *
 * So the structural walker lives here, is exported, and BOTH owners read it.
 * The parser is imported here (and only here in this graph) because the
 * registry only ever has text; the driver parses once for its own rewrite
 * offsets and reuses the walker over that parse.
 */
import { parse as parseTypeScriptSource } from "@babel/parser";

import { HarnessError } from "../kernel/errors.ts";

/** One recognized byte-pin object: its semantic identity and the source offsets of the measured fields. */
export type BytePinObject = Readonly<{
  /** The literal target path, when the pin writes it as a string. */
  path: string | null;
  /**
   * The symbol the pin writes as `path:` when it does not write a string — a
   * constant (`FOUNDATION_CASCADE_TEST_WORKER_PATH`) the caller resolves
   * against its own module graph. A structural pin either names its target
   * directly or names a symbol for it; neither shape is skipped.
   */
  pathIdentifier: string | null;
  byteLength: number;
  sha256: string;
  byteLengthNode: Readonly<{ start: number; end: number; raw: string }>;
  sha256Node: Readonly<{ start: number; end: number; raw: string }>;
}>;

/**
 * Walk a Babel AST and yield every object expression that carries a string
 * `path` property AND numeric `byteLength` AND 64-hex `sha256` properties —
 * the structural signature of a byte-pin, however it is nested or ordered.
 * This is the robust replacement for a regex over source text.
 */
export function* eachBytePinObject(node: unknown): Generator<BytePinObject> {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* eachBytePinObject(item);
    return;
  }
  const record = node as Record<string, unknown> & { type?: string };
  if (record.type === "ObjectExpression" && Array.isArray(record.properties)) {
    const props = (record.properties as Array<Record<string, unknown>>).filter(
      (property) => property.type === "ObjectProperty",
    );
    const keyOf = (property: Record<string, unknown>): string | undefined => {
      const key = property.key as Record<string, unknown> | undefined;
      return key && (key.type === "Identifier" ? (key.name as string) :
        key.type === "StringLiteral" ? (key.value as string) : undefined);
    };
    const pathProp = props.find((property) => keyOf(property) === "path");
    const byteProp = props.find((property) => keyOf(property) === "byteLength");
    const shaProp = props.find((property) => keyOf(property) === "sha256");
    const pathValue = pathProp?.value as Record<string, unknown> | undefined;
    const byteValue = byteProp?.value as Record<string, unknown> | undefined;
    const shaValue = shaProp?.value as Record<string, unknown> | undefined;
    if (
      (pathValue?.type === "StringLiteral" || pathValue?.type === "Identifier") &&
      byteValue?.type === "NumericLiteral" &&
      shaValue?.type === "StringLiteral" &&
      /^[0-9a-f]{64}$/u.test(shaValue.value as string)
    ) {
      const byteExtra = byteValue.extra as Record<string, unknown> | undefined;
      const shaExtra = shaValue.extra as Record<string, unknown> | undefined;
      yield {
        path: pathValue.type === "StringLiteral" ? (pathValue.value as string) : null,
        pathIdentifier: pathValue.type === "Identifier" ? (pathValue.name as string) : null,
        byteLength: byteValue.value as number,
        sha256: shaValue.value as string,
        byteLengthNode: {
          start: byteValue.start as number,
          end: byteValue.end as number,
          raw: (byteExtra?.raw as string) ?? String(byteValue.value),
        },
        sha256Node: {
          start: shaValue.start as number,
          end: shaValue.end as number,
          raw: (shaExtra?.raw as string) ?? `"${shaValue.value}"`,
        },
      };
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range" || key === "extra" ||
      key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    yield* eachBytePinObject(record[key]);
  }
}

/**
 * The inner literal offsets of every structural byte-pin's `sha256` in
 * `text` — the ONLY literals the pin-authority driver rewrites. A `sha256:`
 * field that is not part of such an object (an authored constant, a probe
 * written in the same shape) is NOT returned, so a change confined to it is
 * an authored change, never an exempt regeneration.
 *
 * Throws when the text does not parse: a pin-bearing source whose bytes cannot
 * be read as TypeScript is a broken owner, never a file with no pins.
 */
export function bytePinSha256Ranges(text: string): readonly Readonly<{ literal: string; start: number; end: number }>[] {
  let program: unknown;
  try {
    program = parseTypeScriptSource(text, { sourceType: "module", plugins: ["typescript"] });
  } catch (error) {
    throw new HarnessError(`byte-pin source is not parseable TypeScript: ${error instanceof Error ? error.message : String(error)}`, "byte_pin_source_unparseable");
  }
  return [...eachBytePinObject(program)].map((pin) => ({
    literal: pin.sha256,
    // `sha256Node.start` is the opening quote; the literal is the 64 hex bytes
    // inside it (a byte-pin's digest can never contain an escape sequence).
    start: pin.sha256Node.start + 1,
    end: pin.sha256Node.start + 1 + pin.sha256.length,
  }));
}
