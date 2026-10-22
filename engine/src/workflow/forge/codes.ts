/**
 * THE FORGE CODES — the single source of every typed answer the forge gives
 * (the GitHub adapter, App token minting, `harness forge …`): its code, its
 * class and the one remedy a person or an agent is told. A refusal raised
 * anywhere in the forge is a {@link ForgeError} carrying one of these codes,
 * so the CLI, the exposure actions and every lane that builds on the port read
 * one meaning per code. GitHub's own answers are classified ONCE, in
 * `github.ts`; no caller re-reads a status code or a message.
 *
 * Classes:
 * - `input` — the caller's request or the forge's declarations are wrong;
 * - `refused` — GitHub refused the request for a reason that a person must
 *   change (a permission, a plan, a validation rule, a conflict): retrying the
 *   same request gives the same answer;
 * - `budget` — a GitHub budget is spent (the primary rate limit, a secondary
 *   limit, the content-creation budget): the same request succeeds after the
 *   named reset, and the caller's scheduler decides when; nothing here waits;
 * - `errored` — GitHub or the network failed (5xx, an unreadable answer);
 * - `integrity` — an answer that must not happen (a token GitHub minted for
 *   other permissions than asked): stop and preserve evidence.
 */
import { HarnessError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";

const FORGE_CLASSES = deepFreeze(["input", "refused", "budget", "errored", "integrity"] as const);
export type ForgeClass = typeof FORGE_CLASSES[number];

type CodeEntry = Readonly<{ class: ForgeClass; remedy: string }>;

/** Every code the forge answers with (see the header). */
export const FORGE_CODES = deepFreeze({
  forge_not_configured: { class: "input", remedy: "Declare the `forge` section in engine/bridlewise.config.json (its schema is `forge-config.ts`)." },
  forge_usage: { class: "input", remedy: "Run `harness forge apps manifests [--check]` or `harness forge apps create`." },
  forge_request_invalid: { class: "input", remedy: "Fix the request: the path must be an API path starting with `/`, with no scheme, host, `..` or fragment, and a query of plain values." },
  forge_endpoint_invalid: { class: "input", remedy: "Name the API as an absolute https URL (http only for a loopback test server) with no credentials, query or fragment." },
  forge_app_unknown: { class: "input", remedy: "Name one of the App registry's roles (`app-registry.ts`)." },
  forge_app_key_unavailable: { class: "refused", remedy: "Create the App and store its key with `harness forge apps create` (the key home holds it; nobody copies a key by hand)." },
  forge_app_key_invalid: { class: "integrity", remedy: "The stored App record is unreadable or its key is not an RSA private key: recreate the key in the App's settings and store it again with `harness forge apps create`." },
  forge_token_unavailable: { class: "refused", remedy: "Provide the token the way the credential names (an environment variable set by the workflow, or the maintainer's prompt); it is never read from a file." },
  forge_token_scope_mismatch: { class: "integrity", remedy: "GitHub minted a token with permissions or repositories other than those asked: compare the App's installed permissions with the registry (`harness forge audit`) and stop until they agree." },
  forge_maintainer_cli_failed: { class: "refused", remedy: "Install `gh` and log in as the maintainer (`gh auth login`) for this one session; the forge uses it only to write environment secrets and variables while the owner credential is on the host." },
  forge_environment_missing: { class: "refused", remedy: "Create the environment first (runbook P1.4: `door`, `publish`, `release`, `rotation`, each limited to `main`); the door and publisher keys are written into them." },
  forge_apps_page_refused: { class: "input", remedy: "Open the page at the address `harness forge apps create` printed (127.0.0.1 only), and use its own buttons: a request from another origin, or with an unknown or used state, is refused." },
  forge_apps_page_unavailable: { class: "errored", remedy: "The page's port is in use or cannot be bound: free it, or set `forge.appsPage.port` (the App manifests' callback follows it after `harness sync`)." },
  github_unauthorized: { class: "refused", remedy: "The credential was refused (401): it is expired, revoked or malformed. Mint a new App token or provide a valid one." },
  github_forbidden: { class: "refused", remedy: "GitHub refused the action for this principal (403): grant the App the permission the registry declares for it, or use the principal that holds it." },
  github_not_found: { class: "refused", remedy: "GitHub answered 404: the object does not exist, or this principal cannot see it (an App not installed on the repository answers 404 too)." },
  github_conflict: { class: "refused", remedy: "GitHub answered 409: the object changed or is in a state that refuses this action; re-read it and plan again." },
  github_precondition_failed: { class: "refused", remedy: "GitHub answered 412: the precondition the request carried no longer holds; re-read the object and plan again." },
  github_validation_failed: { class: "refused", remedy: "GitHub refused the payload (422): the details name each field and the rule it breaks; fix the generator that produced it." },
  github_moved: { class: "refused", remedy: "The repository was renamed or transferred, so the API answered with a redirect, which is never followed: configure the new owner and name." },
  unavailable_on_plan: { class: "refused", remedy: "This feature is not available on the organisation's plan (or its add-ons): record it as `unavailable_on_plan` in the plan, and enforce the property through the door instead." },
  github_rate_limited: { class: "budget", remedy: "The primary rate limit of this principal is spent: the scheduler resumes after `resetAt`. Conditional requests (ETags) that answer 304 do not count against it." },
  github_secondary_rate_limited: { class: "budget", remedy: "A secondary rate limit (concurrency or CPU time) refused the request: resume after `retryAfterSeconds` (at least a minute when GitHub names none), with fewer concurrent requests." },
  github_content_budget_exhausted: { class: "budget", remedy: "The content-creation budget (about 80 per minute, 500 per hour) is spent: the projection converges over the next windows; resume after `retryAfterSeconds` (at least a minute when GitHub names none)." },
  github_unavailable: { class: "errored", remedy: "GitHub failed (5xx) or the connection did: nothing is blamed on the request; the caller's scheduler retries it later." },
  github_response_invalid: { class: "errored", remedy: "GitHub answered with a body the adapter cannot read as the declared format; preserve the request id and report it." },
} as const satisfies Readonly<Record<string, CodeEntry>>);

export type ForgeCode = keyof typeof FORGE_CODES;

/** Facts a forge refusal may carry: plain values only, never a credential. */
export type ForgeFacts = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** The class of `code`. */
export function forgeClass(code: ForgeCode): ForgeClass {
  return FORGE_CODES[code].class;
}

/** One typed refusal of the forge: a code from {@link FORGE_CODES}, its remedy, and the facts that name what was refused. */
export class ForgeError extends HarnessError {
  readonly forgeCode: ForgeCode;
  readonly forgeClass: ForgeClass;
  readonly remedy: string;
  readonly facts: ForgeFacts;

  constructor(code: ForgeCode, message: string, facts: ForgeFacts = {}) {
    const flat: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(facts)) flat[key] = Array.isArray(value) ? value.join(",") : value as string | number | boolean;
    super(message, code, FORGE_CODES[code].class === "budget" || FORGE_CODES[code].class === "errored", flat);
    this.forgeCode = code;
    this.forgeClass = FORGE_CODES[code].class;
    this.remedy = FORGE_CODES[code].remedy;
    this.facts = deepFreeze({ ...facts });
  }
}

/** Whether `error` is a forge refusal (optionally: with one of `codes`). */
export function isForgeError(error: unknown, ...codes: readonly ForgeCode[]): error is ForgeError {
  return error instanceof ForgeError && (codes.length === 0 || codes.includes(error.forgeCode));
}
