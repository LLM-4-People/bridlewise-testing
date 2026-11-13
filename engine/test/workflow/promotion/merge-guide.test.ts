/**
 * THE GUIDE IS FAITHFUL TO THE CODES (merge-door-final §17.2 T-E3): every
 * code `src/workflow/promotion/codes.ts` answers with appears in the code
 * table of `docs/process/MERGE-GUIDE.md` exactly once, with its class and its
 * exit code (and "auto 0" exactly for the codes an unattended run exits 0
 * on), and the table names no code that does not exist — so a person reading
 * a refusal's code finds what it means, and a code added tomorrow cannot
 * ship undocumented.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { PROMOTION_CODES, promotionExitCode, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";

import { MERGE_GUIDE_ROLES, splitGeneratedBlock } from "../../../src/kernel/verification-paths.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { decodeConfigDocumentRaw, getConfigDocumentSchema } from "../../../src/kernel/config.ts";
import { HarnessError } from "../../../src/kernel/errors.ts";
import type { TreeReader } from "../../../src/git/tree-reader.ts";
import { mergeGuideRoleFacts, projectMergeGuideRoles, renderMergeGuideRoles } from "../../../src/workflow/promotion/profile.ts";
import { escapeSiteHtml } from "../../../../shared/markup.ts";

const GUIDE = new URL("../../../../docs/process/MERGE-GUIDE.md", import.meta.url);

/** The code table's rows: code → its class and exit cell. */
function guideRows(): ReadonlyMap<string, Readonly<{ class: string; exit: string }>> {
  const rows = new Map<string, Readonly<{ class: string; exit: string }>>();
  for (const line of readFileSync(GUIDE, "utf8").split("\n")) {
    const match = /^\| `(promotion_[a-z_]+)` \| ([a-z]+) \| ([^|]+) \|/u.exec(line);
    if (match === null) continue;
    assert.equal(rows.has(match[1]!), false, `${match[1]!} has two rows`);
    rows.set(match[1]!, { class: match[2]!, exit: match[3]!.trim() });
  }
  return rows;
}

test("T-E3: every code is in the guide's table once, with its class and exit (auto 0 exactly where an unattended run exits 0), and the table names no other", () => {
  const rows = guideRows();
  const codes = Object.keys(PROMOTION_CODES) as PromotionCode[];
  assert.ok(rows.size > 0, "the guide's code table was not found: a reader finds nothing");
  for (const code of codes) {
    const row = rows.get(code);
    assert.ok(row !== undefined, `${code} is missing from docs/process/MERGE-GUIDE.md §7`);
    assert.equal(row.class, PROMOTION_CODES[code].class, `${code}: the guide's class`);
    const exit = String(promotionExitCode(code));
    const auto = promotionExitCode(code, true);
    assert.equal(row.exit, auto === 0 && exit !== "0" ? `${exit} (auto 0)` : exit, `${code}: the guide's exit`);
  }
  assert.deepEqual([...rows.keys()].filter((code) => !(code in PROMOTION_CODES)), [], "the guide names codes that do not exist");
});

/** A tree port with independently supplied bytes, no repository or ambient settings. */
function textTree(files: ReadonlyMap<string, string>, label = "independent tree"): TreeReader {
  return {
    label, paths: () => [...files.keys()].sort(),
    entry: (path) => files.has(path) ? { mode: "100644", oid: null } : null,
    text: (path) => files.get(path) ?? null, prefetch: () => {},
  };
}

function roleSources() {
  const root = new URL("../../../../", import.meta.url);
  const configPath = `engine/${ROOT_POLICY.configuration.basename}`;
  const document = getConfigDocumentSchema().parse(decodeConfigDocumentRaw(readFileSync(new URL(configPath, root))));
  assert.ok(document.promotion, "the native fixture declares promotion authority");
  assert.ok(document.workspaceIsolation, "the native fixture declares workspace authority");
  const isolation = document.workspaceIsolation;
  const directory = document.promotion.profileDirectory;
  const profileName = readdirSync(new URL(`${directory}/`, root)).filter((name) => name.endsWith(".json")).sort()[0];
  assert.ok(profileName, "source fixture needs a declared profile");
  const profile = JSON.parse(readFileSync(new URL(`${directory}/${profileName}`, root), "utf8"));
  const files = new Map<string, string>([[MERGE_GUIDE_ROLES.path, `authored before\n${MERGE_GUIDE_ROLES.begin}\nstale body\n${MERGE_GUIDE_ROLES.end}\nauthored after\n`]]);
  for (const name of ["first-pair", "second-pair"]) {
    const pair = structuredClone(profile);
    pair.name = name;
    pair.source.ref = `refs/heads/${name}-source`;
    pair.target.ref = `refs/heads/${name}-target`;
    files.set(`${directory}/${name}.json`, JSON.stringify(pair));
  }
  return { document, isolation, configPath, directory, files };
}

