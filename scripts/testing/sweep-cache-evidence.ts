/**
 * SWEEP THE MOVED-ASIDE VITEST CACHES — the documented manual command.
 *
 * After any integration-side edit, the web module cache is MOVED aside, not
 * cleared (`mv node_modules/.experimental-vitest-cache{,.evidence-$(date +%s)}`)
 * — a rename is a functionally identical clear that keeps the evidence for
 * whoever needs to inspect a poisoned entry. The cost is that the evidence
 * accumulates: nine `.evidence-*` directories (several GB of compiled
 * modules) had piled up before this sweep existed, and nothing else will
 * ever delete them.
 *
 * This keeps the NEWEST few and removes the rest. Newest-first because an
 * investigation only ever wants the cache from the most recent poisoning;
 * an evidence directory nobody has opened in days is a disk bill, not
 * evidence. Deliberately a MANUAL command (`npm run cache:evidence:sweep`),
 * not a hook: an automatic deletion racing a concurrent investigation is
 * exactly the kind of invisible mutation §27 warns about, and the accrual
 * rate (one directory per cross-repo edit round) does not need automation.
 *
 * Usage:
 *   npm run cache:evidence:sweep            # keep the newest 3
 *   npm run cache:evidence:sweep -- --keep 5
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";

const DEFAULT_KEEP = 3;

function keepCount(argv: readonly string[]): number {
  const at = argv.indexOf("--keep");
  if (at === -1) return DEFAULT_KEEP;
  const raw = argv[at + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--keep needs a non-negative integer, got: ${raw ?? "(nothing)"}`);
  }
  return parsed;
}

/**
 * Any MOVED-ASIDE copy of the cache: the live directory's name (or the short
 * `.evc` spelling some rounds used) plus a dot and a label. The label is free
 * text: the standard remedy's is `evidence-<epoch>`, and rounds wrote others
 * (`evidence-cache-worker-intent-…`, `f2g-<epoch>`) — the first version of
 * this rule required a trailing epoch and matched 9 of the 237 copies on disk
 * (measured 2026-09-30). The live cache itself (no suffix) never matches.
 */
export function isMovedAsideCache(name: string): boolean {
  return /^\.(?:experimental-vitest-cache|evc)\..+$/u.test(name);
}

function sweep(nodeModules: string, keep: number): void {
  const found = readdirSync(nodeModules)
    .filter(isMovedAsideCache)
    .map((name) => ({ name, mtimeMs: statSync(join(nodeModules, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = found.slice(0, keep);
  for (const dir of found.slice(keep)) {
    rmSync(join(nodeModules, dir.name), { recursive: true, force: true });
    process.stdout.write(`swept ${dir.name}\n`);
  }
  process.stdout.write(
    `kept ${String(kept.length)} of ${String(found.length)} moved-aside cache ` +
      `directories (newest ${String(keep)}): ${kept.map((d) => d.name).join(", ") || "(none)"}\n`,
  );
}

if (isEntryPoint(import.meta.url)) sweep(join(process.cwd(), "node_modules"), keepCount(process.argv.slice(2)));
