/**
 * THE LABELS, DECLARED ONCE (github-only §9.2, §10.3): `docs/community/labels.json`
 * is the ONE declaration of every repository label but the `area:` ones (which
 * the forge derives from its areas table): the community's (`good first
 * issue`, `help wanted`, which the contributor pages link and GitHub's
 * `/contribute` page lists), the ones Dependabot applies (`dependencies`,
 * `javascript`), the lane labels and the forge's own markers. Each carries its
 * colour and description; issue forms set no label.
 *
 * `harness forge apply` is the one writer (the forge reads this file the way it
 * reads the intake registry and the role table) and `harness forge plan` /
 * `audit` the one drift report; `harness check` refuses a file that cannot
 * mean anything (a colour GitHub would not store, a name declared twice —
 * GitHub compares names without case).
 */
import { z } from "zod";

import { schemaId } from "../../kernel/product-identity.ts";
import { readCommunitySource } from "./sources.ts";

export const LABELS_PATH = "docs/community/labels.json";

const LABEL = z.strictObject({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^[0-9a-f]{6}$/u, "a six-digit lower-case hex colour, as GitHub stores it"),
  description: z.string().max(100),
});
const LABELS = z.strictObject({
  schema: z.literal(schemaId("community-labels", 1)),
  labels: z.array(LABEL).min(1).refine((labels) => new Set(labels.map((label) => label.name.toLowerCase())).size === labels.length, "a label is declared once (GitHub compares names without case)"),
});

export type DeclaredLabel = z.infer<typeof LABEL>;

/** The declared labels, validated (`community_source_invalid` otherwise). */
export function readLabels(repositoryRoot: string): readonly DeclaredLabel[] {
  return readCommunitySource(repositoryRoot, LABELS_PATH, LABELS).labels;
}
