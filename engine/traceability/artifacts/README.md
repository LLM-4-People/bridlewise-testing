# Traceability artifacts

Generated manifests the verification gates consume.

## What each file does

- `artifacts/manifest.json` — the **canonical important-artifact inventory**
  (`ROOT_POLICY.artifactGovernance.canonicalInventory`): every regular file
  under the package's governed roots (`traceability/`, `verification/`; the
  public floor's human `docs/` root sits at the repository root and is not part
  of the engine package), with its owner, type, provenance links, content
  classification and integrity digest.

## Where it lives and what consumes it

The folder lives at `engine/traceability/artifacts/`. `artifactAdmissionViolations`
(the S1 structure check and the candidate verifier) reads the manifest, and
`harness check` refuses a manifest that differs from a fresh build over the
governed roots.

## Regeneration

`engine/scripts/tooling/artifact-manifest.ts` is the ONE producer. It builds the
manifest from the governed roots' repository listing, content-addressed against
the previous manifest's recorded origins, and writes only when the document
changed:

```bash
node scripts/tooling/artifact-manifest.ts --check   # stale => exit 1
node scripts/tooling/artifact-manifest.ts --write   # rewrite through the owner
```

`harness regenerate` / `harness sync` run the write arm as their last step (after
every other generator has finished rewriting governed files), and
`harness check` runs the check arm. Never hand-edit the manifest.
