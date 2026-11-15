/**
 * Repository identity Markdown boundaries shared by the producer and prose view.
 * This protocol has no runtime imports, parser, filesystem or configuration effects.
 * The canonical generated-block type remains in the neutral kernel owner.
 */
import type { GeneratedBlockMarkers } from "../../kernel/verification-paths.ts";

/** The existing identity generator's source, named once for its metadata. */
const REPOSITORY_IDENTITY_GENERATOR = "engine/src/workflow/forge/repository-identity.ts";
function identityBlock(label: string): GeneratedBlockMarkers {
  return Object.freeze({
    begin: `<!-- BEGIN GENERATED: ${label}, from the repository identity (harness sync; ${REPOSITORY_IDENTITY_GENERATOR}) -->`,
    end: `<!-- END GENERATED: ${label} -->`,
  });
}

/** The identity generator's existing protocol, unchanged when shared. */
export const REPOSITORY_IDENTITY_BLOCKS = Object.freeze({
  links: identityBlock("repository links"),
  clone: identityBlock("clone command"),
  variable: identityBlock("repository variable"),
  heading: identityBlock("repository name heading"),
});
