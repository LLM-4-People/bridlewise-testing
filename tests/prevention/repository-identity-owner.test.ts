// @vitest-environment node
/**
 * THE REPOSITORY IDENTITY HAS ONE SOURCE (P1.10 prep). This repository's
 * `owner/name` is declared once, as the `forge` section's trunk repository
 * in `engine/bridlewise.config.json`, and everything else derives from
 * `engine/src/workflow/forge/repository-identity.ts` or is generated from it:
 * - `package.json`'s repository, homepage and bugs fields;
 * - `CITATION.cff`'s repository-code;
 * - the community health files and the issue chooser.
 *
 * No other tracked code or configuration spells it. Comments are not code,
 * so prose citing the name in a comment is not a second source; a literal is.
 * Otherwise the rename is a hunt instead of one value.
 *
 * Scope: every tracked source and configuration file of the code roots and
 * the workflows, and every hand-written document and data file. Prose links
 * within the repository relatively; an address that must be absolute is a
 * `[text][repo:<path>]` or `[text][site:<path>]` reference whose definition
 * `harness sync` generates from the identity.
 */
import { describe, expect, test } from "vitest";

import { PRODUCT_NAME } from "../../engine/src/kernel/product-identity.ts";
import { configuredForge } from "../../engine/src/workflow/forge/configured-forge.ts";
import { configuredRepositoryIdentity, productRenamedSettings, repositoryIdentity, repositoryIdentityCopies, type RepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";
import { absoluteProcessDocLinkReason, repositoryPathFromGithubUrl } from "../../scripts/repository-links.ts";
import { gitTrackedPaths, read, stripCommentsOnlyFor } from "../helpers/source-scan.ts";

const BLOCK_BEGIN = "<!-- BEGIN GENERATED";
const BLOCK_END = "<!-- END GENERATED";

/** A hand-written document without its generated blocks (each from its BEGIN marker through its END marker's line). */
function withoutGeneratedBlocks(text: string): string {
  let kept = "";
  let from = 0;
  for (let at = text.indexOf(BLOCK_BEGIN); at !== -1; at = text.indexOf(BLOCK_BEGIN, from)) {
    const end = text.indexOf(BLOCK_END, at);
    if (end === -1) break;
    kept += text.slice(from, at);
    const lineEnd = text.indexOf("\n", end);
    from = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return kept + text.slice(from);
}

/**
 * THE REVIEWED MENTIONS of the repository's bare name: each names it as a
 * fact of the past (a name it had) or inside a fixture world (a test's own
 * forge section, a remote URL or a checkout folder), never as where the
 * repository lives. A new entry is a review decision, with its reason.
 */
/** Each reviewed entry is keyed to its OWN FIXED SPELLING, never to whatever the identity is called: a rename moves no entry. */
const HISTORICAL_SPELLING = "bridlewise-testing";
const HISTORICAL_BARE_NAMES: ReadonlyMap<string, Readonly<{ spelling: string; why: string }>> = new Map<string, Readonly<{ spelling: string; why: string }>>([
  // The names this repository had: kept so the redirect site answers the old base path and stale spellings are refused.
  ["scripts/floor/repository.mjs", { spelling: HISTORICAL_SPELLING, why: "LEGACY_BASEURL and NAMES_IN_HISTORY: the names this repository has had, to redirect and to refuse" }],
  ["tests/unit/floor-site-links.test.ts", { spelling: HISTORICAL_SPELLING, why: "the legacy redirect's tests and a planted stale spelling, both about the old name" }],
  // Fixture worlds: a test's own forge section, remotes and checkout folders, independent of this repository's configuration.
  ["engine/test/forge/forge-settings.ts", { spelling: HISTORICAL_SPELLING, why: "the test forge section's trunk: a fixture, independent of the configuration" }],
  ["engine/test/forge/apps.test.ts", { spelling: HISTORICAL_SPELLING, why: "expectations over the test forge section's trunk" }],
  ["engine/test/forge/repository-identity.test.ts", { spelling: HISTORICAL_SPELLING, why: "the identity derived from the test forge section, before and after a planted rename" }],
  ["engine/test/workspaces/workspace-forge-github.test.ts", { spelling: HISTORICAL_SPELLING, why: "remote URLs a workspace parses, in a fixture" }],
  ["engine/test/workspaces/workspace-contracts.test.ts", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in a fixture record" }],
  ["engine/test/workspaces/fixtures/v2-records/merged-feature-receipt.json", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in a fixture record" }],
  ["engine/test/workspaces/fixtures/v2-records/quarantined-overlay.json", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in a fixture record" }],
  ["scripts/sd-stale-classifier.ts", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in an example, not the repository's address" }],
  ["tests/cockpit/switch-river.test.ts", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in a fixture" }],
  ["tests/prevention/sd-stale-reconciliation.test.ts", { spelling: HISTORICAL_SPELLING, why: "a checkout folder's name in a fixture" }],
  ["tests/public/test-shard-manifest.test.mjs", { spelling: HISTORICAL_SPELLING, why: "a runner's checkout folder in a fixture path" }],
  // This guard: the reviewed entries' own fixed spelling, written once (HISTORICAL_SPELLING).
  ["tests/prevention/repository-identity-owner.test.ts", { spelling: HISTORICAL_SPELLING, why: "the reviewed entries' own fixed spelling, written once" }],
]);

/**
 * HISTORICAL RECORD SPELLINGS: a record (a tracker item) cites a GitHub object
 * by its URL, and the preview repository's objects keep their addresses only
 * under the preview's own name. Each entry is keyed to its exact fixed
 * spelling, with the spelling P1.10 rewrites it to once the preview repository
 * is renamed (`bridlewise` -> `bridlewise-preview`, and the trunk takes the
 * old name). The rename test applies the rewrite, as the runbook's step does.
 */
const HISTORICAL_RECORD_SPELLINGS: readonly Readonly<{ path: string; spelling: string; afterRename: string; why: string }>[] = [
  { path: "docs/trackers/items/M0.md", spelling: "github.com/LLM-4-People/bridlewise/releases/tag/v0.0.3-preview", afterRename: "github.com/LLM-4-People/bridlewise-preview/releases/tag/v0.0.3-preview", why: "the preview release M0 shipped, cited by its URL as a record must" },
];

/** Whether `text` spells `spelling` as a whole name (not inside a longer name: `owner/name` is not `owner/name-evidence`), case-insensitively. */
function spells(text: string, spelling: string): boolean {
  const pattern = new RegExp(`${spelling.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "iu");
  return pattern.test(text);
}

/** The code and configuration files that spell `identity`'s owner/name, each file's text given by `textOf`. */
function codeOffenders(identity: RepositoryIdentity, textOf: (path: string) => string): readonly string[] {
  const scanned = [...gitTrackedPaths(".")].filter((path) => CODE_ROOTS.some((root) => path.startsWith(root)) && CODE.test(path) && !SOURCE_AND_GENERATED.has(path));
  expect(scanned.length, "the scan reads the code roots, not an empty set").toBeGreaterThan(500);
  return scanned.filter((path) => spells(stripCommentsOnlyFor(textOf(path), path), identity.fullName));
}

/** The hand-written documents and data files that spell `identity`'s owner/name or its Pages address outside a generated block. */
function documentOffenders(identity: RepositoryIdentity, textOf: (path: string) => string): readonly string[] {
  // Prose and data: Markdown, JSON, YAML, CFF and text anywhere in the tree, except test fixtures, generated folders,
  // files generated whole (their first line says so; their sources are scanned instead), the one source and its
  // generated copies, and the generated blocks inside a hand-written document (links, clone command, indexes).
  // The owner/name, the project site on the forge's Pages domain, and the site's own host when the trunk declares one.
  const spellings = [identity.fullName, `${identity.owner}.github.io/${identity.name}`, ...(identity.pagesBasePath === "" ? [new URL(identity.pagesUrl).host] : [])];
  const excludedRoots = ["engine/traceability/", ".github/forge/", "engine/test/", "tests/", "engine/verification/"];
  const documents = [...gitTrackedPaths(".")].filter((path) => /\.(?:md|json|ya?ml|cff|txt|tmpl)$/u.test(path)
    && !excludedRoots.some((root) => path.startsWith(root)) && !SOURCE_AND_GENERATED.has(path));
  expect(documents.length, "the scan reads the documents, not an empty set").toBeGreaterThan(300);
  return documents.filter((path) => {
    const text = textOf(path);
    if (/GENERATED by `harness sync`/u.test(text.split("\n", 1)[0] ?? "")) return false;
    // No exemption: a historical record spelling is never the identity before the rename, and after it the
    // runbook's step rewrites it (a record left behind would cite the renamed trunk, and is caught here).
    const handWritten = withoutGeneratedBlocks(text);
    return spellings.some((spelling) => spells(handWritten, spelling));
  });
}

/** Every mention of `name` as a whole word (not inside a longer name or path segment), case-insensitively. */
function bareMentions(text: string, name: string): number {
  const lower = text.toLowerCase();
  const wanted = name.toLowerCase();
  let count = 0;
  for (let at = lower.indexOf(wanted); at !== -1; at = lower.indexOf(wanted, at + 1)) {
    const before = at === 0 ? "" : lower.charAt(at - 1);
    const after = lower.charAt(at + wanted.length);
    if (!/[a-z0-9_.-]/u.test(before) && !/[a-z0-9_-]/u.test(after)) count += 1;
  }
  return count;
}

const CODE_ROOTS = ["engine/src/", "engine/scripts/", "scripts/", "server/", "src/", "shared/", ".github/workflows/"];
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs|svelte|ya?ml|json)$/u;
/** The one source, and the files generated from it (`harness sync`'s forge-files arm and community arm). */
const SOURCE_AND_GENERATED = new Set(["engine/bridlewise.config.json", "package.json", "CITATION.cff", ".github/ISSUE_TEMPLATE/config.yml"]);

describe("this repository's owner/name is spelled only where it is declared or generated", () => {
  test("no tracked code or configuration names the repository literally", () => {
    const identity = configuredRepositoryIdentity();
    expect(codeOffenders(identity, read), `these files spell ${identity.fullName}; derive it from the repository identity instead`).toEqual([]);
  });

  test("no hand-written document or data file spells it either: links within the repository are relative, absolute ones are generated", () => {
    const identity = configuredRepositoryIdentity();
    const offenders = documentOffenders(identity, read);
    expect(offenders, `these documents spell ${identity.fullName}; link within the repository relatively, or use a [text][repo:<path>] / [text][site:<path>] reference (or [text][product:<path>] / [text][preview:<path>] for the product's and the preview's repositories; harness sync generates each definition)`).toEqual([]);
  });

  test("THE P1.10 RENAME stays clean: in a copy of the tree with the forge section renamed (the preview first, then the trunk takes the product's name) and its generated copies rewritten, nothing spells the new owner/name by hand", () => {
    // Before P1.10 this renames a copy; once the P1.10 PR has landed the section is already renamed (the edit is
    // idempotent), and the same assertions judge the real tree.
    const alreadyRenamed = configuredRepositoryIdentity().name === PRODUCT_NAME;
    const renamed = productRenamedSettings(configuredForge());
    const identity = repositoryIdentity(renamed);
    expect(identity.name).toBe(PRODUCT_NAME);
    expect(identity.product.fullName, "the product is published from the renamed trunk").toBe(identity.fullName);
    expect(identity.preview?.name, "the preview keeps its own name").toBe(`${PRODUCT_NAME}-preview`);
    // The copy: every generated copy of the identity (link definitions, clone and variable blocks, package.json, CITATION.cff) as harness sync would write it, over the tracked tree.
    const copies = repositoryIdentityCopies(".", identity);
    // The runbook's record step: each historical record spelling is rewritten to the preview's new name.
    const rewritten = (path: string, text: string): string => HISTORICAL_RECORD_SPELLINGS.filter((entry) => entry.path === path).reduce((kept, entry) => kept.replaceAll(entry.spelling, entry.afterRename), text);
    const textOf = (path: string): string => rewritten(path, copies.get(path) ?? read(path));
    // The copies carry the renamed identity: the manifest's homepage, a document's link definitions, the variable block.
    expect(JSON.parse(copies.get("package.json")!).homepage).toBe(identity.webUrl);
    expect(copies.get("README.md"), "README's product link follows the product to the renamed trunk").toContain(`[product:]: ${identity.webUrl}`);
    expect(copies.get("product-only/README.md"), "the product README's commands name the renamed trunk").toContain(`REPO=${identity.fullName}`);
    for (const entry of HISTORICAL_RECORD_SPELLINGS) {
      // Before the rename the record cites its fixed spelling; after it, the runbook's step has rewritten it.
      expect(read(entry.path), `${entry.path} cites ${alreadyRenamed ? entry.afterRename : entry.spelling} (a stale entry is removed)`).toContain(alreadyRenamed ? entry.afterRename : entry.spelling);
      expect(entry.afterRename, "the rewrite names the preview's new name").toContain(`/${identity.preview!.name}/`);
    }
    expect(codeOffenders(identity, textOf), `after the rename, these files spell ${identity.fullName}`).toEqual([]);
    expect(documentOffenders(identity, textOf), `after the rename, these documents spell ${identity.fullName}`).toEqual([]);
    // Not blind: a planted product-repository spelling in a document is caught after the rename.
    expect(spells(`See https://github.com/${identity.fullName}/releases.`, identity.fullName)).toBe(true);
    expect(spells(`See https://github.com/${identity.fullName}-evidence.`, identity.fullName), "a longer name is not this one").toBe(false);
  });

  test("the site's product and preview coordinates are their own repositories', the forge section's flags: never the trunk's before the rename", async () => {
    // @ts-expect-error -- a .mjs module has no declaration file in the TS program.
    const { COORDINATES } = await import("../../scripts/floor/repository.mjs") as { COORDINATES: Record<string, string> };
    const identity = configuredRepositoryIdentity();
    const forge = configuredForge();
    const flagged = (flag: "product" | "preview") => forge.repositories.find((repository) => repository[flag] === true)?.name;
    expect(identity.product.name).toBe(flagged("product"));
    expect(identity.preview?.name).toBe(flagged("preview"));
    expect(COORDINATES.productRepository).toBe(identity.product.fullName);
    expect(COORDINATES.productRepositoryUrl).toBe(identity.product.webUrl);
    expect(COORDINATES.docsUrl).toBe(identity.docsUrl);
    expect(COORDINATES.siteHost).toBe(identity.pagesBasePath === "" ? new URL(identity.pagesUrl).host : "");
    expect(COORDINATES.previewRepositoryUrl).toBe(identity.preview?.webUrl);
    if (identity.name !== PRODUCT_NAME) {
      // Before the rename the product is published from its own repository, not the trunk.
      expect(COORDINATES.productRepository).not.toBe(identity.fullName);
      expect(COORDINATES.productRepositoryUrl).not.toBe(identity.webUrl);
    }
  });

  test("the site's own host is refused when spelled by hand: spelledUrls names it as the site's address, whatever the path; a longer host is not it", async () => {
    // @ts-expect-error -- a .mjs module has no declaration file in the TS program.
    const { COORDINATES, spelledUrls } = await import("../../scripts/floor/repository.mjs") as { COORDINATES: Record<string, string>; spelledUrls: (text: string, coordinates: Record<string, string>) => { url: string; kind: string }[] };
    const host = COORDINATES.siteHost;
    expect(host, "the trunk declares its own host").not.toBe("");
    expect(spelledUrls(`See https://${host}/docs/quickstart/.`, COORDINATES)).toEqual([{ url: `${host}/docs/quickstart/.`, kind: "site" }]);
    expect(spelledUrls(`See ${host}.`, COORDINATES).map((entry) => entry.kind)).toEqual(["site"]);
    expect(spelledUrls(`See https://other-${host}/ and https://${host}x.example/.`, COORDINATES), "a longer host is another").toEqual([]);
  });

  test("the link classifier owns exactly the organisation's declared repositories: another owner, an undeclared repository and a non-file URL are not this project's", () => {
    const identity = configuredRepositoryIdentity();
    const own = `${identity.webUrl}/blob/main/docs/process/WORKFLOW.md`;
    expect(repositoryPathFromGithubUrl(own)).toBe("docs/process/WORKFLOW.md");
    for (const name of identity.organisationRepositories) expect(repositoryPathFromGithubUrl(`https://github.com/${identity.owner}/${name}/tree/main/docs/`), name).toBe("docs");
    // Planted violations of ownership: the same path under another owner, under a repository the forge does not declare.
    expect(repositoryPathFromGithubUrl(`https://github.com/Someone-Else/${identity.name}/blob/main/docs/process/WORKFLOW.md`)).toBeUndefined();
    expect(repositoryPathFromGithubUrl(`https://github.com/${identity.owner}/not-a-declared-repository/blob/main/docs/process/WORKFLOW.md`)).toBeUndefined();
    expect(repositoryPathFromGithubUrl(`${identity.webUrl}/issues/1`)).toBeUndefined();
    // The refusal it serves: a process document linking another process document absolutely.
    expect(absoluteProcessDocLinkReason("docs/process/ROLES.md", own)).toContain("link it relatively");
    expect(absoluteProcessDocLinkReason("docs/process/ROLES.md", `https://github.com/Someone-Else/${identity.name}/blob/main/docs/process/WORKFLOW.md`)).toBeUndefined();
  });

  test("no tracked text file names the repository by its bare name either, except reviewed historical and fixture mentions", () => {
    const identity = configuredRepositoryIdentity();
    // After the rename the repository's name IS the product's name, and a bare "bridlewise" is the product, not an
    // address: from then on the generated heading, links and clone block carry it, and this check has nothing to judge.
    if (identity.name.toLowerCase() === PRODUCT_NAME) return;
    // EVERY tracked text file: prose, data, code (comments included: a stale name in a comment survives a rename too)
    // and tests. Skipped: generated folders and files generated whole, the one source and its generated copies, the
    // generated blocks inside a hand-written document, and binary files.
    const generatedRoots = ["engine/traceability/", ".github/forge/"];
    const texts = [...gitTrackedPaths(".")].filter((path) => !generatedRoots.some((root) => path.startsWith(root)) && !SOURCE_AND_GENERATED.has(path)
      && !/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|gz|zst|zip|tar|db|sqlite|wasm|pdf|bin)$/u.test(path));
    expect(texts.length, "the scan reads the tree, not an empty set").toBeGreaterThan(3000);
    const offenders = texts.filter((path) => {
      const text = read(path);
      if (text.includes("\u0000")) return false;
      if (/GENERATED by `harness sync`/u.test(text.split("\n", 1)[0] ?? "")) return false;
      const mentions = bareMentions(withoutGeneratedBlocks(text), identity.name);
      const reviewed = HISTORICAL_BARE_NAMES.get(path);
      // A reviewed entry admits its own fixed spelling only (today the same name; never the name a rename gives).
      return mentions > 0 && (reviewed === undefined || reviewed.spelling.toLowerCase() !== identity.name.toLowerCase());
    });
    expect(offenders, `these files name the repository ${identity.name} bare; derive it from the repository identity (code), use the generated heading block or a [text][repo:] reference (prose), or (for a fact of history or a fixture world) add a reviewed entry to HISTORICAL_BARE_NAMES`).toEqual([]);
    // Every reviewed entry still names it (an entry nobody needs is removed, not kept).
    for (const [path, entry] of HISTORICAL_BARE_NAMES) expect(bareMentions(withoutGeneratedBlocks(read(path)), entry.spelling), path).toBeGreaterThan(0);
    // The word test is not blind, and not loose: a planted heading counts; a longer name or a path segment does not.
    expect(bareMentions(`# ${identity.name}\n`, identity.name)).toBe(1);
    expect(bareMentions(`${identity.name}-evidence x${identity.name} ${identity.name}_tmp`, identity.name)).toBe(0);
  });

  test("the scan sees a planted literal (it is not blind)", () => {
    const spelled = configuredRepositoryIdentity().fullName;
    expect(stripCommentsOnlyFor(`export const X = "${spelled}";\n`, "planted.ts").toLowerCase()).toContain(spelled.toLowerCase());
    expect(stripCommentsOnlyFor(`// ${spelled}\nexport const X = 1;\n`, "planted.ts").toLowerCase()).not.toContain(spelled.toLowerCase());
  });
});
