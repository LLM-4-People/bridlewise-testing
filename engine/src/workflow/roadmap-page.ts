/**
 * THE ROADMAP PAGE'S ARM (`ROADMAP_PAGE`, src/kernel/verification-paths.ts):
 * the generated status blocks of `docs/floor/roadmap.md`, rendered from the
 * tracker items by the repository-root generator, run through the one
 * generator protocol. `harness sync`/`check` run it right after the task
 * board, and the IssueOps record writer runs it with the board on every
 * record, both importing it from here: one owner, below both of them.
 */
import { ROADMAP_PAGE } from "../kernel/verification-paths.ts";
import { repositoryGeneratorArm, type DecisionIndexArm } from "./script-subprocess.ts";

/** `harness sync`'s roadmap-page arm: the generated status blocks of `ROADMAP_PAGE.path`, from the tracker items (the repository-root generator). */
export function regenerateRoadmapPage(root: string, write: boolean): DecisionIndexArm {
  return repositoryGeneratorArm(root, ROADMAP_PAGE.generator, (repositoryRoot) => [write ? "--write" : "--check", `--root=${repositoryRoot}`], "the roadmap page generator", "harness_regenerate_roadmap_page_failed");
}
