/**
 * THE PUBLIC WORDS' COMMAND — renders each surface from the messaging source
 * and the claims register (render.ts).
 *
 *   node scripts/brand/cli.ts render readme-hero|org-profile|repo-metadata|release-header [--out <file>]
 *       One surface's text (repo-metadata is JSON). GH-7's projector writes
 *       the README block, the org profile and the repository metadata from
 *       these; the release train prepends the release header.
 *   node scripts/brand/cli.ts build --site <assembled site> --checks <status.json>
 *       The claims page (`<site>/floor/claims/index.md`), every claim judged
 *       at the snapshot's commit; run by the Pages build after the floor data.
 *   node scripts/brand/cli.ts sync --write|--check
 *       THE HARNESS ARM (`harness sync` writes, `harness check` judges): both
 *       sources validated whole — every cited proof path exists, every
 *       decision named is a record — and each front door's generated block
 *       (`FRONT_DOORS`: the README, the site home) rendered from them. One
 *       JSON line, the generator protocol: `{allCurrent, status, changed,
 *       problems}`, `status` "refused" with the problems when a source is
 *       invalid, so a pull request that breaks a source fails the required
 *       check instead of the Pages build on main.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { decisionStates, readClaims } from "./claims.ts";
import { readMessaging } from "../../src/workflow/messaging.ts";
import { claimsSitePage, FRONT_DOORS, judgeClaims, orgProfile, readmeHero, releaseHeader, repositoryMetadata, type CheckResult } from "./render.ts";

const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const SURFACES = ["readme-hero", "org-profile", "repo-metadata", "release-header"] as const;

/** The checks and the commit of a floor status document (`bridlewise-floor-status/v1`), refused whole when malformed. */
export function readStatus(path: string): Readonly<{ commit: string; checks: readonly CheckResult[] }> {
  const document = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; source?: { commit?: unknown }; checks?: unknown };
  if (document.schemaVersion !== "bridlewise-floor-status/v1") throw new InputError(`${path} is not a bridlewise-floor-status/v1 document`, "claims_status_invalid");
  const commit = document.source?.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) throw new InputError(`${path} names no source commit`, "claims_status_invalid");
  if (!Array.isArray(document.checks)) throw new InputError(`${path} carries no checks`, "claims_status_invalid");
  const checks = document.checks.map((entry: unknown, index: number) => {
    const c = entry as Record<string, unknown>;
    if (typeof c?.id !== "string" || typeof c.status !== "string") throw new InputError(`${path}: checks[${index}] has no id or status`, "claims_status_invalid");
    return { id: c.id, status: c.status, headSha: typeof c.headSha === "string" ? c.headSha : null, runUrl: typeof c.runUrl === "string" ? c.runUrl : null };
  });
  return { commit, checks };
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

type SyncReport = Readonly<{ allCurrent: boolean; status: "current" | "regenerated" | "stale" | "refused"; changed: readonly string[]; problems: readonly string[] }>;

/** The text of `path` with its generated block set to `block`; null when the file carries no single block between `begin` and `end`. */
export function withFrontBlock(text: string, begin: string, end: string, block: string): string | null {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from < 0 || to < from || text.indexOf(begin, from + 1) >= 0) return null;
  return `${text.slice(0, from + begin.length)}\n${block}\n${text.slice(to)}`;
}

/** Validates both sources and renders every front door; with `write`, rewrites a stale block. A broken source or a missing block is `refused`, never skipped. */
export function syncFrontDoors(root: string, write: boolean): SyncReport {
  // Each file once, with every block it carries set in turn (a page may hold more than one front-door block).
  const rendered: { path: string; next: string; current: string }[] = [];
  const missing: string[] = [];
  try {
    const messaging = readMessaging(root);
    const claims = readClaims(root);
    const decisions = decisionStates(root);
    for (const path of [...new Set(FRONT_DOORS.map((door) => door.path))]) {
      const file = join(root, path);
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      let next = current;
      for (const door of FRONT_DOORS.filter((d) => d.path === path)) {
        const set = withFrontBlock(next, door.begin, door.end, door.render(messaging, claims, decisions));
        if (set === null) missing.push(`${path} carries no single generated block between "${door.begin}" and "${door.end}"`);
        else next = set;
      }
      rendered.push({ path, current, next });
    }
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return { allCurrent: false, status: "refused", changed: [], problems: [`${error.code}: ${error.message}`] };
  }
  if (missing.length > 0) return { allCurrent: false, status: "refused", changed: [], problems: missing };
  const changed = rendered.filter((r) => r.next !== r.current);
  if (write) for (const r of changed) writeFile(join(root, r.path), r.next);
  return { allCurrent: changed.length === 0 || write, status: changed.length === 0 ? "current" : write ? "regenerated" : "stale", changed: changed.map((r) => r.path), problems: [] };
}

function writeFile(path: string, text: string): void {
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
    else writeFile(values.out, text);
    return 0;
  }
  if (command === "build") {
    const { values } = parseArgs({ args: rest, options: { site: { type: "string" }, checks: { type: "string" } } });
    if (values.site === undefined || values.checks === undefined) throw new InputError("brand build needs --site and --checks", "input_error");
    const status = readStatus(values.checks);
    const judged = judgeClaims(readClaims(REPOSITORY_ROOT), status.checks, status.commit);
    writeFile(join(values.site, "floor", "claims", "index.md"), claimsSitePage(readMessaging(REPOSITORY_ROOT), judged, status.commit, decisionStates(REPOSITORY_ROOT)));
    process.stdout.write(`${JSON.stringify({ commit: status.commit, claims: judged.length, retracted: judged.filter((j) => j.verdict === "retracted").map((j) => j.claim.id) })}\n`);
    return 0;
  }
  if (command === "sync") {
    const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" }, check: { type: "boolean" } } });
    if (values.write === values.check) throw new InputError("brand sync needs exactly one of --write or --check", "input_error");
    const report = syncFrontDoors(REPOSITORY_ROOT, values.write === true);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.allCurrent ? 0 : 1;
  }
  throw new InputError(`Usage: brand render ${SURFACES.join("|")} [--out <file>] | build --site <dir> --checks <status.json> | sync --write|--check`, "input_error");
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
