/** Build the real production Flow replay without starting the app or a provider. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { demoBuildConfig } from "../vite.demo.config.ts";
import { codingFixtureRecording } from "./demo-fixture.ts";
import { publicFixture } from "../src/demo/fixture.ts";
import { isReplayMapping as mapping, type PublicReplay, type ReplayCheck, type ReplaySource } from "../src/demo/replay.ts";
import { canonicalJson, sha256 } from "../engine/src/kernel/integrity.ts";
import { loadPinnedConfigSnapshot } from "../engine/src/kernel/config.ts";
import { configuredWorktreeGitPort } from "../engine/src/git/worktree-port.ts";
import { worktreeOperationTimeouts } from "../engine/src/workflow/workflow-config.ts";
import { identityOverlapIndex, resolveLocation } from "../engine/src/filesystem/path-identity.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";
// @ts-expect-error -- the established floor owner is plain Node ESM.
import { STATUS_SCHEMA } from "./floor/status.mjs";
// @ts-expect-error -- the established identity owner is plain Node ESM.
import { generatedRepositoryIdentity } from "./floor/repository.mjs";
import { FONT_LICENCE } from "./vendor-fonts.ts";
import { SITE_FONT_PATH } from "../shared/site-page.ts";
// @ts-expect-error -- the existing source publish-plan owner is plain Node ESM.
import { sitePlan } from "./floor/site-pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Read the existing floor snapshot; never acquire GitHub data a second way. */
export function demoGithubEvidence(value: unknown, source: ReplaySource): PublicReplay["github"] {
  if (!mapping(value) || value["schemaVersion"] !== STATUS_SCHEMA || !mapping(value["source"]) || value["source"]["commit"] !== source.commit || value["source"]["repository"] !== source.repository) {
    throw new TypeError("The floor snapshot does not describe the replay's source revision");
  }
  if (typeof value["generatedAt"] !== "string" || !Array.isArray(value["checks"])) throw new TypeError("The floor snapshot has no observation time or checks");
  const observation = value["github"];
  if (!mapping(observation) || typeof observation["available"] !== "boolean" || typeof observation["checkedAt"] !== "string" || !Number.isFinite(Date.parse(observation["checkedAt"]))) throw new TypeError("The floor snapshot has no declared GitHub observation");
  if (!observation["available"]) {
    if (typeof observation["reason"] !== "string" || observation["reason"].trim().length === 0) throw new TypeError("Unavailable floor observations need their declared reason");
    return { sourceCommit: source.commit, availability: "unavailable", attemptedAt: observation["checkedAt"], reason: observation["reason"] };
  }
  const checks: ReplayCheck[] = [];
  for (const check of value["checks"]) {
    if (!mapping(check) || typeof check["label"] !== "string" || typeof check["status"] !== "string") throw new TypeError("Malformed floor check");
    const url = check["runUrl"];
    if (url !== null && url !== undefined && typeof url !== "string") throw new TypeError("Malformed floor check URL");
    checks.push({ title: check["label"], status: check["status"], url: typeof url === "string" ? url : null });
  }
  return { sourceCommit: source.commit, availability: "observed", observedAt: observation["checkedAt"], checks };
}

/** A new output only: no existing directory, checkout or ancestor is removed. */
export async function buildDemo(options: Readonly<{ root?: string; out: string; baseurl: string; statusFile?: string }>): Promise<Readonly<{ out: string; record: PublicReplay; fixtureSha256: string }>> {
  const root = resolveLocation(resolve(options.root ?? ROOT), "demo source checkout");
  const out = resolveLocation(resolve(options.out), "demo output");
  if (identityOverlapIndex().overlaps(root, out) || existsSync(out)) throw new TypeError("The demo output must be a new directory outside the checkout");
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/u.test(options.baseurl)) throw new TypeError("The demo needs its explicit site-relative deployment path");
  const identity = generatedRepositoryIdentity(root);
  const document = loadPinnedConfigSnapshot().document;
  const git = configuredWorktreeGitPort(document);
  const timeouts = worktreeOperationTimeouts(document);
  const source: ReplaySource = {
    repository: identity.fullName,
    repositoryUrl: identity.webUrl,
    commit: git.revParse(root, "HEAD", timeouts.inspectMs),
    dirty: git.status(root, timeouts.inspectMs).length !== 0,
    builtAt: new Date().toISOString(),
  };
  const github = options.statusFile === undefined ? null : demoGithubEvidence(JSON.parse(readFileSync(options.statusFile, "utf8")), source);
  const record = publicFixture(source, codingFixtureRecording(dirname(out)), github);
  const plan = sitePlan({ root });
  const demoPage = plan.bySource.get("src/demo/index.html");
  if (plan.collisions.length > 0 || demoPage?.output !== true) throw new TypeError("The demo needs its admitted entry in the source publish plan");
  // Relative to the admitted artifact: preview prefixes and renamed routes use the same plan.
  const pageHref = (sourceId: string): string => {
    const page = plan.bySource.get(sourceId);
    if (page?.output !== true) throw new TypeError(`The demo destination is not published: ${sourceId}`);
    return (posix.relative(demoPage.permalink, page.permalink) || ".") + (page.permalink.endsWith("/") ? "/" : "");
  };
  const workspaceHref = pageHref("docs/quickstart.md");
  const homePage = plan.byPermalink.get("/");
  if (homePage === undefined) throw new TypeError("The demo needs the admitted site home");
  const homeHref = pageHref(homePage.docsPath);
  mkdirSync(out, { mode: 0o700 });
  await build(demoBuildConfig({ root, out, baseurl: options.baseurl, record, workspaceHref, homeHref }));
  copyFileSync(resolve(root, FONT_LICENCE.source), resolve(out, SITE_FONT_PATH, FONT_LICENCE.file));
  const fixture = `${canonicalJson(record)}\n`;
  const fixtureSha256 = sha256(fixture);
  writeFileSync(resolve(out, "public-replay.json"), fixture);
  writeFileSync(resolve(out, "replay-manifest.json"), `${canonicalJson({ schemaVersion: "bridlewise-public-replay-manifest/v1", source, entry: "index.html", connections: "none", fixture: { path: "public-replay.json", sha256: fixtureSha256 } })}\n`);
  return { out, record, fixtureSha256 };
}

/** Trusted source builders for the live-site assembler; no uploaded bundle or command is accepted. */
export const PUBLIC_REPLAY_BUILDERS = Object.freeze({ "src/demo/index.html": buildDemo });

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !["--out", "--baseurl", "--status"].includes(key) || values.has(key)) throw new TypeError("Usage: build-demo.ts --out <new directory> --baseurl <deployment path> [--status <floor snapshot>]");
    values.set(key, value);
  }
  const out = values.get("--out");
  const baseurl = values.get("--baseurl");
  const statusFile = values.get("--status");
  if (out === undefined || baseurl === undefined) throw new TypeError("The demo needs --out and --baseurl");
  const result = await buildDemo({ out, baseurl, ...(statusFile === undefined ? {} : { statusFile }) });
  process.stdout.write(`${JSON.stringify({ out: result.out, source: result.record.source, fixtureSha256: result.fixtureSha256 })}\n`);
}
