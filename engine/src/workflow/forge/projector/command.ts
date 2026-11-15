/** Read-only host for the existing committed-source, confined generic projector. */
import type { GitRepository } from "../../../git/tree-reader.ts";
import { canonicalHash, deepFreeze } from "../../../kernel/integrity.ts";
import { planProjection, readProjection } from "./apply.ts";
import type { ProjectorConfinement } from "./confined.ts";
import { PROJECTION_CLASSES } from "./model.ts";
import { computeProjection, projectionInput } from "./projection.ts";
import type { ProjectionStore } from "./store.ts";
import type { RepositoryIdentity } from "../repository-identity.ts";

export type ProjectionPreviewOptions = Readonly<{
  repository: GitRepository;
  source: string;
  ledger: string | null;
  identity: Pick<RepositoryIdentity, "fullName" | "webUrl">;
  confinement: () => ProjectorConfinement;
  /** Acquired after source computation succeeds, so a refused source needs no credential or live read. */
  store: () => Promise<Pick<ProjectionStore, "read">>;
}>;

/** Candidate differences only: no previous receipt, foreign-edit judgment, apply permission or complete board coverage. */
export async function previewProjection(options: ProjectionPreviewOptions) {
  const input = projectionInput(options.repository, options.source, options.ledger, options.identity.webUrl);
  const { projection, digest } = computeProjection(input, options.confinement());
  const { classes, adoptions, live } = await readProjection(projection, {
    read: async (requested, adopted) => requested.length === 0 ? [] : (await options.store()).read(requested, adopted),
  }, null);
  const plan = planProjection(projection, live);
  return deepFreeze({
    kind: "projection-preview" as const,
    observationCompleted: true as const,
    complete: false as const,
    repository: { fullName: options.identity.fullName, webUrl: input.repositoryUrl },
    sourceCommit: input.source,
    ledgerCommit: input.ledger,
    desiredDigest: digest,
    observedDigest: canonicalHash(live),
    desiredObjects: projection.objects.length,
    observedObjects: live.length,
    candidateChanges: plan.writes.map((write) => ({
      phase: write.phase, kind: write.kind, class: write.class, key: write.key,
      fields: Object.keys(write.fields).sort(), fieldsDigest: canonicalHash(write.fields),
    })),
    orphanKeys: plan.orphans,
    coverage: {
      implementedClasses: PROJECTION_CLASSES,
      requestedClasses: classes,
      observedClasses: PROJECTION_CLASSES.filter((name) => live.some((object) => object.class === name)),
      requestedAdoptions: adoptions.size,
      liveRead: classes.length === 0 ? "notRequested" as const : "completed" as const,
      adoptionEstablishment: "unknown" as const,
      previousReceipt: "notProvided" as const,
      foreignEdits: "unknown" as const,
      committedLedger: input.ledger === null ? "notProvided" as const : "readAtCommit" as const,
      project: "notImplemented" as const,
      pullRequests: "notImplemented" as const,
      liveMainHealth: "unknown" as const,
      cpu: "unknown" as const,
    },
  });
}
