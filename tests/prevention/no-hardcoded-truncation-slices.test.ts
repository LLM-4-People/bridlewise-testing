// @vitest-environment node
/**
 * Mechanical enforcement: NO hardcoded truncation slices in production
 * code (backend AND frontend).
 *
 * A `.slice(0, <number>)` or `.slice(-<number>)` literal in any production
 * source root is a configurable that must live in the config owner
 * (`server/harness-config.ts`, `server/config.ts`, or the frontend
 * config owners — `src/client-config.ts`, `shared/constants.ts`) and be
 * consumed via an
 * accessor or named constant, not inlined at the call site. Scattering
 * these literals caused drift (the same limit taking different values
 * across call sites) and made tuning require editing every site. This
 * test denies any such literal so a new hardcoded truncation cannot slip
 * back in.
 *
 * The scan covers BOTH `.ts` and `.svelte` so a truncation literal inside a
 * Svelte component's `<script>` block is auto-caught (the frontend owns
 * components that can truncate too). Discovery is deny-by-default +
 * dynamic (`repositoryOwnedEntries` enumerates every top-level root the
 * repository owns — its `.gitignore` already removes deps, build output and
 * research copies — except tests); there is no hardcoded root list, so a NEW production
 * source root is auto-covered. The scan strips comments first (the config
 * owners document prior fixes in comments that mention `slice(0, N)` —
 * those are not violations). After stripping, a numeric truncation slice
 * in production code is a violation.
 */
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { repositoryOwnedEntries, walk } from "../helpers/source-scan.ts";
import { promotionView } from "../helpers/promotion-view.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// Deny-by-default root discovery: scan EVERY non-hidden top-level directory
// of the web-interface project the repository OWNS (its versioned `.gitignore`
// removes deps, build output and the `research/` source copies, through the
// one shared reader) that SHIPS (below). Hidden dirs (`.git`, `.svelte-kit`, `.bridlewise`,
// `.dev`, …) are config / runtime state, not production source, so they are
// excluded. This auto-covers any future production source root — there is no
// hardcoded list to forget. `routes/` is covered transitively because it lives
// under `server/` (the walker recurses).
//
// TWO ROOTS JOINED THE REPOSITORY AT THE MONOREPO ASSEMBLY AND ARE NOT THIS
// PROJECT'S SOURCE. `engine/` is a separate package with its own harness
// checks and its own rule set — subjecting it to a web-side rule it never
// adopted would have added 146 findings in one commit and, worse, made this
// guard's population depend on which repository was absorbed rather than on
// what this project writes. `docs/` is archived prose and history: files that
// are read, never run. Both are named here with the reason rather than left
// to the auto-discovery, because auto-discovery is right about FUTURE web
// roots and wrong about a foreign codebase that arrived whole.
//
// THE SCANNED ROOTS ARE THE PRODUCT, DERIVED NOT LISTED: the root
// directories the promotion profile ships (`tests/helpers/promotion-view.ts`
// — a root entry is product iff a shipped path lies under it), minus a
// product root that is its own package (it carries a `package.json`, e.g.
// `engine/`, whose own suite guards its own source). Records (the experiment
// archive, frozen rounds whose `.slice(0, 20)` is part of what that round did)
// and proofs never ship, so they are out by construction.
const SHIPPED_ROOTS = promotionView().shippedRootEntries;
const ROOTS = repositoryOwnedEntries(".").filter((entry) => {
  if (!SHIPPED_ROOTS.has(entry)) return false;
  let isDir = false;
  try {
    isDir = statSync(entry).isDirectory();
  } catch {
    return false;
  }
  return isDir && !existsSync(join(entry, "package.json"));
});

const SOURCE_FILES = ROOTS.flatMap((r) => walk(r, { exts: [".ts", ".svelte"] })).filter(
  (f) => !f.endsWith(".test.ts"),
);

