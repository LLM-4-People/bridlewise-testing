/**
 * THE APP REGISTRY — the four GitHub Apps Bridlewise acts as (github-only
 * §4.1), each a thin face over one harness owner, with least privilege:
 *
 * - `agent` (the writer): pushes agent branches, opens draft pull requests;
 * - `verifier`: reviews (UR-09, independent of the writer);
 * - `door`: judges and posts the one required check;
 * - `publisher`: the product, releases, the projection, Pages and the ledger.
 *
 * This table is the ONE source of what each App may do: the App manifests
 * (`harness forge apps manifests` → `.github/forge/apps/<role>.json`), the
 * permissions an installation token is narrowed to when minted
 * (`app-tokens.ts`), where each key lives (`custody`), which repositories
 * (by their `kind` property) each App is installed on, and what the audit
 * compares the live installations with. No App holds `administration:
 * write`, `members` or `organization_administration` (§3.4); a test holds the
 * table to that.
 *
 * Permission names are GitHub's (`app-permissions` in the REST description):
 * Dependabot alerts are `vulnerability_alerts`, org Projects are
 * `organization_projects`. `metadata: read` is implied by any repository
 * permission and is stated so the audit compares like with like.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { ForgeError } from "./codes.ts";

export const FORGE_APP_ROLES = deepFreeze(["agent", "verifier", "door", "publisher"] as const);
export type ForgeAppRole = typeof FORGE_APP_ROLES[number];

export type ForgeAccess = "read" | "write";
export type ForgePermissions = Readonly<Record<string, ForgeAccess>>;

/** The repository roles of the topology (the `kind` custom property, github-only §2.1). */
export type ForgeRepositoryKind = "trunk" | "meta" | "evidence" | "notes" | "archive";

/**
 * Where an App's private key lives: `host` — the host's key home, minted by
 * the harness on this machine (`app-keys.ts`); `environment` — a GitHub
 * environment secret only `main`'s workflows reach, with the client id as an
 * environment variable.
 */
export type ForgeKeyCustody =
  | Readonly<{ kind: "host" }>
  | Readonly<{ kind: "environment"; environment: string; keySecret: string; clientIdVariable: string }>;

export type ForgeAppDeclaration = Readonly<{
  role: ForgeAppRole;
  /** The App's name on GitHub (its slug once created). */
  name: string;
  description: string;
  /** The harness owner the App is the face of. */
  owner: string;
  permissions: ForgePermissions;
  custody: ForgeKeyCustody;
  /** The repository kinds the App is installed on (only selected repositories, never all). */
  installedOn: readonly ForgeRepositoryKind[];
}>;

export const FORGE_APPS: Readonly<Record<ForgeAppRole, ForgeAppDeclaration>> = deepFreeze({
  agent: {
    role: "agent",
    name: "bridlewise-agent",
    description: "Bridlewise writer agents: pushes agent branches and opens draft pull requests. Minted per action on the maintainer's host; no model ever sees a key or a token.",
    owner: "engine/src/workflow/forge/ (through ws)",
    permissions: { contents: "write", pull_requests: "write", checks: "read", actions: "read", metadata: "read" },
    custody: { kind: "host" },
    installedOn: ["trunk", "notes", "meta"],
  },
  verifier: {
    role: "verifier",
    name: "bridlewise-verifier",
    description: "Bridlewise independent verification (UR-09): reviews pull requests written by another session.",
    owner: "the verifier role's tool",
    permissions: { pull_requests: "write", contents: "read", checks: "read", metadata: "read" },
    custody: { kind: "host" },
    installedOn: ["trunk", "notes", "meta"],
  },
  door: {
    role: "door",
    name: "bridlewise-door",
    description: "Bridlewise door: judges every land and posts the one required check, bridlewise/door. Its key exists only in the `door` environment.",
    owner: "engine/src/workflow/gates/ (the judge)",
    permissions: { checks: "write", statuses: "write", pull_requests: "read", contents: "read", actions: "read", attestations: "write", metadata: "read" },
    custody: { kind: "environment", environment: "door", keySecret: "DOOR_APP_KEY", clientIdVariable: "DOOR_APP_CLIENT_ID" },
    installedOn: ["trunk", "notes", "evidence", "meta"],
  },
  publisher: {
    role: "publisher",
    name: "bridlewise-publisher",
    description: "Bridlewise publisher: the product branch, releases, the issue/project/discussion projection, Pages and the ledger. Its key exists only in the `publish` environment.",
    owner: "engine/src/workflow/forge/publish/",
    permissions: {
      contents: "write", issues: "write", discussions: "write", pull_requests: "write", pages: "write",
      organization_projects: "write", repository_advisories: "write", administration: "read",
      secret_scanning_alerts: "read", security_events: "read", vulnerability_alerts: "read", metadata: "read",
    },
    custody: { kind: "environment", environment: "publish", keySecret: "PUBLISHER_APP_KEY", clientIdVariable: "PUBLISHER_APP_CLIENT_ID" },
    installedOn: ["trunk", "evidence", "meta"],
  },
} satisfies Record<ForgeAppRole, ForgeAppDeclaration>);

/** The declaration of `role`, or the typed `forge_app_unknown`. */
export function forgeApp(role: string): ForgeAppDeclaration {
  if (!(FORGE_APP_ROLES as readonly string[]).includes(role)) {
    throw new ForgeError("forge_app_unknown", `'${role}' is not an App of the registry.`, { role, roles: FORGE_APP_ROLES });
  }
  return FORGE_APPS[role as ForgeAppRole];
}

/**
 * `asked` narrowed to what `role` may hold: every asked permission must be in
 * the App's declaration at the same or a lower access (`read` ≤ `write`),
 * else `forge_request_invalid`. Undefined asks for the App's whole set;
 * `metadata: read` is always part of the answer (GitHub implies it).
 */
export function narrowedPermissions(role: ForgeAppRole, asked: ForgePermissions | undefined): ForgePermissions {
  const declared = FORGE_APPS[role].permissions;
  if (asked === undefined) return declared;
  for (const [name, access] of Object.entries(asked)) {
    const held = declared[name];
    if (held === undefined || (access === "write" && held === "read")) {
      throw new ForgeError("forge_request_invalid", `The ${role} App does not hold '${name}: ${access}'; a token is never minted wider than the registry.`, { role, permission: name, access });
    }
  }
  // GitHub grants `metadata: read` with every repository permission: asked or not, it is in the token.
  return deepFreeze({ ...asked, metadata: "read" });
}
