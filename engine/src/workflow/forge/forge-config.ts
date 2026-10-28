/**
 * THE FORGE'S CONFIGURATION SECTION (`forge` in `bridlewise.config.json`) —
 * declared here beside the module it steers (the module-exports-its-section
 * idiom; `src/kernel/config-contracts.ts` splices it in). Every value the
 * forge uses that is not GitHub's own protocol comes from here: the
 * organisation, the API and web origins, the request bounds, the repository
 * topology (each repository's `kind`, github-only §2.1), the local Apps page,
 * and what the declarations are made of (the stage, the plan, the merge
 * queue, the areas, labels, autolinks, Dependabot, the Project, the retired
 * objects). There is no default in code: a checkout whose document declares no
 * `forge` section is the typed `forge_not_configured` (its one reader,
 * `configured-forge.ts`). This module imports no configuration reader (the
 * kernel imports it).
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
  /** The uploads origin (`https://uploads.github.com`): release assets are uploaded there as raw bodies. */
  uploadsUrl: httpsOrigin,
  /**
   * The origins a release-asset download may be redirected to. GitHub answers
   * an asset's bytes with a redirect to a signed URL on its asset hosts. The
   * client asks that location itself, without the API credential, and only
   * when its origin is listed here.
   */
  assetOrigins: z.array(httpsOrigin).min(1).max(8),
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
    /** The largest release asset uploaded or downloaded (GitHub's own limit is 2 GiB). */
    maxAssetBytes: z.number().int().min(1_024).max(2_147_483_648),
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
    /** A branch the repository protects from deletion and force-pushes by its own ruleset (`protect-<branch>`; the notes repository's working branch). */
    protectedBranch: z.string().regex(/^[A-Za-z0-9._\/-]{1,100}$/u).optional(),
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
  /**
   * Where the migration is (github-only §3.2, runbook P3.7): `p0` keeps the
   * P0 required contexts, no approval and no signature requirement; `door`
   * is the flip — the one required check `bridlewise/door` from the door App,
   * one verifier approval, signed commits. `harness forge apply` sends it.
   */
  stage: z.enum(["p0", "door"]),
  /** What the organisation's plan allows: a field it does not is recorded `unavailable_on_plan`, never written. */
  plan: z.strictObject({
    name: z.enum(["free", "team", "enterprise"]),
    /** The Secret Protection add-on (custom patterns, validity checks, generic secrets, delegated bypass). */
    secretProtection: z.boolean(),
  }),
  /** The maintainer's login (the `rotation` environment's reviewer). */
  maintainer: z.string().regex(ORGANIZATION),
  /** The P0 required contexts (runbook P0.2), kept on the trunk until the flip. */
  p0RequiredChecks: z.array(z.strictObject({ context: z.string().min(1).max(255), integrationId: z.number().int().positive() })).min(1),
  /** The merge queue's parameters (runbook P0.10; the build concurrency is measured, github-only §3.2). */
  mergeQueue: z.strictObject({
    maxEntriesToBuild: z.number().int().min(1).max(20),
    minEntriesToMerge: z.number().int().min(1).max(100),
    maxEntriesToMerge: z.number().int().min(1).max(100),
    minEntriesToMergeWaitMinutes: z.number().int().min(0).max(360),
    checkResponseTimeoutMinutes: z.number().int().min(1).max(360),
  }),
  /**
   * The areas of the repository, each with the paths it owns: the ONE table
   * the `area:` labels, the Area issue field and CODEOWNERS are generated from.
   */
  areas: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    description: z.string().min(1).max(100),
    /** The `area:<id>` label's colour (six hex digits). */
    color: z.string().regex(/^[0-9a-f]{6}$/u),
    paths: z.array(z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*(?:[A-Za-z0-9._-]+)?$/u)).min(1),
  })).min(1),
  /** Labels beyond the `area:` ones (lanes, workflow markers): name, colour (six hex digits) and description. */
  labels: z.array(z.strictObject({
    name: z.string().min(1).max(50),
    color: z.string().regex(/^[0-9a-f]{6}$/u),
    description: z.string().max(100),
  })),
  /** Autolinks on the trunk: `<keyPrefix><num>` in any GitHub text links to `urlTemplate` (which holds `<num>`). */
  autolinks: z.array(z.strictObject({
    keyPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,31}-$/u),
    urlTemplate: z.string().regex(/^https:\/\/[^\s<>]+<num>[^\s<>]*$/u),
    isAlphanumeric: z.boolean(),
  })),
  /** The Dependabot file (github-only §6.4): one entry per package root, grouped, with cooldowns. */
  dependabot: z.strictObject({
    schedule: z.strictObject({ interval: z.enum(["daily", "weekly", "monthly"]), day: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]), time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/u), timezone: z.string().min(1) }),
    openPullRequestsLimit: z.number().int().min(0).max(20),
    cooldownDays: z.number().int().min(0).max(90),
    majorCooldownDays: z.number().int().min(0).max(90),
    packages: z.array(z.strictObject({ ecosystem: z.enum(["npm", "github-actions", "cargo"]), directory: z.string().regex(/^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/u), group: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u) })).min(1),
    /** Lockfiles under these prefixes are frozen records (benchmarks), never updated. */
    frozenPrefixes: z.array(z.string().regex(/^(?:[A-Za-z0-9._-]+\/)+$/u)),
  }),
  /** The org Project the projection writes (github-only §9.2). */
  project: z.strictObject({ title: z.string().min(1).max(100), statusOptions: z.array(z.string().min(1).max(50)).min(1) }),
  /**
   * THE CONTENT POLICY (github-only §3.2, §5.4): what no commit may carry.
   * A private governed repository's push ruleset (`content-policy`) is
   * generated from it; the door's tree judge must read this same section
   * (#125), never a second list.
   */
  contentPolicy: z.strictObject({
    /** The largest file a push may carry, in megabytes (GitHub's push rule takes 1 to 100). */
    maxFileMegabytes: z.number().int().min(1).max(100),
    /** Extensions no file may have, each a dot and a name (`.pem`). */
    forbiddenExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,32}$/u)).min(1).max(200),
    /** Paths no file may sit under, in GitHub's fnmatch syntax (`**\/secrets/**`). */
    forbiddenPaths: z.array(z.string().regex(/^[A-Za-z0-9._*\/-]{1,200}$/u)).min(1).max(200),
  }),
  /** Objects a generated one replaced: `harness forge apply` deletes them (by kind and name). */
  retired: z.array(z.strictObject({ kind: z.enum(["ruleset"]), repository: z.string().regex(NAME), name: z.string().min(1) })),
});

/**
 * THE BOUNDS OF A FORGE REFUSAL'S TEXT: how much of GitHub's or `gh`'s
 * answer a typed refusal keeps. They are owned here, one value each, never
 * a literal at a call site.
 */
export const FORGE_REFUSAL_TEXT = deepFreeze({
  /** The excerpt of an error body that is not JSON, in characters. */
  bodyExcerptChars: 300,
  /** The validation or GraphQL error entries a refusal names. */
  errorEntries: 20,
  /** The last lines of `gh`'s standard error a refusal quotes. */
  cliStderrLines: 3,
  /** The characters of that quote. */
  cliStderrChars: 400,
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
    uploadsUrl: settings.uploadsUrl.replace(/\/$/u, ""),
    assetOrigins: settings.assetOrigins.map((origin) => origin.replace(/\/$/u, "")),
    maxAssetBytes: settings.request.maxAssetBytes,
    allowPrivateAddress: false,
    timeoutMs: settings.request.timeoutMs,
    maxResponseBytes: settings.request.maxResponseBytes,
    cleanupTimeoutMs: settings.request.cleanupTimeoutMs,
    etagCacheEntries: settings.request.etagCacheEntries,
    userAgent: settings.userAgent,
  });
}
