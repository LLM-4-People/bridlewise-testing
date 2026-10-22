/**
 * `harness forge apps audit` — runbook P1.11: each App's installation, read
 * by the App itself, compared with the registry (`app-registry.ts`). The
 * owner's token cannot list an installation's repositories; the App can.
 *
 * For each role:
 * 1. the App (its JWT, from its custody) lists its installations, and the
 *    one on the organisation must exist;
 * 2. it must be on SELECTED repositories, never all;
 * 3. its permissions and events must equal the registry's, exactly;
 * 4. an installation token that reads only metadata
 *    (`appInstallationMetadataCredential`) lists the repositories, which must
 *    equal the repositories of the kinds the registry names (plus every
 *    proving ground).
 *
 * The custody decides where an audit runs (GH-KEYS). A host App (agent,
 * verifier) is audited on the maintainer's host, through the key home. An
 * environment App (door, publisher) is audited only inside a job of its
 * protected environment, through `environmentKeyCustody`
 * (`.github/workflows/forge-apps-audit.yml`). Nothing is written to GitHub.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import type { AppKeyCustody } from "./app-keys.ts";
import { appInstallationMetadataCredential, appJwtCredential } from "./credentials.ts";
import { repositoriesOfKinds, type ForgeSettings } from "./forge-config.ts";
import { appManifest } from "./generated-files.ts";
import { githubClient } from "./github.ts";
import type { ForgeEndpoint } from "./port.ts";

/** One comparison: what the registry declares, what GitHub holds. */
export type AppAuditCheck = Readonly<{ check: "installed" | "selection" | "permissions" | "events" | "repositories"; ok: boolean; expected: unknown; found: unknown }>;

export type AppAudit = Readonly<{ role: ForgeAppRole; app: string; installationId: number | null; ok: boolean; checks: readonly AppAuditCheck[] }>;

type Installation = Readonly<{ id?: unknown; account?: Readonly<{ login?: unknown }>; repository_selection?: unknown; permissions?: unknown; events?: unknown }>;

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
const sameList = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const sameMap = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean =>
  sameList(Object.keys(left), Object.keys(right)) && Object.keys(left).every((name) => left[name] === right[name]);

/** Audit `role`'s installation on the organisation through `custody`. */
export async function auditAppInstallation(endpoint: ForgeEndpoint, custody: AppKeyCustody, role: ForgeAppRole, settings: ForgeSettings): Promise<AppAudit> {
  const declared = FORGE_APPS[role];
  const app = githubClient(endpoint, appJwtCredential(custody, role));
  const installations = await app.paginate<Installation>({ path: "/app/installations" }, { maxPages: settings.request.maxPages, perPage: 100 });
  const organization = settings.organization.toLowerCase();
  const installation = installations.find((candidate) => String(candidate.account?.login ?? "").toLowerCase() === organization);
  const checks: AppAuditCheck[] = [];
  const expectedRepositories = sorted(repositoriesOfKinds(settings, declared.installedOn).map((repository) => repository.name));
  if (installation === undefined || typeof installation.id !== "number") {
    checks.push({ check: "installed", ok: false, expected: settings.organization, found: installations.map((candidate) => String(candidate.account?.login ?? "")) });
    return deepFreeze({ role, app: declared.name, installationId: null, ok: false, checks });
  }
  checks.push({ check: "installed", ok: true, expected: settings.organization, found: settings.organization });
  checks.push({ check: "selection", ok: installation.repository_selection === "selected", expected: "selected", found: installation.repository_selection ?? null });
  const permissions = (typeof installation.permissions === "object" && installation.permissions !== null ? installation.permissions : {}) as Readonly<Record<string, unknown>>;
  checks.push({ check: "permissions", ok: sameMap(declared.permissions, permissions), expected: declared.permissions, found: permissions });
  const events = Array.isArray(installation.events) ? installation.events.map(String) : [];
  const declaredEvents = appManifest(role, settings).default_events as readonly string[];
  checks.push({ check: "events", ok: sameList(declaredEvents, events), expected: sorted(declaredEvents), found: sorted(events) });
  const reader = githubClient(endpoint, appInstallationMetadataCredential(endpoint, custody, role, installation.id));
  const repositories = await reader.paginate<Readonly<{ name?: unknown }>>({ path: "/installation/repositories" },
    { maxPages: settings.request.maxPages, perPage: 100, items: (data) => ((data as { repositories?: Readonly<{ name?: unknown }>[] }).repositories ?? []) });
  const found = sorted(repositories.map((repository) => String(repository.name)));
  checks.push({ check: "repositories", ok: sameList(expectedRepositories, found), expected: expectedRepositories, found });
  return deepFreeze({ role, app: declared.name, installationId: installation.id, ok: checks.every((check) => check.ok), checks });
}
