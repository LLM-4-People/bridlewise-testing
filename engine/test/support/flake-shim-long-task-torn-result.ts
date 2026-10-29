/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-long-task-torn-result.ts`, the
 * FLAKE-REPRO decision). It recreates, on every run, what a loaded host did
 * to "long-task-runner: failure path records non-zero exit code" (#716's
 * Engine run, `null !== 7`). The wrapper publishes the result file while its
 * unit is still running. A reader that came between the file's creation
 * (open with O_TRUNC) and its write saw an empty file, took the task for done
 * and read no exit code. Twice in a row, when the writer was descheduled
 * across both of the test's reads.
 *
 * In the test process, while the long-task unit that owns a result file is
 * still in an active state (asked of systemd itself, `systemctl --user show
 * <unit> -p ActiveState`), that result file reads as present and EMPTY: the
 * torn window, held open for as long as it can really exist. Once the unit is
 * terminal, the file reads as it is. A reader that waits for the unit's
 * terminal state never looks inside the window.
 *
 * Never imported by a test.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";

const ACTIVE = new Set(["active", "activating", "deactivating", "reloading"]);

/** The long-task unit whose result file `path` is, while that unit is still in an active state. */
function tornWindowOpen(path: unknown): boolean {
  if (typeof path !== "string" || basename(path) !== "result") return false;
  const unit = basename(dirname(path));
  if (!unit.startsWith("ltr-") || !unit.endsWith(".service")) return false;
  const shown = spawnSync("systemctl", ["--user", "show", unit, "-p", "ActiveState", "--value"], { encoding: "utf8" });
  return shown.status === 0 && ACTIVE.has(shown.stdout.trim());
}

const existsSync = fs.existsSync;
const readFileSync = fs.readFileSync;
fs.existsSync = ((path: fs.PathLike) => tornWindowOpen(path) || existsSync(path)) as typeof fs.existsSync;
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  if (tornWindowOpen(args[0])) {
    const encoded = typeof args[1] === "string" || (typeof args[1] === "object" && args[1] !== null && "encoding" in args[1] && args[1].encoding !== null && args[1].encoding !== undefined);
    return encoded ? "" : Buffer.alloc(0);
  }
  return readFileSync(...args);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
