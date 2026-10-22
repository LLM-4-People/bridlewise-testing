// @vitest-environment node
/**
 * The cutover graph receipt: the GENERATOR owns the landing place, never the
 * caller's shell.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `docs/cutover/graph.mjs` used to PRINT the resolved import graph and leave
 * the redirect to the operator: `node docs/cutover/graph.mjs > graph.json`
 * writes wherever the ambient shell is standing. The consumers beside the
 * generator (`edges.mjs`, `tests.mjs`, `analyze.mjs`) read
 * `docs/cutover/graph.json` — so a run from the repository root wrote the
 * fresh graph beside `package.json` while the consumers went on reading the
 * stale committed copy, and three binders were "resolved" against files
 * already deleted. A wrong answer with no error is worse than a missing one.
 *
 * The generator now writes the artifact itself, through a temporary file and
 * a rename, and stdout carries only the one-line receipt. It lands in the
 * ignored `.bridlewise/` state directory rather than beside the consumers,
 * because a committed copy is a second landing place and the one that goes
 * stale — there it cannot be committed, and a fresh clone regenerates it on
 * demand.
 *
 * ── THE SEARCH BEFORE CREATION ────────────────────────────────────────────
 *
 * No guard names `docs/cutover` anywhere in `tests/` or `engine/test/` (the
 * only hits are prose references in unrelated prevention headers), so no
 * existing file's charter covers the generator/consumer agreement — this
 * file is new.
 */
import { describe, expect, test } from "vitest";
import { readdirSync } from "node:fs";

import { gitTrackedPaths, read, stripCommentsOnly } from "../helpers/source-scan.ts";

const GENERATOR = "docs/cutover/graph.mjs";
const ARTIFACT_URL = "../../.bridlewise/cutover/graph.json";
const ARTIFACT_PATH = ".bridlewise/cutover/graph.json";

/**
 * The generator's source (comments stripped) and its payload binding. The
 * payload's own binding is read out of the source and followed, so an import
 * statement or an indirect print cannot stand in for the write — a version
 * keyed to the bare names stayed green while the payload went to stdout beside
 * an unused import. READ INSIDE A TEST, never at collection: a read in the
 * describe body ran when the suite was merely listed (`npx vitest list`, the
 * checkout setup's module-cache step), so a tree without the generator could
 * not list ANY test (#238). A missing generator now fails these tests, by name.
 */
function generatorSource(): Readonly<{ code: string; payloadName: string | undefined }> {
  const code = stripCommentsOnly(read(GENERATOR));
  return { code, payloadName: /const\s+(\w+)\s*=\s*JSON\.stringify\(\s*\{[^}]*\bedges\b/su.exec(code)?.[1] };
}

describe("the cutover graph receipt owns its landing place", () => {
  test("the generator writes the artifact to its own derived landing place, atomically", () => {
    const { code, payloadName } = generatorSource();
    // Comments are stripped so a mention in prose — including the defect
    // narrative in the generator's own header — cannot satisfy the arm.
    expect(
      code.includes(`new URL("${ARTIFACT_URL.replace(/graph\.json$/u, "")}", import.meta.url)`),
      `${GENERATOR} no longer derives the artifact's directory from its own location — ` +
        "the landing place must come from the generator's own `import.meta.url`, " +
        "which is the only derivation every cwd agrees on",
    ).toBe(true);
    expect(
      payloadName,
      `${GENERATOR} no longer builds the graph payload (a JSON.stringify over ` +
        "an object carrying the edges) — the receipt's content is gone",
    ).not.toBeUndefined();
    expect(
      new RegExp(`writeFileSync\\(\\s*\\w+,\\s*${payloadName ?? ""}\\b`, "u").test(code),
      `${GENERATOR} does not write the payload to a file — the artifact is back ` +
        "to depending on the caller's redirect, which is the ambient-cwd hazard",
    ).toBe(true);
    expect(
      /renameSync\s*\(/u.test(code),
      `${GENERATOR} writes the artifact without a rename — a reader mid-write ` +
        "meets a partial file; the staging-then-rename shape is the atomicity",
    ).toBe(true);
  });

  test("the generator's stdout carries a receipt line, never the payload", () => {
    const { code, payloadName } = generatorSource();
    expect(
      payloadName !== undefined &&
        new RegExp(`console\\.log\\s*\\([^)]*\\b(?:JSON\\.stringify|${payloadName})`, "u").test(code),
      `${GENERATOR} prints the payload again — whoever consumes stdout re-opens ` +
        "the redirect gap this guard exists to close",
    ).toBe(false);
  });

  test("every consumer reads exactly the artifact the generator writes", () => {
    // Deny-by-default over the directory: a new consumer added tomorrow is
    // discovered by the same scan, and reading anything other than the
    // generator's own landing place reds.
    const consumers = readdirSync("docs/cutover", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && entry.name !== "graph.mjs")
      .map((entry) => `docs/cutover/${entry.name}`)
      .filter((path) => /readFileSync\(\s*new URL\(/u.test(stripCommentsOnly(read(path))));
    expect(
      consumers.length,
      "found no graph.json consumers beside the generator — the scan went blind, not the tree clean",
    ).toBeGreaterThan(0);
    for (const consumer of consumers) {
      const reads = [...stripCommentsOnly(read(consumer)).matchAll(
        /readFileSync\(\s*new URL\(\s*"([^"]+\.json)"\s*,\s*import\.meta\.url\s*\)/gu,
      )].map((match) => match[1]);
      expect(
        reads,
        `${consumer} reads a JSON artifact that is not the generator's landing place — ` +
          "the generator and its consumers must agree on ONE landing place",
      ).toEqual([ARTIFACT_URL]);
    }
  });

  test("the artifact is generated, never committed", () => {
    // A committed copy is a second landing place, and it is the one that goes
    // stale: the phantom binders were manufactured against a committed copy a
    // fresh run never replaced. The generator's own run is the only source.
    // Both landing places are checked — the current one and the retired one
    // beside the generator, whose reappearance would be the same defect.
    const tracked = gitTrackedPaths(".");
    for (const path of [ARTIFACT_PATH, "docs/cutover/graph.json"]) {
      expect(
        tracked.has(path),
        `${path} is tracked by git — a committed receipt drifts while the ` +
          "consumers keep reading it. It must be generated on demand, never committed.",
      ).toBe(false);
    }
  });
});
