/**
 * THE ONE READER of this checkout's `forge` section, and the client a
 * process builds from it: `configuredForgeSection()` answers the section or
 * its absence (the `harness regenerate` arm, which converges a checkout
 * without one by absence), `configuredForge()` the section or
 * `forge_not_configured`, `configuredForgeClient(credential)` the forge
 * port over its endpoint. Every entry point that talks to GitHub (the
 * `harness forge` verbs, the floor scripts) builds its client here.
 */
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { ForgeError } from "./codes.ts";
import { forgeEndpoint, type ForgeSettings } from "./forge-config.ts";
import { githubClient } from "./github.ts";
import type { ForgeClient, ForgeCredential } from "./port.ts";

/** The `forge` section of this checkout's configuration, or undefined when it declares none. */
export function configuredForgeSection(): ForgeSettings | undefined {
  return loadPinnedConfigSnapshot().document.forge;
}

/** The `forge` section of this checkout's configuration, or `forge_not_configured`. */
export function configuredForge(): ForgeSettings {
  const section = configuredForgeSection();
  if (section === undefined) throw new ForgeError("forge_not_configured", "bridlewise.config.json declares no `forge` section.", {});
  return section;
}

/** The forge port over the configured endpoint, as `credential`'s principal. */
export function configuredForgeClient(credential: ForgeCredential): ForgeClient {
  return githubClient(forgeEndpoint(configuredForge()), credential);
}
