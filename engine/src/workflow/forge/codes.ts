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
const FORGE_CODES = deepFreeze({
  forge_not_configured: { class: "input", remedy: "Declare the `forge` section in engine/bridlewise.config.json (its schema is `forge-config.ts`)." },
  forge_usage: { class: "input", remedy: "Run `harness forge apps manifests [--check]`, `harness forge apps create`, `harness forge apps audit [--role <role>]…`, or `harness forge plan|apply|audit`." },
  forge_declaration_invalid: { class: "input", remedy: "Fix the declaration's owner (the forge section, the App registry, the community sources or the tree) so the generated configuration is whole: the message names what is missing or doubled." },
  forge_security_attach_failed: { class: "refused", remedy: "GitHub could not attach the security configuration to the named repositories (their status is failed): a feature the plan cannot enable there (secret scanning or push protection on a private repository without Secret Protection) is the usual cause. Fix the configuration for that visibility, then apply again." },
  forge_org_policy_contradicted: { class: "refused", remedy: "A repository setting is declared against what the organisation enforces (GitHub refuses the write, or overrides it): declare the repository's setting within the organisation's policy, or change the organisation's policy first, then plan again." },
  forge_security_enablement_in_progress: { class: "budget", remedy: "GitHub is still rolling out a security configuration to its repositories (an attachment reads attaching or updating), and refuses another change until it settles. The apply deferred the write past its other writes and continues only once the attachment states read settled; it stopped because they still did not. Apply again once they read attached or enforced." },
  forge_reference_unresolved: { class: "refused", remedy: "The object names an App, installation, team or user GitHub does not have yet: create it first (Session 1 for the Apps; `forge apply` creates the teams), then plan again." },
  forge_loosening_unacknowledged: { class: "refused", remedy: "Review each weakening the plan lists, then pass `--accept-loosening <kind:scope:key>` for each one you accept; the acknowledgement is recorded in the apply's receipt." },
  forge_tighten_unverified: { class: "integrity", remedy: "The org baseline did not read back as declared after it was applied, so nothing was loosened: run `harness forge plan` to see what differs, and investigate before applying again." },
  forge_plan_incomplete: { class: "refused", remedy: "`forge apply` sends a whole plan only: resolve every refused object (the plan lists each with its code), then apply again." },
  forge_request_invalid: { class: "input", remedy: "Fix the request: the path must be an API path starting with `/`, with no scheme, host, `..` or fragment, and a query of plain values." },
  forge_asset_integrity: { class: "integrity", remedy: "A release asset's bytes do not match the size or SHA-256 they declare, or GitHub recorded another digest than the one sent: rebuild the asset and its checksum from the tree, then upload (or download) again; never accept the mismatching bytes." },
  forge_asset_too_large: { class: "refused", remedy: "The release asset is larger than `forge.request.assets.maxBytes`: shrink the asset, or raise the bound deliberately in the forge section." },
  forge_asset_stalled: { class: "errored", remedy: "A window of `forge.request.assets.progressWindowMs` moved fewer than `minBytesPerWindow` bytes of the asset (a drip, or silence): the connection or GitHub stopped. Run the transfer again; if a working connection moves less, lower the floor deliberately in the forge section." },
  forge_asset_unanswered: { class: "errored", remedy: "Every byte of the upload was handed over and GitHub did not answer within `forge.request.assets.answerSilenceMs`: check whether the asset was stored (the release's assets) before uploading again; raise the bound deliberately if GitHub takes longer to store assets this size." },
  forge_asset_sink_failed: { class: "errored", remedy: "Writing the downloaded bytes failed here, not on GitHub (a full disk, a removed folder, a permission): fix the local destination and download again; nothing partial was published." },
  forge_asset_redirect_refused: { class: "refused", remedy: "GitHub redirected an asset download to an origin not in `forge.assetOrigins`, or the asset host redirected again (a chain is never followed): if GitHub moved its asset hosts, add the new origin to the forge section deliberately." },
  forge_endpoint_invalid: { class: "input", remedy: "Name the API as an absolute https URL (http only for a loopback test server) with no credentials, query or fragment." },
  forge_identity_copy_invalid: { class: "input", remedy: "A file that carries a copy of the repository identity has lost its field (package.json `repository`, `homepage` and `bugs`; CITATION.cff `repository-code`): restore the field, then run harness sync, which writes it from the forge section." },
  forge_app_unknown: { class: "input", remedy: "Name one of the App registry's roles (`app-registry.ts`)." },
  forge_app_key_unavailable: { class: "refused", remedy: "Create the App and store its key with `harness forge apps create` (the key home holds it; nobody copies a key by hand)." },
  forge_app_key_invalid: { class: "integrity", remedy: "The stored App record is unreadable or its key is not an RSA private key: recreate the key in the App's settings and store it again with `harness forge apps create`." },
  forge_token_unavailable: { class: "refused", remedy: "Provide the token the way the credential names (an environment variable set by the workflow, or the maintainer's prompt); it is never read from a file." },
  forge_token_scope_mismatch: { class: "integrity", remedy: "GitHub minted a token with permissions or repositories other than those asked: compare the App's installed permissions with the registry (`harness forge audit`) and stop until they agree." },
  forge_maintainer_cli_failed: { class: "refused", remedy: "Install `gh` and log in as the maintainer (`gh auth login`) for this one session; the forge uses it only to write environment secrets and variables while the owner credential is on the host." },
  forge_maintainer_cli_stalled: { class: "errored", remedy: "gh made no progress (no output and no CPU work) within its stall window, or passed its CPU limit (`forge.maintainerCli`): check its network and login, then run the step again; a held key is resumed, never lost." },
  forge_app_conversion_mismatch: { class: "integrity", remedy: "GitHub created an App that is not the declared one (its owner, name, permissions or events differ from the generated manifest); nothing was stored. Delete that App in the organisation's settings (Developer settings → GitHub Apps → the App → Advanced → Delete), then create it again from the page." },
  forge_app_name_taken: { class: "refused", remedy: "An App with this name already exists, but no key for it is stored here (a half-finished attempt): delete it in the organisation's settings (Developer settings → GitHub Apps → the App → Advanced → Delete), then reload the page and create it again." },
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
