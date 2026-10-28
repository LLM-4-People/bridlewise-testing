/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-concurrent-owner-sweep.ts`, the
 * FLAKE-REPRO decision). It recreates, on any machine and every run, what a
 * full engine run does at random: ANOTHER test file's process creates its
 * first repository-local fixture (`test/support/repository-local-temporary.ts`)
 * — and so sweeps every `owner-*` root whose owner is dead — in the moment
 * between a test killing an owner and the test looking at that owner's root.
 *
 * In the test process it wraps `fs.existsSync`: the first look at a path
 * under an owned root whose owning process is DEAD first runs, in a separate
 * node process, one ordinary repository-local creation (as any other test
 * file would), then answers the look.
 *
 * Never imported by a test.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// THE CHECKOUT UNDER TEST, not this shim's own: the door preloads the shim
// from the top repository into a private checkout of each revision, and a
// test file runs with its engine root as cwd. The other "test file" must
// create under THAT checkout's fixture root, or it sweeps another one.
const ENGINE_ROOT = process.cwd();
const SUPPORT = pathToFileURL(join(ENGINE_ROOT, "test", "support", "repository-local-temporary.ts")).href;
/** An owned root's name: `<prefix>owner-<pid>-<start time>-<nonce>` (src/filesystem/private-state.ts). */
const OWNED_ROOT = /\/(?:[a-z0-9-]*-)?owner-(\d+)-\d+-[0-9a-f]+(?:\/|$)/u;
const swept = new Set<string>();

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const existsSync = fs.existsSync;
fs.existsSync = ((path: fs.PathLike) => {
  const text = String(path);
  const owner = OWNED_ROOT.exec(text);
  if (owner !== null && !swept.has(owner[0]) && dead(Number(owner[1]))) {
    swept.add(owner[0]);
    const other = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(SUPPORT)}); m.createRepositoryLocalTemporaryDirectory("flake-shim-"); m.removeRepositoryLocalTemporaryRoot();`], { cwd: ENGINE_ROOT, encoding: "utf8" });
    if (other.status !== 0) throw new Error(`flake-shim-concurrent-owner-sweep: the other test file's creation failed: ${other.stderr}`);
  }
  return Reflect.apply(existsSync, fs, [path]) as boolean;
}) as typeof fs.existsSync;
syncBuiltinESMExports();
