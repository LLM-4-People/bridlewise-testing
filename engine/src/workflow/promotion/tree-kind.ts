/**
 * THE TREE'S DECLARED KIND — the promotion's one answer to "is this checkout
 * the product projection or a source tree?", asked by every gate that belongs
 * to the source tree's testing floor (the architecture-judge ratchet).
 *
 * The product projection DECLARES itself: it carries `TREE-KIND.txt` at its
 * root (its whole text `product`), shipped by the profile's overlay
 * (`product-only/TREE-KIND.txt`). A declaration alone proves nothing — a
 * source checkout could add one — so the product is the tree that carries the
 * declaration AND none of the testing floor's facts (the testing-floor paths
 * a projection strips: the structural judge, the test trees, the baselines,
 * the promotion profiles). A tree that carries the declaration beside any of
 * them is CONTRADICTED: it is judged as the source tree it is, and the
 * contradiction is reported for its gate to refuse. A tree without the
 * declaration is a source tree. Nothing is ever inferred from what a tree
 * lacks alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";

/** The declaration a product projection carries at its root (from the overlay `product-only/`). */
export const PRODUCT_TREE_DECLARATION = "TREE-KIND.txt";

/** Its whole text. */
const PRODUCT_TREE_DECLARATION_TEXT = "product\n";

export type TreeKind = Readonly<{
  kind: "source" | "product";
  /** The testing-floor facts present beside a product declaration: non-empty means the declaration is a contradiction. */
  contradiction: readonly string[];
}>;

/**
 * The declared kind of the tree at `repositoryRoot`. `testingFloor` lists the
 * repository-relative paths only a source tree holds (its owner passes them:
 * the structural judge, the test trees, the baselines, the profile directory).
 */
export function declaredTreeKind(repositoryRoot: string, testingFloor: readonly string[]): TreeKind {
  const declaration = join(repositoryRoot, PRODUCT_TREE_DECLARATION);
  if (!existsSync(declaration)) return Object.freeze({ kind: "source", contradiction: Object.freeze([]) });
  if (readFileSync(declaration, "utf8") !== PRODUCT_TREE_DECLARATION_TEXT) {
    throw new InputError(`${PRODUCT_TREE_DECLARATION} declares no tree kind this harness knows (its whole text is "product")`, "tree_kind_declaration_invalid");
  }
  const present = testingFloor.filter((path) => existsSync(join(repositoryRoot, path)));
  return Object.freeze({ kind: present.length === 0 ? "product" : "source", contradiction: Object.freeze(present) });
}
