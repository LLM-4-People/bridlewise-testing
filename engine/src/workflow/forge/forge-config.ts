/**
 * THE FORGE'S CONFIGURATION SECTION (`forge` in `bridlewise.config.json`) —
 * declared here beside the module it steers (the module-exports-its-section
 * idiom; `src/kernel/config-contracts.ts` splices it in). Every value the
 * forge uses that is not GitHub's own protocol comes from here: the
 * organisation, the API and web origins, the request bounds, and the
 * repository topology (each repository's `kind`, github-only §2.1). There is
 * no default in code: a checkout whose document declares no `forge` section
 * is the typed `forge_not_configured` (its one reader, `configured-forge.ts`).
 * This module imports no configuration reader (the kernel imports it).
 */
import { z } from "zod";

import { deepFreeze, type DeepReadonly } from "../../kernel/integrity.ts";
import type { ForgeRepositoryKind } from "./app-registry.ts";
import type { ForgeEndpoint } from "./port.ts";

/** The `kind` custom property's allowed values (runbook P1.8); `none` is a repository the topology does not govern. */
export const FORGE_REPOSITORY_KINDS = deepFreeze(["trunk", "meta", "evidence", "notes", "archive", "none"] as const);

const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
/** An https origin with no path, credentials, query or fragment (a pattern, not a `format`: the generated JSON Schema stays enforceable). */
const httpsOrigin = z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/?$/u);

export const FORGE_CONFIG_SCHEMA = z.strictObject({
  /** The GitHub organisation that owns every Bridlewise repository. */
  organization: z.string().regex(ORGANIZATION),
  /** The REST and GraphQL API origin (`https://api.github.com`). */
  apiUrl: httpsOrigin,
  /** The web origin (`https://github.com`): App creation and installation pages. */
  webUrl: httpsOrigin,
  /** The `User-Agent` every request carries (GitHub requires one). */
  userAgent: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/u),
  /** Each request's bounds. */
  request: z.strictObject({
    timeoutMs: z.number().int().min(1_000).max(600_000),
    maxResponseBytes: z.number().int().min(1_024).max(268_435_456),
    cleanupTimeoutMs: z.number().int().min(10).max(60_000),
    etagCacheEntries: z.number().int().min(1).max(100_000),
    /** The most pages one list read follows (a longer list is refused, never truncated). */
    maxPages: z.number().int().min(1).max(1_000),
  }),
  /**
   * PINNED DOWNLOADS (release assets: the history importer's pinned tools).
   * A download starts at `webUrl` and may follow a redirect ONLY to one of
   * `hosts` (exact host names: GitHub serves a release asset from its asset
   * host), at most `maxRedirects` times, within `maxBytes`; its content's
   * sha256 is pinned by the caller and checked before anything runs.
   */
  downloads: z.strictObject({
    hosts: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u)).min(1),
    maxRedirects: z.number().int().min(0).max(10),
    maxBytes: z.number().int().min(1_024).max(268_435_456),
    /** One download's lifetime (the door requires one; a release asset is tens of megabytes). */
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
  }),
  /** An installation token is minted again this long before it expires. */
  tokenRenewBeforeMs: z.number().int().min(0).max(3_000_000),
  /**
   * The repository topology: every Bridlewise repository with its `kind`
   * and visibility. Exactly one `trunk`. A `provingGround` repository gets
   * every App installed (the V-tests, runbook P1.11) until it is archived.
   */
  repositories: z.array(z.strictObject({
    name: z.string().regex(NAME),
    kind: z.enum(FORGE_REPOSITORY_KINDS),
    visibility: z.enum(["public", "private"]),
    provingGround: z.boolean().optional(),
  })).min(1).superRefine((repositories, context) => {
    const names = repositories.map((repository) => repository.name.toLowerCase());
    if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "repository names must be unique" });
    if (repositories.filter((repository) => repository.kind === "trunk").length !== 1) context.addIssue({ code: "custom", message: "exactly one repository is the trunk" });
  }),
});

export type ForgeSettings = DeepReadonly<z.infer<typeof FORGE_CONFIG_SCHEMA>>;
export type ForgeRepository = ForgeSettings["repositories"][number];

/** The trunk repository (the schema guarantees exactly one). */
export function trunkRepository(settings: ForgeSettings): ForgeRepository {
  return settings.repositories.find((repository) => repository.kind === "trunk")!;
}

/** The repositories an App installed on `kinds` is installed on (plus every proving ground). */
export function repositoriesOfKinds(settings: ForgeSettings, kinds: readonly ForgeRepositoryKind[]): readonly ForgeRepository[] {
  return settings.repositories.filter((repository) => repository.provingGround === true || (kinds as readonly string[]).includes(repository.kind));
}

/** The adapter's endpoint, from the section. */
export function forgeEndpoint(settings: ForgeSettings): ForgeEndpoint {
  return deepFreeze({
    apiUrl: settings.apiUrl.replace(/\/$/u, ""),
    allowPrivateAddress: false,
    timeoutMs: settings.request.timeoutMs,
    maxResponseBytes: settings.request.maxResponseBytes,
    cleanupTimeoutMs: settings.request.cleanupTimeoutMs,
    etagCacheEntries: settings.request.etagCacheEntries,
    userAgent: settings.userAgent,
  });
}