test("merge-guide roles include all configured trunks and every strict profile, identified by source pointers", () => {
  const { document, isolation, configPath, files, directory } = roleSources();
  isolation.landTargets = ["first-trunk", "second-trunk"];
  const facts = mergeGuideRoleFacts(textTree(files), configPath, document);
  assert.deepEqual(facts.rows.map((row) => row.branch), ["first-trunk", "second-trunk", "first-pair-source", "first-pair-target", "second-pair-source", "second-pair-target"]);
  assert.deepEqual(facts.dependencies, [configPath, `${directory}/first-pair.json`, `${directory}/second-pair.json`]);
  const before = files.get(MERGE_GUIDE_ROLES.path)!;
  const projected = projectMergeGuideRoles(textTree(files), facts);
  assert.notEqual(projected, before);
  const oldParts = splitGeneratedBlock(before, MERGE_GUIDE_ROLES)!;
  const parts = splitGeneratedBlock(projected, MERGE_GUIDE_ROLES)!;
  assert.equal(parts.before, oldParts.before);
  assert.equal(parts.after, oldParts.after);
  assert.equal(projected, projectMergeGuideRoles(textTree(files, "/another/machine/tree"), facts), "placement is not an authority");
  const identities = facts.rows.map((row) => row.id);
  isolation.landTargets[0] = "renamed-trunk";
  assert.deepEqual(mergeGuideRoleFacts(textTree(files), configPath, document).rows.map((row) => row.id), identities, "branch spelling is a value, not a row identity");
});

test("merge-guide roles refuse missing, malformed and ambiguous authorities and every missing, repeated or torn marker", () => {
  const { document, isolation, configPath, files, directory } = roleSources();
  const refuses = (action: () => unknown, code: string) => assert.throws(action, (error: unknown) => error instanceof HarnessError && error.code === code);
  const empty = new Map<string, string>([[MERGE_GUIDE_ROLES.path, files.get(MERGE_GUIDE_ROLES.path)!]]);
  refuses(() => mergeGuideRoleFacts(textTree(empty), configPath, document), "merge_guide_roles_profiles_missing");
  const broken = new Map(files);
  broken.set(`${directory}/first-pair.json`, "{");
  refuses(() => mergeGuideRoleFacts(textTree(broken), configPath, document), "promotion_profile_invalid");
  isolation.landTargets = ["duplicate", "duplicate"];
  refuses(() => mergeGuideRoleFacts(textTree(files), configPath, document), "merge_guide_roles_authority_ambiguous");
  isolation.landTargets = ["valid"];
  const facts = mergeGuideRoleFacts(textTree(files), configPath, document);
  for (const body of ["no block", MERGE_GUIDE_ROLES.begin, `${MERGE_GUIDE_ROLES.end}\n${MERGE_GUIDE_ROLES.begin}`, `${MERGE_GUIDE_ROLES.begin}\n${MERGE_GUIDE_ROLES.begin}\n${MERGE_GUIDE_ROLES.end}`]) {
    refuses(() => projectMergeGuideRoles(textTree(new Map([[MERGE_GUIDE_ROLES.path, body]])), facts), "merge_guide_roles_markers_invalid");
  }
  refuses(() => projectMergeGuideRoles(textTree(new Map()), facts), "merge_guide_roles_guide_missing");
});

test("schema-valid omission of either optional role authority is a typed refusal before projection", () => {
  const { document, configPath, files } = roleSources();
  for (const section of ["promotion", "workspaceIsolation"] as const) {
    const omitted = { ...document, [section]: undefined };
    const parsed = getConfigDocumentSchema().parse(omitted);
    assert.throws(() => mergeGuideRoleFacts(textTree(files), configPath, parsed), (error: unknown) =>
      error instanceof HarnessError && error.code === "merge_guide_roles_authority_missing" && error.message.includes(section));
  }
});

test("merge-guide role cells use the existing site literal escaping, including HTML, Liquid, pipes and backticks", () => {
  const value = "<script>|{{unsafe}}`tick`";
  const rendered = renderMergeGuideRoles({ rows: [{ id: "one", role: value, branch: value, path: "profiles/a (b){{x}}.json", pointer: "/source/ref" }], dependencies: [] });
  assert.ok(rendered.includes(`<code>${escapeSiteHtml(value)}</code>`));
  assert.equal(rendered.includes("<script>"), false);
  assert.equal(rendered.includes("{{unsafe}}"), false);
  assert.match(rendered, /a%20%28b%29%7B%7Bx%7D%7D\.json/u);
});
