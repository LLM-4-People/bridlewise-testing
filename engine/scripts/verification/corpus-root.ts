/**
 * WHERE THE PINNED CORPUS IS LINKED: the one spelling of its root.
 *
 * Its own module so a reader of a corpus file (the path-policy source
 * authority in `scripts/generation/repository-path-unicode.ts`) can name the
 * root without importing `corpus.ts`, which reads that authority's manifest —
 * the two would otherwise import each other.
 */

/** Repository-relative path the corpus is linked at (outside the tree; `npm run corpus:fetch`). */
export const CORPUS_ROOT = "engine/large-codebases";

/** The same root relative to the engine package, where engine manifests resolve paths. */
export const CORPUS_ENGINE_ROOT = CORPUS_ROOT.slice("engine/".length);

/** The one command that materialises and links the corpus. */
export const CORPUS_FETCH_COMMAND = "npm run corpus:fetch";