// A numeric truncation slice that should be config-driven: an absolute cap
// `.slice(0, 123)` (positive literal second arg) or a one-arg suffix
// `.slice(-7)` (a fixed-width tail preview like a short hash). Relative trims
// like `.slice(0, -1)` (drop the last char) are NOT configurables and are
// excluded; accessor calls like `.slice(0, getFoo())` are excluded too.
const TRUNCATION_RE = /\.slice\((?:0\s*,\s*\d+|-\d+)\s*\)/;

describe("no hardcoded truncation slices in production code (deny-by-default: every source root)", () => {
  const violators: { file: string; line: number; text: string }[] = [];
  for (const file of SOURCE_FILES) {
    // Every hit at its true line, through the one "matches over a view" spelling (the code view: comments, strings and templates blanked).
    for (const hit of sourceViewOf(readFileSync(file, "utf8"), file).matches(TRUNCATION_RE, "code")) {
      violators.push({ file: file.split(sep).join("/"), line: hit.line, text: hit.text });
    }
  }

  test("zero `.slice(0, N)` / `.slice(-N)` numeric literals in any production source root", () => {
    expect(
      violators,
      violators.map((v) => `${v.file}:${v.line} ${v.text}`).join("\n"),
    ).toEqual([]);
  });

  test("the truncation configurables are exposed by the config owners", () => {
    const cfg = readFileSync(modulePath("harness-config.ts"), "utf8");
    expect(cfg).toContain("export function getMemoryPreviewMaxChars");
    expect(cfg).toContain("export function getRepositoryMapSampleCount");
    expect(cfg).toContain("export function getArtifactIdLength");
    expect(cfg).toContain("export function getRepoMapLanguagePreviewCount");
    expect(cfg).toContain("topCategoriesCount");
    const serverCfg = readFileSync(modulePathMatching("server/kernel/config.ts"), "utf8");
    expect(serverCfg).toContain("gitShortHashLength");
    // The provider error-message cap has ONE owner, the engine's configured
    // `runtime.responses.maximumErrorMessageCharacters`, served by the
    // server's transport door (the web env knob was a third cap, a2-design M6).
    expect(cfg).toContain("export function getResponsesTransportSettings");
    expect(serverCfg).not.toContain("llmErrorMessageMaxChars");
  });

  // The (knob → consuming expression) pairs that must NOT be inlined at a call
  // site. This is a list of NAMED knobs (each answers "where does the model/UX
  // see this"), not a list of FILES — the consumer file for each is discovered
  // dynamically below, so removing a consumer removes the assertion instead of
  // stranding it on a removed call (which is how the editor's hash-preview
  // consumer disappeared when the edit tool stopped echoing hashes).
  const TRUNCATION_KNOBS: readonly { knob: string; consumer: string }[] = [
    { knob: "getMemoryPreviewMaxChars", consumer: "getMemoryPreviewMaxChars(" },
    { knob: "maximumErrorMessageCharacters", consumer: "getResponsesTransportSettings().maximumErrorMessageCharacters" },
    { knob: "getRepositoryMapSampleCount", consumer: "getRepositoryMapSampleCount(" },
    { knob: "getArtifactIdLength", consumer: "getArtifactIdLength(" },
    { knob: "getRepoMapLanguagePreviewCount", consumer: "getRepoMapLanguagePreviewCount(" },
    { knob: "topCategoriesCount", consumer: "getQualityConfig().topCategoriesCount" },
    { knob: "gitShortHashLength", consumer: "serverConfig.gitShortHashLength" },
  ];

  test("each truncation knob has a live consumer (no inlined literal, no orphan)", () => {
    // Search every production source file (minus the config owners that
    // declare the knob). A knob with NO consumer is an orphan — a declared
    // configurable nothing reads — which is the same drift class as an inlined
    // literal, from the other side. Both are caught here.
    const corpus = SOURCE_FILES
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ f }) => !/harness-config\.ts$|server[\\/]kernel[\\/]config\.ts$/.test(f));
    for (const { knob, consumer } of TRUNCATION_KNOBS) {
      const users = corpus.filter(({ src }) => src.includes(consumer));
      expect(
        users.length,
        `truncation knob '${knob}' must have at least one live consumer using '${consumer}' (an orphan knob is dead config)`,
      ).toBeGreaterThan(0);
    }
  });
});
