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
import { configuredRepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";
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
 * THE REVIEWED HISTORICAL MENTIONS of the repository's bare name in
 * hand-written text: each names the name as a fact of the past (a rename's
 * from-name), never as where the repository lives. A new entry is a review
 * decision, with its reason.
 */
const HISTORICAL_BARE_NAMES: ReadonlyMap<string, string> = new Map<string, string>([]);

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
    const spelled = identity.fullName.toLowerCase();
    const scanned = [...gitTrackedPaths(".")].filter((path) => CODE_ROOTS.some((root) => path.startsWith(root)) && CODE.test(path) && !SOURCE_AND_GENERATED.has(path));
    expect(scanned.length, "the scan reads the code roots, not an empty set").toBeGreaterThan(500);
    const offenders = scanned.filter((path) => stripCommentsOnlyFor(read(path), path).toLowerCase().includes(spelled));
    expect(offenders, `these files spell ${identity.fullName}; derive it from the repository identity instead`).toEqual([]);
  });

  test("no hand-written document or data file spells it either: links within the repository are relative, absolute ones are generated", () => {
    // Prose and data: Markdown, JSON, YAML, CFF and text anywhere in the tree, except test fixtures, generated folders,
    // files generated whole (their first line says so; their sources are scanned instead), the one source and its
    // generated copies, and the generated blocks inside a hand-written document (links, clone command, indexes).
    const identity = configuredRepositoryIdentity();
    const spellings = [identity.fullName, `${identity.owner}.github.io/${identity.name}`].map((spelling) => spelling.toLowerCase());
    const excludedRoots = ["engine/traceability/", ".github/forge/", "engine/test/", "tests/", "engine/verification/"];
    const documents = [...gitTrackedPaths(".")].filter((path) => /\.(?:md|json|ya?ml|cff|txt|tmpl)$/u.test(path)
      && !excludedRoots.some((root) => path.startsWith(root)) && !SOURCE_AND_GENERATED.has(path));
    expect(documents.length, "the scan reads the documents, not an empty set").toBeGreaterThan(300);
    const offenders = documents.filter((path) => {
      const text = read(path);
      if (/GENERATED by `harness sync`/u.test(text.split("\n", 1)[0] ?? "")) return false;
      const handWritten = withoutGeneratedBlocks(text).toLowerCase();
      return spellings.some((spelling) => handWritten.includes(spelling));
    });
    expect(offenders, `these documents spell ${identity.fullName}; link within the repository relatively, or use a [text][repo:<path>] / [text][site:<path>] reference (harness sync generates its definition)`).toEqual([]);
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

  test("no hand-written document names the repository by its bare name either, except reviewed historical mentions", () => {
    const identity = configuredRepositoryIdentity();
    // After the rename the repository's name IS the product's name, and a bare "bridlewise" is the product, not an
    // address: from then on the generated heading, links and clone block carry it, and this check has nothing to judge.
    if (identity.name.toLowerCase() === PRODUCT_NAME) return;
    const excludedRoots = ["engine/traceability/", ".github/forge/", "engine/test/", "tests/", "engine/verification/"];
    const documents = [...gitTrackedPaths(".")].filter((path) => /\.(?:md|json|ya?ml|cff|txt|tmpl)$/u.test(path)
      && !excludedRoots.some((root) => path.startsWith(root)) && !SOURCE_AND_GENERATED.has(path));
    const offenders = documents.filter((path) => {
      const text = read(path);
      if (/GENERATED by `harness sync`/u.test(text.split("\n", 1)[0] ?? "")) return false;
      return bareMentions(withoutGeneratedBlocks(text), identity.name) > 0 && !HISTORICAL_BARE_NAMES.has(path);
    });
    expect(offenders, `these documents name the repository ${identity.name} bare; use the generated heading block, a [text][repo:] reference, or (for a fact of history) a reviewed entry in HISTORICAL_BARE_NAMES`).toEqual([]);
    // Every reviewed entry still names it (an entry nobody needs is removed, not kept).
    for (const path of HISTORICAL_BARE_NAMES.keys()) expect(bareMentions(withoutGeneratedBlocks(read(path)), identity.name), path).toBeGreaterThan(0);
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
