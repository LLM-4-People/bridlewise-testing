/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision) for FLAKY-CONFIG-PARENT-CHURN: a pinned-configuration read
 * (engine/src/kernel/config.ts `loadPinnedConfigSnapshot`) that a concurrent
 * test interrupts by creating an entry directly in the engine folder.
 *
 * It holds, deterministically, the window the CI run hit by chance: the first
 * pinned read for the repository identity in this process (the read the CI
 * run lost, `configuredRepositoryIdentity`) is paused between its root snapshot and its
 * parent check (the SECOND directory open of the engine folder that
 * config.ts makes), and it announces the pause with `reader-in-read` in
 * `node_modules/.flake-config-parent-churn/` (the checkout's ignored dependency folder). The pause ends as soon as the
 * engine folder's identity changes (the writer made an entry there: the
 * defect) or the writer announces `writer-done` (it made none and PASSED:
 * fixed). Past a bound with neither, the read fails typed
 * (`flake_shim_writer_absent`): the condition never ran, so the reproduction
 * is invalid, never green. The door's `--during` command runs the writer test
 * once the pause is announced, and announces `writer-done` only if it
 * passed (`&&`). Nothing else is touched: every other open is
 * the real one, and the test and the product are unchanged.
 *
 * Preloaded into the reproduction run's vitest processes (the door's
 * NODE_OPTIONS); never imported by a test.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

const ENGINE = resolve(process.cwd(), "engine");
/** Where the shim and the door's `--during` command signal each other: inside the checkout's (ignored) dependency folder, never the engine folder. */
const SIGNALS = join(process.cwd(), "node_modules", ".flake-config-parent-churn");
/** How long the pause waits for the writer at most: the writer test's own run, with room. */
const HOLD_MS = 120_000;
const realOpen = fs.openSync;
let engineOpens = 0;
let held = false;

/** The read CI interrupted: the pinned configuration, read for the repository identity (roadmap-status-owner's evidence-proof test). */
function heldRead(stack: string): boolean {
  return /kernel\/config\.ts/u.test(stack) && /configuredRepositoryIdentity/u.test(stack);
}

function holdForTheWriter(): void {
  const before = fs.statSync(ENGINE, { bigint: true });
  fs.mkdirSync(SIGNALS, { recursive: true });
  fs.writeFileSync(join(SIGNALS, "reader-in-read"), String(process.pid));
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + HOLD_MS; Date.now() < deadline;) {
    const now = fs.statSync(ENGINE, { bigint: true });
    if (now.mtimeNs !== before.mtimeNs || now.ctimeNs !== before.ctimeNs || now.nlink !== before.nlink) return;
    if (fs.existsSync(join(SIGNALS, "writer-done"))) return;
    Atomics.wait(tick, 0, 0, 50);
  }
  // Neither the defect nor a finished writer: the condition never ran, so this reproduction is invalid, never green.
  throw Object.assign(new Error(`flake_shim_writer_absent: the writer neither changed ${ENGINE} nor announced writer-done within ${String(HOLD_MS)} ms (the --during command did not run the writer to a pass)`), { code: "flake_shim_writer_absent" });
}

fs.openSync = function openedByTheShim(path: fs.PathLike, flags: fs.OpenMode = "r", mode?: fs.Mode | null): number {
  if (!held && typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0 && resolve(String(path)) === ENGINE && heldRead(new Error().stack ?? "")) {
    engineOpens += 1;
    if (engineOpens === 2) {
      held = true;
      holdForTheWriter();
    }
  }
  return realOpen(path, flags, mode);
} as typeof fs.openSync;
syncBuiltinESMExports();
