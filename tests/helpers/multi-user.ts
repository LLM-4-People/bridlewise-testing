/**
 * Multi-user test helpers (v12).
 *
 * Shared helpers for tests that exercise routes or DB methods requiring an
 * authenticated user context. Provides a SYNC user + session factory (no
 * scrypt — the password hash is a dummy, never verified in tests) so both
 * DB-level tests (need a `userId`) and HTTP-level tests (need a `harness_auth`
 * cookie) can set up an authenticated caller without async scrypt.
 *
 * The first user created on a fresh DB becomes the admin (countUsers===0);
 * subsequent users are regular users — mirroring production.
 */
import { createSessionToken, hashSessionToken } from "../../server/auth/auth.ts";
import type { DbClient } from "../../server/db/client.ts";

export type TestUser = Readonly<{
  readonly userId: string;
  readonly username: string;
  readonly cookie: string;
}>;

/**
 * Create a registered user + an active auth session, returning the userId +
 * the `harness_auth` cookie value to send with requests. Sync (dummy hash —
 * tests don't verify the password; routes resolve the user from the cookie
 * → auth_sessions → users, which works with any hash). The optional `n`
 * disambiguates usernames when a test creates multiple users.
 */
export function createTestUser(
  db: DbClient,
  username = "tester",
): TestUser {
  const user = db.createUser(username, "dummy-hash-not-verified-in-tests");
  const token = createSessionToken();
  db.createAuthSession(hashSessionToken(token), user.id, "test-session");
  seedProvider(db, user.id);
  return { userId: user.id, username: user.username, cookie: `harness_auth=${token}` };
}

/**
 * The models a seeded test provider serves.
 *
 * A run REFUSES when no saved provider serves the model it was given — that is
 * the product behaviour, and it is why this list exists. A test that names a
 * model outside it gets a 428 rather than a run, which is correct and is
 * exactly what the no-provider tests rely on; a test that needs another model
 * calls {@link seedProvider} with it rather than editing this line, so adding
 * a model to one test cannot silently change what every other test is
 * exercising.
 */
export const TEST_PROVIDER_MODELS: readonly string[] = [
  "gemma-4-31b",
  "qwen3.6-35b-fast",
];

/** The provider name a seeded test user has. */
export const TEST_PROVIDER_ID = "test-provider";

/**
 * The API key a seeded provider stores — exported because it is a REAL
 * credential as far as the identity layer is concerned: the mint
 * (`server/providers.ts::mintCredential`) registers it with the redactor the
 * moment a run first uses the provider, so a test asserting "the server's own
 * key never reaches the provider" asserts THIS value, from the one place that
 * declares it. Long enough to clear the redactor's 12-character registration
 * floor on purpose; shortening it would silently disarm that assertion.
 */
export const TEST_PROVIDER_API_KEY = "test-key-not-a-real-credential";

/**
 * Give a user a working, saved provider — the state a real user is in once
 * they have completed setup.
 *
 * Called by {@link createTestUser} so the fleet's default subject is a
 * configured account. It is a REAL provider record written through the same
 * table and the same encryption the product writes, not a stub: nothing in the
 * server accepts a provider from anywhere else, so a fake one would not work
 * even if it were wanted.
 *
 * The base URL points at a closed port on the loopback interface,
 * deliberately, and the choice of FAILURE MODE is measured rather than
 * incidental. A fixture aimed at something real would make the suite depend on
 * somebody else's uptime; an unresolvable HOSTNAME fails too — but through DNS
 * resolution and the client's backoff, which cost 7.0 s of wall clock in one
 * connection-test case against a 35 s suite budget. A refused TCP connection
 * to 127.0.0.1 fails for the same reason, just as honestly, and immediately.
 */
export function seedProvider(
  db: DbClient,
  userId: string,
  options: Readonly<{
    /** Which models this provider serves. */
    models?: readonly string[];
    /** The provider's name. */
    providerId?: string;
    /**
     * Where its API lives. Defaults to a closed port on loopback — see above.
     * A test that stands up its OWN provider server passes that server's URL
     * here, so the run reaches a real endpoint it controls.
     */
    baseUrl?: string;
    /**
     * Extra request headers the provider carries. Routed through the SAME
     * write shape the settings route writes, so a test asserting "a saved
     * header reaches the wire" is asserting the product's own round trip.
     */
    headers?: Readonly<Record<string, string>>;
  }> = {},
): void {
  const models = options.models ?? TEST_PROVIDER_MODELS;
  const providerId = options.providerId ?? TEST_PROVIDER_ID;
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:1/v1";
  const existing = db.getUserModelPrefs(userId) as
    | { providers?: readonly { id: string; models?: readonly { id: string }[] }[]; defaultProvider?: string; defaultModel?: string }
    | null;
  const kept = (existing?.providers ?? []).filter((provider) => provider.id !== providerId);
  const providers = [
    ...kept,
    {
      id: providerId,
      baseUrl,
      apiKey: TEST_PROVIDER_API_KEY,
      models: models.map((id) => ({ id })),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    },
  ];
  // THE STORED DEFAULT MUST STILL BE SERVED BY SOMETHING.
  //
  // Keeping the previous default unconditionally left a DANGLING one: seeding
  // a provider with a fresh model list, over a user whose default named a
  // model none of the new providers serve, produced an account whose every
  // run refused with `model_not_configured`. That is the product behaving
  // correctly on a fixture that had quietly become incoherent — and it read
  // as a broken guard rather than a broken fixture, which is the most
  // expensive kind of test failure.
  const servesDefault = providers.some((provider) =>
    provider.models?.some((model) => model.id === existing?.defaultModel) ?? false);
  db.upsertUserModelPrefs(userId, {
    providers,
    defaultProvider: existing?.defaultProvider ?? providerId,
    defaultModel: servesDefault ? existing?.defaultModel : models[0],
  });
}

/**
 * The owner a test's provider credential is minted for: an admin, whose
 * providers may reach private addresses — which every test provider is (a
 * loopback upstream answers them). A test about the NON-admin destination
 * rule mints for `{ isAdmin: false }` itself.
 */
export const PROVIDER_FIXTURE_OWNER = Object.freeze({ isAdmin: true });
