/**
 * THE TREE'S DECLARED KIND — the promotion's one answer to "is this checkout
 * the product projection or a source tree?", asked by every gate that belongs
 * to the source tree's testing floor (the architecture-judge ratchet).
 *
 * A DECLARATION, never an inference from what is missing: the product
 * projection carries `TREE-KIND.txt` at its root, shipped by the profile's
 * overlay (`product-only/TREE-KIND.txt`, its whole text `product`). A tree
 * without it is a source tree, so a source checkout that loses a file (S1,
 * a baseline) never reads as the product — its gate refuses instead. And a
 * tree that holds promotion profiles is the source the projection is computed
 * FROM: it carrying the declaration is a contradiction, refused by name, so a
 * testing checkout can never declare itself the product.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";

/** The declaration a product projection carries at its root (from the overlay `product-only/`). */
export const PRODUCT_TREE_DECLARATION = "TREE-KIND.txt";

/** Its whole text. */
const PRODUCT_TREE_DECLARATION_TEXT = "product\n";

export type TreeKind = "source" | "product";

/**
 * The declared kind of the tree at `repositoryRoot`. `profileDirectory` is
 * where a source tree holds its promotion profiles (`promotion.profileDirectory`).
 */
export function declaredTreeKind(repositoryRoot: string, profileDirectory: string): TreeKind {
  const declaration = join(repositoryRoot, PRODUCT_TREE_DECLARATION);
  if (!existsSync(declaration)) return "source";
  if (readFileSync(declaration, "utf8") !== PRODUCT_TREE_DECLARATION_TEXT) {
    throw new InputError(`${PRODUCT_TREE_DECLARATION} declares no tree kind this harness knows (its whole text is "product")`, "tree_kind_declaration_invalid");
  }
  if (existsSync(join(repositoryRoot, profileDirectory))) {
    throw new InputError(`this tree holds promotion profiles (${profileDirectory}/), so it is a source tree, yet it declares itself the product (${PRODUCT_TREE_DECLARATION}): remove the declaration`, "tree_kind_contradicted");
  }
  return "product";
}
