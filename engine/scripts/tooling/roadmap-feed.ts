/**
 * THE ROADMAP FEED, AT A COMMIT: `roadmap.json` (`bridlewise-roadmap-feed/v1`,
 * src/workflow/forge/projector/roadmap-feed.ts) for the site build and any
 * reader of the roadmap. It is a pure function of the commit, computed in a
 * process confined by this engine's guardian (built:
 * `make -C engine/guardian all`), so the roadmap at ANY commit is this
 * command at that commit. The computation is a whole instrument of the run
 * registry (`projection`): admitted at once under the per-run cgroup caps. A
 * host where it cannot confine or cap is a typed refusal.
 *
 *   node scripts/tooling/roadmap-feed.ts --at <commit> --repository-url https://github.com/<owner>/<repo> [--out <file>] [--minimum-weeks <n>]
 *
 * Without `--out` the feed is the one line it prints. `--minimum-weeks` is how
 * many weeks of shipped history an ETA band needs (default
 * `DEFAULT_ROADMAP_ETA_MINIMUM_WEEKS`, src/workflow/workflow-config.ts).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { computeRoadmapFeed, roadmapFeedInput } from "../../src/workflow/forge/projector/projection.ts";
import { configuredConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { DEFAULT_PROJECTION_CPU_SECONDS, DEFAULT_ROADMAP_ETA_MINIMUM_WEEKS } from "../../src/workflow/workflow-config.ts";
import { keyHomeLocation, openStoreRegistry } from "../../src/filesystem/self-protection/key-home.ts";
import { engineConfigDocumentPath } from "../../src/kernel/config.ts";

function run(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { at: { type: "string" }, "repository-url": { type: "string" }, out: { type: "string" }, "minimum-weeks": { type: "string" } } });
  if (values.at === undefined || values["repository-url"] === undefined) throw new InputError("Usage: roadmap-feed --at <commit> --repository-url <https://github.com/owner/repo> [--out <file>] [--minimum-weeks <n>]", "input_error");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(values["repository-url"])) throw new InputError(`--repository-url ${values["repository-url"]} is not https://github.com/<owner>/<repo>`, "input_error");
  const minimumWeeks = values["minimum-weeks"] === undefined ? DEFAULT_ROADMAP_ETA_MINIMUM_WEEKS : Number(values["minimum-weeks"]);
  if (!Number.isInteger(minimumWeeks) || minimumWeeks < 1) throw new InputError("--minimum-weeks must be a whole number of at least 1", "input_error");
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const repositoryRoot = dirname(engineRoot);
  // Computed confined by the guardian: this engine's, with the host's own keep-out facts (its key home's registry, its config document).
  const confinement = configuredConfinement(resolve(engineRoot), { hostPaths: [engineConfigDocumentPath()], registry: openStoreRegistry(keyHomeLocation()) }, DEFAULT_PROJECTION_CPU_SECONDS);
  const { feed } = computeRoadmapFeed(roadmapFeedInput(configuredGitRepository({}, repositoryRoot), values.at, values["repository-url"], minimumWeeks), confinement);
  const text = `${JSON.stringify(feed)}\n`;
  if (values.out === undefined) {
    process.stdout.write(text);
    return 0;
  }
  const written = atomicWriteFile(resolve(values.out), text);
  if (!written.success) throw new HarnessError(`Failed to write ${values.out}: ${written.reason ?? "unknown error"}`, "roadmap_feed_write_failed");
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
