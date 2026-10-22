/**
 * THE FORGE CREDENTIALS — every way a forge client is told who it runs as.
 * There are exactly five, and none reads a token from a file:
 *
 * - {@link appInstallationCredential}: an App installation token, minted by
 *   the harness from the host's key custody (`app-keys.ts`), narrowed to ONE
 *   repository and to the permissions of one action (never wider than the
 *   registry, `app-registry.ts`), cached in memory until shortly before it
 *   expires, and checked: a token GitHub minted for other permissions or
 *   repositories than asked is `forge_token_scope_mismatch`;
 * - {@link appJwtCredential}: the App itself (a 9-minute RS256 JWT, `iss` = the
 *   client id), for the App-level endpoints (`/app/…`) only;
 * - {@link environmentCredential}: a token the process was handed in an
 *   environment variable (a workflow's `GITHUB_TOKEN` or a minted App token),
 *   read at call time;
 * - {@link memoryCredential}: a token held only in this process's memory (the
 *   maintainer's short-lived token typed at `harness forge apply`'s prompt);
 * - {@link anonymousCredential}: none, for GitHub's unauthenticated endpoints
 *   only (the App manifest conversion: its one-hour code is the secret).
 */
import { ForgeError } from "./codes.ts";
import { FORGE_APPS, narrowedPermissions, type ForgeAppRole, type ForgePermissions } from "./app-registry.ts";
import type { AppKeyCustody } from "./app-keys.ts";
import { githubClient } from "./github.ts";
import type { ForgeCredential, ForgeEndpoint } from "./port.ts";

/** How long before a JWT is backdated (GitHub's clock drift allowance) and how long it lives (≤ 10 min). */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

/** An RS256 JWT for `role`, signed by the custody (the key never leaves it). */
export function appJwt(custody: AppKeyCustody, role: ForgeAppRole, nowMs: number): string {
  const { clientId } = custody.identity(role);
  const now = Math.floor(nowMs / 1000);
  const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: clientId }))}`;
  return `${input}.${base64url(custody.signRs256(role, Buffer.from(input, "utf8")))}`;
}

/** The App itself (`role`), for `/app/…` endpoints. */
function appJwtCredential(custody: AppKeyCustody, role: ForgeAppRole): ForgeCredential {
  return Object.freeze({
    principal: `app:${FORGE_APPS[role].name}`,
    authorization: async () => `Bearer ${appJwt(custody, role, Date.now())}`,
  });
}

/** A token handed to the process in `variable`, read at call time. */
export function environmentCredential(principal: string, variable: string): ForgeCredential {
  return Object.freeze({
    principal,
    authorization: async () => {
      const token = process.env[variable];
      if (token === undefined || token.trim() === "") throw new ForgeError("forge_token_unavailable", `The environment variable ${variable} holds no token.`, { variable, principal });
      return `Bearer ${token.trim()}`;
    },
  });
}

/** No credential: for GitHub's unauthenticated endpoints only (the App manifest conversion). */
export function anonymousCredential(principal: string): ForgeCredential {
  return Object.freeze({ principal, authorization: async () => undefined });
}

/** A token held only in memory (typed at a prompt). */
export function memoryCredential(principal: string, token: string): ForgeCredential {
  if (token.trim() === "") throw new ForgeError("forge_token_unavailable", "An empty token was given.", { principal });
  const value = `Bearer ${token.trim()}`;
  return Object.freeze({ principal, authorization: async () => value });
}

export type InstallationTokenRequest = Readonly<{
  role: ForgeAppRole;
  owner: string;
  repository: string;
  /** The permissions of the action (a subset of the App's); undefined: the App's whole set. */
  permissions?: ForgePermissions | undefined;
  /** Renew this long before the token expires. */
  renewBeforeMs: number;
}>;

type MintedToken = Readonly<{ token: string; expiresAtMs: number }>;

type AccessTokenAnswer = Readonly<{
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
  repositories?: unknown;
}>;

/** Checks GitHub minted exactly what was asked (permissions and the one repository). */
function checkMinted(answer: AccessTokenAnswer, asked: ForgePermissions, request: InstallationTokenRequest): MintedToken {
  if (typeof answer.token !== "string" || answer.token === "" || typeof answer.expires_at !== "string" || Number.isNaN(Date.parse(answer.expires_at))) {
    throw new ForgeError("github_response_invalid", "GitHub's installation token answer carries no token or expiry.", { role: request.role });
  }
  const granted = (typeof answer.permissions === "object" && answer.permissions !== null ? answer.permissions : {}) as Record<string, unknown>;
  const mismatched = [...new Set([...Object.keys(asked), ...Object.keys(granted)])].filter((name) => granted[name] !== asked[name]);
  const repositories = Array.isArray(answer.repositories) ? answer.repositories.map((entry) => (entry as { name?: unknown }).name) : [];
  if (mismatched.length > 0 || repositories.length !== 1 || repositories[0] !== request.repository) {
    throw new ForgeError("forge_token_scope_mismatch", `GitHub minted the ${request.role} token for other permissions or repositories than asked.`, { role: request.role, permissions: mismatched, repositories: repositories.map(String) });
  }
  return Object.freeze({ token: answer.token, expiresAtMs: Date.parse(answer.expires_at) });
}

/**
 * An App installation token for `request.role` on ONE repository, narrowed to
 * the action's permissions; minted on first use and renewed in memory.
 */
export function appInstallationCredential(endpoint: ForgeEndpoint, custody: AppKeyCustody, request: InstallationTokenRequest): ForgeCredential {
  const asked = narrowedPermissions(request.role, request.permissions);
  const app = githubClient(endpoint, appJwtCredential(custody, request.role));
  let minted: MintedToken | undefined;
  let installationId: number | undefined;
  let pending: Promise<MintedToken> | undefined;

  async function mint(signal: AbortSignal): Promise<MintedToken> {
    if (installationId === undefined) {
      const installation = await app.rest<{ id?: unknown }>({ method: "GET", path: `/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repository)}/installation`, signal });
      if (typeof installation.data?.id !== "number") throw new ForgeError("github_response_invalid", "GitHub's installation answer carries no id.", { role: request.role });
      installationId = installation.data.id;
    }
    const answer = await app.rest<AccessTokenAnswer>({ method: "POST", path: `/app/installations/${String(installationId)}/access_tokens`, body: { repositories: [request.repository], permissions: asked }, signal });
    return checkMinted(answer.data ?? {}, asked, request);
  }

  return Object.freeze({
    principal: `app:${FORGE_APPS[request.role].name}@${request.owner}/${request.repository}`,
    authorization: async (signal: AbortSignal) => {
      if (minted === undefined || minted.expiresAtMs - request.renewBeforeMs <= Date.now()) {
        pending ??= mint(signal).finally(() => { pending = undefined; });
        minted = await pending;
      }
      return `Bearer ${minted.token}`;
    },
  });
}
