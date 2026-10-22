/**
 * Shared exposure registrations — `release` module.
 *
 * The product's release train (`harness release`, src/workflow/promotion/
 * release-train.ts): how it departs (`auto`, `manual`, `approval`), the
 * minimum hours between two releases, the profile whose target is the
 * product, the tag prefix and the announcement's Discussions category —
 * each a customization bound to its `promotion.release.*` configuration
 * path. What the train would do now is the `promotion.releaseTrain` signal
 * (the promotion module's installed source: it reads the repository).
 *
 * THE HONEST TIMING: every consumer is the release workflow's engine command
 * (a fresh process per land), so a settings write takes effect at the next
 * land.
 */

import { registerCustomization, registerExposureModule } from "../index.ts";
import { readNumberCustomization, readStringCustomization, writeConfigCustomization } from "../config-binding.ts";
import { RELEASE_TRAIN_MODES } from "../../../kernel/config-contracts.ts";

/** The release train's settings (`promotion.release`): each a customization bound to its configuration path, with the value a new repository starts from. */
const RELEASE_SETTINGS = [
  { key: "train", type: "enum", default: "auto", name: "How the release train departs", description: "auto: a release departs by itself after a land once the product changed, its declared version is new and the minimum interval has passed; manual: only when a person dispatches it; approval: by itself, through an approving reviewer. Takes effect at the next land." },
  { key: "minIntervalHours", type: "number", default: 24, name: "Minimum hours between two releases", description: "A release does not depart sooner than this after the previous one, however many lands come in between. Lower = releases follow lands more closely; higher = fewer, larger releases. Takes effect at the next land." },
  { key: "profile", type: "string", default: "main-to-product", name: "The product's promotion profile", description: "The promotion profile whose target branch is the product the train releases. Takes effect at the next land." },
  { key: "tagPrefix", type: "string", default: "v", name: "What a release's tag begins with", description: "The prefix of a release tag (v names v0.1.0). Takes effect at the next release." },
  { key: "discussionCategory", type: "string", default: "Releases", name: "Release announcement category", description: "The Discussions category a release's announcement is posted in. Takes effect at the next release." },
] as const;

let releaseRegistered = false;
export function registerReleaseExposure(): void {
  if (releaseRegistered) return;
  releaseRegistered = true;

  registerExposureModule({
    id: "release",
    title: "Releasing the product",
    purpose: "When the product departs as an immutable, attested release after a land, and how its tag and announcement are named.",
  });

  for (const setting of RELEASE_SETTINGS) {
    const configPath = `promotion.release.${setting.key}`;
    const common = {
      id: `release.${setting.key}`,
      module: "release",
      name: setting.name,
      description: setting.description,
      set: (value: unknown) => writeConfigCustomization(configPath, value as string | number),
      contract: { audience: "advanced" as const, effect: "next-run" as const },
      configPath,
    };
    if (setting.type === "number") registerCustomization({ ...common, type: "number", default: setting.default, min: 0, max: 8760, unit: "hours", current: () => readNumberCustomization(configPath, setting.default) });
    else if (setting.type === "enum") registerCustomization({ ...common, type: "enum", default: setting.default, enum: [...RELEASE_TRAIN_MODES], current: () => readStringCustomization(configPath, setting.default) });
    else registerCustomization({ ...common, type: "string", default: setting.default, current: () => readStringCustomization(configPath, setting.default) });
  }
}

/** Reset the per-module registration flag (test-only). */
export function resetReleaseRegistration(): void {
  releaseRegistered = false;
}
