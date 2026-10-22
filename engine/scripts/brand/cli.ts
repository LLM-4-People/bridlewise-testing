/**
 * THE PUBLIC WORDS' COMMAND — renders each surface from the messaging source
 * and the claims register (render.ts).
 *
 *   node scripts/brand/cli.ts render readme-hero|org-profile|repo-metadata|release-header [--out <file>]
 *       One surface's text (repo-metadata is JSON). GH-7's projector writes
 *       the README block, the org profile and the repository metadata from
 *       these; the release train prepends the release header.
 *
 * `siteData(root, statusPath)` is the site's half: every claim judged at the
 * floor status snapshot's commit, as plain data. The one site builder writes
 * it to `_data/brand.json` right after the floor data
 * (`scripts/floor/site-design.mjs`), and the landing and `/floor/claims/`
 * templates render it.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { decisionStates, readClaims } from "./claims.ts";
import { readMessaging } from "./messaging.ts";
import { brandSite, judgeClaims, orgProfile, readmeHero, releaseHeader, repositoryMetadata, type CheckResult } from "./render.ts";

const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const SURFACES = ["readme-hero", "org-profile", "repo-metadata", "release-header"] as const;

/** The checks and the commit of a floor status document (`bridlewise-floor-status/v1`), refused whole when malformed. */
export function readStatus(path: string): Readonly<{ commit: string; generatedAt: string; checks: readonly CheckResult[] }> {
  const document = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; generatedAt?: unknown; source?: { commit?: unknown }; checks?: unknown };
  if (document.schemaVersion !== "bridlewise-floor-status/v1") throw new InputError(`${path} is not a bridlewise-floor-status/v1 document`, "claims_status_invalid");
  const commit = document.source?.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) throw new InputError(`${path} names no source commit`, "claims_status_invalid");
  if (!Array.isArray(document.checks)) throw new InputError(`${path} carries no checks`, "claims_status_invalid");
  const generatedAt = document.generatedAt;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) throw new InputError(`${path} names no generatedAt time`, "claims_status_invalid");
  const checks = document.checks.map((entry: unknown, index: number) => {
    const c = entry as Record<string, unknown>;
    if (typeof c?.id !== "string" || typeof c.status !== "string") throw new InputError(`${path}: checks[${index}] has no id or status`, "claims_status_invalid");
    return { id: c.id, status: c.status, headSha: typeof c.headSha === "string" ? c.headSha : null, runUrl: typeof c.runUrl === "string" ? c.runUrl : null };
  });
  return { commit, generatedAt, checks };
}

/** The site's data: every claim of the repository at `root` judged at the commit of the floor status snapshot at `statusPath`. */
export function siteData(root: string, statusPath: string): Readonly<Record<string, unknown>> {
  const status = readStatus(statusPath);
  return { ...brandSite(readMessaging(root), judgeClaims(readClaims(root), status.checks, status.commit), status.commit, decisionStates(root)), judgedAt: status.generatedAt };
}

/** One surface's text, rendered from this repository's sources. */
export function renderSurface(root: string, surface: typeof SURFACES[number]): string {
  const messaging = readMessaging(root);
  const claims = readClaims(root);
  switch (surface) {
    case "readme-hero": return `${readmeHero(messaging, claims, decisionStates(root))}\n`;
    case "org-profile": return `${orgProfile(messaging, claims)}\n`;
    case "repo-metadata": return `${JSON.stringify(repositoryMetadata(messaging), null, 2)}\n`;
    case "release-header": return `${releaseHeader(messaging)}\n`;
  }
}

function write(path: string, text: string): void {
  // Served or published files: world-readable.
  const written = atomicWriteFile(path, text, { exactMode: 0o644 });
  if (!written.success) throw new HarnessError(`Failed to write ${path}: ${written.reason ?? "unknown error"}`, "brand_write_failed");
}

function run(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === "render") {
    const [surface, ...flags] = rest;
    if (!(SURFACES as readonly string[]).includes(surface ?? "")) throw new InputError(`Usage: brand render ${SURFACES.join("|")} [--out <file>]`, "input_error");
    const { values } = parseArgs({ args: flags, options: { out: { type: "string" } } });
    const text = renderSurface(REPOSITORY_ROOT, surface as typeof SURFACES[number]);
    if (values.out === undefined) process.stdout.write(text);
    else write(values.out, text);
    return 0;
  }
  throw new InputError(`Usage: brand render ${SURFACES.join("|")} [--out <file>]`, "input_error");
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
