/**
 * THE FORGE'S CONFIGURATION SECTION (`forge` in `bridlewise.config.json`) —
 * declared here beside the module it steers (the module-exports-its-section
 * idiom; `src/kernel/config-contracts.ts` splices it in). Every value the
 * forge uses that is not GitHub's own protocol comes from here: the
 * organisation, the API and web origins, the request bounds, the repository
 * topology (each repository's `kind`, github-only §2.1) and the local Apps
 * page. There is no default in code: a checkout whose document declares no
 * `forge` section is the typed `forge_not_configured` (its one reader,
 * `configured-forge.ts`). This module imports no configuration reader (the
 * kernel imports it).
 */
import { z } from "zod";

import { deepFreeze, type DeepReadonly } from "../../kernel/integrity.ts";
import type { ForgeRepositoryKind } from "./app-registry.ts";
import type { ForgeEndpoint } from "./port.ts";

/** The `kind` custom property's allowed values (runbook P1.8); `none` is a repository the topology does not govern. */
const FORGE_REPOSITORY_KINDS = deepFreeze(["trunk", "meta", "evidence", "notes", "archive", "none"] as const);

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
  /**
   * How a run of the maintainer's `gh` is bounded: never by the wall clock
   * (the no-load-block rule), only when it stalls (no output and no CPU work
   * for `stallMs`) or passes `cpuLimitMs` of its own CPU time.
   */
  maintainerCli: z.strictObject({
    stallMs: z.number().int().min(1_000).max(3_600_000),
    cpuLimitMs: z.number().int().min(100).max(3_600_000),
    killGraceMs: z.number().int().min(10).max(60_000),
  }),
  /** The local page `harness forge apps create` serves (on 127.0.0.1 only). */
  appsPage: z.strictObject({
    port: z.number().int().min(1_024).max(65_535),
    /**
     * Apps installed before the four (the `claude` App): the page lists the
     * repositories each must be narrowed to until it is uninstalled.
     */
    legacyApps: z.array(z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{1,64}$/u), repositories: z.array(z.string().regex(NAME)) })),
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
