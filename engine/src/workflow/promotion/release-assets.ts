/**
 * THE RELEASE ASSETS — the one list of what a release carries and their
 * names, and the assembly of a release folder from the built inputs
 * (github-only §9.4): the product source tarball (`git archive` of the
 * product commit), the engine bundle, the guardian binary of the platform
 * that built it, the SBOM, the pre-built documentation site for `/v/<version>/`
 * (P4.3), and `SHA256SUMS` over all of them. The release workflow builds the
 * inputs, assembles them here, attests each asset and publishes the release
 * immutable; the names come only from {@link releaseAssetNames}.
 *
 * Every input is required: a missing or empty one refuses the assembly
 * (`promotion_release_assets_incomplete`, naming each), never a smaller release.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { PRODUCT_NAME } from "../../kernel/product-identity.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import { PromotionError } from "./codes.ts";
import type { ReleasePlan } from "./release-train.ts";

/** The built inputs an assembly takes, by role. */
export const RELEASE_INPUTS = deepFreeze(["bundle", "guardian", "sbom", "docsSite"] as const);
export type ReleaseInput = typeof RELEASE_INPUTS[number];

/** The asset name of each role (and of the source tarball and the checksums) for `version` built on `platform` (`<os>-<arch>`). */
export function releaseAssetNames(version: string, platform: string): Readonly<Record<ReleaseInput | "source" | "checksums", string>> {
  const stem = `${PRODUCT_NAME}-${version}`;
  return deepFreeze({
    source: `${stem}-source.tar.gz`,
    bundle: `${stem}-engine-bundle.js`,
    guardian: `${stem}-guardian-${platform}`,
    sbom: `${stem}-sbom.spdx.json`,
    docsSite: `${stem}-docs-site.tar.gz`,
    checksums: "SHA256SUMS",
  });
}

export type AssembledAsset = Readonly<{ name: string; sha256: string; bytes: number }>;

/** Assembles the release folder `out` (absent or empty) for `plan` from `inputs`; answers each asset with its digest, in name order. */
export function assembleRelease(input: Readonly<{
  repository: GitRepository;
  plan: ReleasePlan;
  out: string;
  inputs: Readonly<Partial<Record<ReleaseInput, string>>>;
  platform: string;
}>): readonly AssembledAsset[] {
  const names = releaseAssetNames(input.plan.version, input.platform);
  const missing = RELEASE_INPUTS.filter((role) => {
    const path = input.inputs[role];
    return path === undefined || !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0;
  });
  if (missing.length > 0) throw new PromotionError("promotion_release_assets_incomplete", `the release ${input.plan.tag} lacks ${missing.join(", ")} (each must be a non-empty file)`, { missing });
  const sbom = JSON.parse(readFileSync(input.inputs.sbom!, "utf8")) as { spdxVersion?: unknown };
  if (typeof sbom.spdxVersion !== "string") throw new PromotionError("promotion_release_assets_incomplete", `the SBOM ${input.inputs.sbom!} is not an SPDX document (no spdxVersion)`, { missing: ["sbom"] });
  if (existsSync(input.out) && readdirSync(input.out).length > 0) throw new PromotionError("promotion_release_usage", `the release folder ${input.out} is not empty: assemble into a new folder`, { out: input.out });
  mkdirSync(input.out, { recursive: true });
  gitOutput(input.repository, ["archive", "--format=tar.gz", `--prefix=${PRODUCT_NAME}-${input.plan.version}/`, "-o", join(input.out, names.source), input.plan.product.commit]);
  for (const role of RELEASE_INPUTS) copyFileSync(input.inputs[role]!, join(input.out, names[role]));
  const assets = [names.source, ...RELEASE_INPUTS.map((role) => names[role])].sort().map((name) => {
    const bytes = readFileSync(join(input.out, name));
    return { name, sha256: sha256(bytes), bytes: bytes.length };
  });
  const sums = `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`;
  writeFileSync(join(input.out, names.checksums), sums);
  return deepFreeze([...assets, { name: names.checksums, sha256: sha256(sums), bytes: Buffer.byteLength(sums) }]);
}
