/**
 * The action's post step (#421): it runs after every other step and every
 * other action's post step of the job (post steps run in reverse order, and a
 * post step always runs). It holds no logic of its own: the reaper is
 * `engine/scripts/tooling/end-job-processes.ts`, which finds the job's
 * processes and ends them through the one process owner and the one
 * terminator (`engine/src/process/process-facts.ts`). A job that installed no
 * engine dependencies gets them here first, so every job judges the same way.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const engine = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), "engine");
if (!existsSync(join(engine, "node_modules"))) {
  const install = spawnSync("npm", ["--prefix", engine, "ci", "--no-audit", "--no-fund", "--ignore-scripts"], { stdio: "inherit" });
  if (install.status !== 0) throw new Error(`end-job-processes: the engine's dependencies could not be installed (npm ci exited ${String(install.status)})`);
}
const reaper = spawnSync(process.execPath, [join(engine, "scripts", "tooling", "end-job-processes.ts")], { cwd: engine, stdio: "inherit" });
process.exitCode = reaper.status ?? 1;
