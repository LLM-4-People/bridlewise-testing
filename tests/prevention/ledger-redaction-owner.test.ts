// @vitest-environment node
/**
 * A CREDENTIAL CANNOT REACH THE LEDGER'S FAILURE TEXT — driven into real
 * SQLite and read back off the DISK, not out of a variable.
 *
 * ── THE DEFECT THIS EXISTS FOR, AS IT WAS MEASURED ────────────────────────
 *
 * A provider answered `400` and echoed the `Authorization` header inside its
 * own error body. Three doors saw that string:
 *
 *   the connection-test button  →  REDACTED  (it calls the redactor by hand)
 *   the SSE frames + REST bodies →  REDACTED  (the egress choke point)
 *   the effect ledger            →  PLAINTEXT
 *
 * One failed effect wrote TWO byte-matches of a live API key into
 * `timeline.db` — the `event_log` row and its `timeline_projection` copy — and
 * the ledger on the machine this was measured on is 131 MB and is rendered in
 * a user-facing tab. The chain is append-only: there is no operation anywhere
 * that can take a secret back out of it.
 *
 * The redactor ALREADY KNEW the key — it is registered at the credential mint,
 * which is the only way a key can enter the process — so this was not a
 * detection failure. It was a third door consulting neither of the other two.
 *
 * ── WHY THIS TEST READS THE FILE AND NOT THE ROW ──────────────────────────
 *
 * A masked row is not the claim. The claim is that the BYTES ON DISK do not
 * contain the key, and those are two different assertions: the projection is a
 * second copy of the same values, the WAL holds pages the main file has not
 * absorbed yet, and a future column could carry the message somewhere the row
 * accessor does not look. So every test here finishes by scanning the ledger's
 * actual files for the canary and requiring zero matches.
 *
 * ── AND IT USES A CANARY THAT CANNOT REACH THE LIVE LEDGER ────────────────
 *
 * `tests/setup/test-setup.ts` redirects `HARNESS_WEB_TIMELINE_DB_PATH` into a
 * per-worker throwaway directory at setup-file module scope, before any test
 * file is read. This file does not trust that silently: it ASSERTS the
 * redirection happened and that the ledger it is about to plant a canary into
 * is OUTSIDE the repository, and refuses otherwise. A guard that plants a
 * real-looking secret has to prove where the secret lands.
 *
 * Mutation-verified out of band (three mutants of the store's masking call —
 * removed, inert, and weakened to a prefix rule — each re-leaked, and each was
 * restored by bytes AND by file mode). It is deliberately not mutated from
 * inside the suite: the subject is a live tracked module shared with the other
 * repository, and a truncating write from a test fork is how a source file
 * ends up at zero bytes while the run stays green.
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// THE PROVIDER TRANSPORT IS STUBBED (only the transport) so the REAL
// streamChat capture chain can be driven: the model's "output" below is a
// scripted echo, but the redaction, the document capture, the effect sink,
// the ledger and the disk are all the production ones. The factory lives in
// the shared helper; the mock is declared here where vitest can hoist it.
vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { stubLlmClientModule } = await import("../helpers/stub-llm-client.ts");
  return stubLlmClientModule();
});

import { serverConfig } from "../../server/kernel/config.ts";
import { getTimelineQuery, getTimelineRecorder, getTimelineStore } from "../../server/observability/timeline-bridge.ts";
import { withRecordingContext } from "../../server/kernel/canonical.ts";
import { recordProviderStream, streamChat } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { redactContent, redactForUserDisplay } from "../../server/llm/redaction.ts";
import { redactForLLMContext } from "../../engine/src/privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../engine/src/privacy/privacy-policy.ts";
import { heldValues } from "../../engine/src/privacy/held-set.ts";
import { stubLlmProviderScript, resetStubLlmProvider } from "../helpers/stub-llm-client.ts";
import {
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
} from "../../shared/constants.ts";
import { executeToolCall } from "../../server/tools/tool-executor.ts";
import { sendJson } from "../../server/router/router.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";

/**
 * A canary shaped like a real provider key and unique per run.
 *
 * NOT A FIXED LITERAL. A plant that names itself can be defeated by filtering
 * that exact string, and a repeated canary would also accumulate in whatever
 * ledger a mis-set env var pointed at. The random middle also means the
 * assertions cannot pass by matching something the tree already contains.
 */
function freshCanary(): string {
  return `sk-ledgercanary-${randomUUID().replaceAll("-", "")}`;
}

/**
 * Teach the redactor the key THE WAY PRODUCTION DOES — through the credential
 * mint, which is the only producer of a credential and therefore the only way
 * a key can enter this process at all.
 *
 * Deliberately not `rememberOwnCredential` directly: that would prove the
 * registry works, which was never in doubt. What matters is that the path a
 * real key travels registers it, so the ledger's masking has something to know.
 */
function mintThroughTheRealDoor(apiKey: string): void {
  const store = parseProviderStore({
    providers: [{ id: `canary-${randomUUID()}`, baseUrl: "https://provider.invalid/v1", apiKey, models: [{ id: "canary-model" }] }],
  });
  const credential = resolveProviderCredential(store, "canary-model", PROVIDER_FIXTURE_OWNER);
  // The credential itself must not print the key either — the containing store
  // used to, which is the sibling defect this canary also covers.
  expect(JSON.stringify({ credential, store })).not.toContain(apiKey);
}

/** Every file SQLite may hold this ledger's bytes in. */
function ledgerFiles(): readonly string[] {
  const base = serverConfig.timelineDbPath;
  return [base, `${base}-wal`, `${base}-shm`].filter((p) => existsSync(p));
}

/**
 * How many times `needle` appears in the ledger's bytes.
 *
 * Read as BYTES through `readFileSync` and matched in process. A SQLite file
 * holds NUL bytes, and `grep` treats a file containing one as binary — it
 * prints nothing and exits cleanly, which is a silently empty answer rather
 * than an error.
 */
function canaryMatchesOnDisk(needle: string): number {
  let total = 0;
  for (const file of ledgerFiles()) {
    const bytes = readFileSync(file);
    let at = bytes.indexOf(needle);
    while (at !== -1) {
      total += 1;
      at = bytes.indexOf(needle, at + 1);
    }
  }
  return total;
}

/**
 * THE SCAN'S OWN LIVENESS, and it is not optional.
 *
 * A byte scan that finds zero matches is indistinguishable from a byte scan
 * pointed at the wrong files, or one running before SQLite has written
 * anything. So every disk assertion also carries a WITNESS: an innocuous
 * unique marker put into the SAME message as the canary, which MUST be found.
 * Canary absent AND witness present is the only pair that proves the file was
 * read and the masking worked; canary absent and witness absent proves nothing
 * at all.
 *
 * No checkpoint is forced. In WAL mode a COMMIT writes its frames to
 * `timeline.db-wal` before returning, and `ledgerFiles()` scans the WAL and the
 * shared-memory file as well as the main database — which is the honest
 * universe, because a key sitting in an unabsorbed WAL page is a key on disk.
 * Closing the store to checkpoint is NOT available: the bridge memoises its
 * handle and does not reopen, so a close would take the ledger away from every
 * later assertion in the file.
 */
function witness(): string {
  return `ledger-scan-witness-${randomUUID().replaceAll("-", "")}`;
}

/** The provider events attributed to one unique actor id, newest first. */
function providerEventsFor(actorId: string) {
  return getTimelineQuery()
    .byEventType("provider", { ascending: false, limit: 500 }).events
    .filter((event) => event.actorId === actorId);
}

/** Run `fn` attributed to a unique actor and wait for the async effect append. */
async function attributed(label: string, fn: () => Promise<void>): Promise<string> {
  const actorId = `ledger-redaction-${label}-${randomUUID()}`;
  await withRecordingContext({ actor: { kind: "user", id: actorId } }, fn);
  await new Promise((resolve) => setImmediate(resolve));
  return actorId;
}

beforeAll(() => {
  // THE PRECONDITION THIS FILE REFUSES TO ASSUME. A canary must never be
  // written into a developer's real ledger, so the destination is checked
  // before anything is planted rather than trusted from another module.
  //
  // Stated as "not the live one" rather than "under the system temp root",
  // because the system temp root has an owner in this tree and a test may not
  // reach past it. The live ledger is `.bridlewise/timeline.db` RELATIVE TO
  // THE REPOSITORY, so "outside the repository, and redirected by the owner" is
  // both the real invariant and checkable without naming the temp root.
  const path = serverConfig.timelineDbPath;
  expect(
    process.env.HARNESS_WEB_TIMELINE_DB_PATH,
    "the test-setup owner must have redirected the ledger before this file was read",
  ).toBeDefined();
  expect(
    path.startsWith(process.cwd()),
    `this file plants a real-looking credential and must only ever write to a ` +
    `throwaway ledger. HARNESS_WEB_TIMELINE_DB_PATH resolved to ${path}, which is ` +
    `inside the repository at ${process.cwd()} — that is the live ledger.`,
  ).toBe(false);
  // Open the ledger before any effect runs: the sink is installed on first
  // open, and an effect emitted before installation is dropped.
  getTimelineQuery();
});

describe("the ledger's failure text cannot carry a credential", () => {
  test("a provider that echoes the key into a 400 lands as a MASKED row, and zero bytes on disk", async () => {
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    // LIVENESS FOR THE DETECTOR ITSELF, before the ledger is involved: the
    // redactor genuinely recognises this value. Without this, a clean disk scan
    // is indistinguishable from a canary the redactor never learned.
    const marker = witness();
    const providerMessage =
      `bad request (400): {"error":{"code":"invalid_api_key","message":` +
      `"Incorrect API key provided: ${canary}. Request id ${marker}."}}`;
    expect(redactContent(providerMessage), "the redactor must know this key").not.toContain(canary);

    // THE REAL CHOKE POINT, entered the way `streamChat` enters it: consume a
    // provider stream through `recordProviderStream` and have it throw the
    // provider's own error. This is the path the measured leak travelled.
    const actorId = await attributed("stream", async () => {
      const failing = (async function* (): AsyncGenerator<string, void, unknown> {
        yield "partial";
        const error = new Error(providerMessage) as Error & { code: string };
        error.code = "llm_bad_request";
        throw error;
      })();
      // The SPECIFIC failure, not a bare `.toThrow()`: the wrapper must rethrow
      // the provider's own error unchanged, which is what makes the effect
      // record's message the provider's message.
      await expect(async () => {
        for await (const chunk of recordProviderStream("canary-model", failing)) void chunk;
      }).rejects.toThrow(/^bad request \(400\): /u);
    });

    const events = providerEventsFor(actorId);
    // §13: REDACTION CHANGES WHAT IS STORED, NEVER WHAT WAS RECORDED AS HAVING
    // HAPPENED. The row must still be there, still failed, still carrying the
    // same category and code — only the message is masked. A "fix" that dropped
    // the row would be a worse defect than the leak.
    expect(events.length, "the failed provider effect must still be recorded").toBe(1);
    const event = events[0]!;
    expect(event.outcome).toBe("failed");
    expect(event.errorCategory).toBe("llm");
    expect(event.errorCode).toBe("llm_bad_request");
    expect(event.errorMessage, "the message must survive as evidence").not.toBeNull();
    expect(event.errorMessage, "and it must be masked").toContain("[REDACTED:");
    expect(event.errorMessage, "the key must not be in the row").not.toContain(canary);
    // The surrounding words are the useful part and must be preserved — a
    // redaction that ate the whole message would hide the failure as well.
    expect(event.errorMessage).toContain("invalid_api_key");
    expect(event.errorMessage).toContain("bad request (400)");

    // AND THE BYTES. The row accessor reads two of the columns that hold this
    // value; the file holds every copy of it.
    expect(
      canaryMatchesOnDisk(marker),
      `the witness is not in the ledger's bytes, so this scan is reading the wrong ` +
      `files or reading them too early. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      canaryMatchesOnDisk(canary),
      `the canary appears in the ledger's bytes. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBe(0);
  });

  test("a caller that never touches the effect sink is masked too — the store is the door", async () => {
    // THE POPULATION CLAIM. Masking at the effect sink would have closed the
    // one path that was driven and left every other producer of `error.message`
    // open: a terminal record, a route, a subsystem written next year, anything
    // reaching `appendEvent` without the recorder facade. This drives the
    // recorder directly, with no effect wrapper anywhere in the call stack.
    const canary = freshCanary();
    const marker = witness();
    mintThroughTheRealDoor(canary);
    const actorId = `ledger-redaction-direct-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      getTimelineRecorder().recordEvent({
        eventType: "provider",
        description: "direct:recordEvent",
        outcome: "failed",
        error: {
          category: "llm",
          code: "llm_direct_probe",
          message: `upstream said: Bearer ${canary} is not valid (${marker})`,
          retryable: false,
        },
      });
    });
    const event = providerEventsFor(actorId)[0];
    expect(event, "the direct append must still produce a row").toBeDefined();
    expect(event!.errorCode).toBe("llm_direct_probe");
    expect(event!.errorMessage).toContain("[REDACTED:");
    expect(event!.errorMessage).not.toContain(canary);
    expect(canaryMatchesOnDisk(marker), "the witness proves this scan reached the bytes").toBeGreaterThanOrEqual(1);
    expect(canaryMatchesOnDisk(canary)).toBe(0);
  });

  test("a key that LOOKS LIKE NOTHING is masked by the client that holds it, never by a process-wide oracle", async () => {
    // A SHAPELESS canary in a sentence with no credential cue: the format
    // catalogue and the phrase detectors have nothing to fire on, so only a
    // layer that KNOWS the value can mask it.
    //
    // WHICH layer changed (cred-audit CRED-F2): a provider key is a USER's.
    // The mint used to register it in the process-wide registry, which made
    // every other user's text a masking ORACLE for it (write a guess, see it
    // masked) and, 64 keys later, switched registration off for the harness's
    // own secrets. The client that carries the credential now holds it for its
    // own calls — its failures, diagnostics and requests are masked with it —
    // and the process-wide layer stays the harness's own.
    const shapeless = `ledgerkey-${randomUUID().replaceAll("-", "")}`;
    expect(shapeless.startsWith("sk-"), "the canary must not be shaped like a known vendor's").toBe(false);
    const marker = witness();
    const neutral = `rejected: the tenant ${shapeless} is not permitted on this route (${marker})`;
    expect(redactContent(neutral), "an unregistered shapeless value has no cue to fire on").toContain(shapeless);
    mintThroughTheRealDoor(shapeless);
    expect(redactContent(neutral), "the mint must NOT teach the process-wide redactor (an oracle for other users)").toContain(shapeless);
    // The client's own failure text is masked with what it holds …
    const clientFailure = redactForLLMContext(neutral, DEFAULT_PRIVACY_POLICY, { heldCredentials: heldValues("provider:ledger", [shapeless]) });
    expect(clientFailure).not.toContain(shapeless);

    // … and that is the text the ledger receives.
    const actorId = `ledger-redaction-shapeless-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      getTimelineRecorder().recordEvent({
        eventType: "provider",
        description: "direct:recordEvent",
        outcome: "failed",
        error: { category: "llm", code: "llm_forbidden", message: clientFailure, retryable: false },
      });
    });
    const event = providerEventsFor(actorId)[0];
    expect(event, "the row must exist").toBeDefined();
    expect(event!.errorCode).toBe("llm_forbidden");
    expect(event!.errorMessage).not.toContain(shapeless);
    expect(canaryMatchesOnDisk(marker), "the witness proves this scan reached the bytes").toBeGreaterThanOrEqual(1);
    expect(canaryMatchesOnDisk(shapeless)).toBe(0);
  });

  test("an ordinary failure message is stored VERBATIM — the masking is not an off switch", async () => {
    // BOTH DIRECTIONS. Every assertion above is satisfied by a redactor that
    // eats everything, and a ledger that cannot say why a step failed is the
    // defect the error columns were added to fix. So a message with no secret
    // in it must arrive byte-identical.
    const plain = "connect ECONNREFUSED 127.0.0.1:1 after 3 attempts";
    const actorId = `ledger-redaction-plain-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      getTimelineRecorder().recordEvent({
        eventType: "provider",
        description: "direct:recordEvent",
        outcome: "failed",
        error: { category: "llm", code: "llm_unreachable", message: plain, retryable: false },
      });
    });
    const event = providerEventsFor(actorId)[0];
    expect(event, "the row must exist").toBeDefined();
    expect(event!.errorMessage, "an innocent message must not be altered").toBe(plain);
    expect(event!.errorMessage).not.toContain("[REDACTED:");
  });

  test("a resource description's numeric measurement survives the EGRESS redaction verbatim", async () => {
    // THE MEASURED DEFECT: the resource lane records its samples as
    // `Resource <metric>: <value><unit>` — the value and unit GLUED, with no
    // separator. A double-precision utilization (`0.4237013706696966`) plus
    // `ratio` is a 21-character unbroken alphanumeric run, which the redaction
    // engine's entropy layer read as a credential: the timeline route's egress
    // pass (sendJson → redactForUserDisplay) handed the browser
    // `Resource eventLoop.utilization: [REDACTED:credential]`. The
    // MEASUREMENT was destroyed by the layer that exists to protect it, on
    // every resource event with a long-enough mantissa.
    //
    // Driven through the REAL recorder and read back through the REAL query,
    // then through the egress choke point's own adapter — the exact path that
    // mangled it.
    const elu = 0.4237013706696966;
    const actorId = `ledger-redaction-resource-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      getTimelineRecorder().recordResource({
        metric: "eventLoop.utilization",
        value: elu,
        unit: "ratio",
        correlation: {},
      });
    });
    const events = getTimelineQuery()
      .byEventType("resource", { ascending: false, limit: 10 }).events
      .filter((event) => event.actorId === actorId);
    expect(events.length, "the resource sample must be recorded").toBe(1);
    const description = events[0]!.description;
    expect(description, "the recorded description is the measurement itself")
      .toBe(`Resource eventLoop.utilization: ${elu}ratio`);
    // THE EGRESS PASS: the REST choke point sends the timeline route's rows
    // through redactForUserDisplay. The measurement must survive it
    // VERBATIM — no marker, no truncation, byte-identical.
    const egressed = redactForUserDisplay({ events: [{ description }] }) as { events: { description: string }[] };
    expect(egressed.events[0]!.description, "a numeric metric value is not a credential").toBe(description);
  });

  test("a credential inside a resource description is still masked by the same egress pass", async () => {
    // THE OTHER DIRECTION, on the same channel: the fix must not have turned
    // the egress pass into a passthrough. A caller-supplied metric name (the
    // free-text half of a resource description) carrying a REGISTERED
    // credential is masked exactly as every other egress channel masks it.
    //
    // NOT written to the ledger: descriptions are stored VERBATIM (only
    // failure text is masked at the store), so planting a canary in a
    // description would put secret bytes on disk — the exact outcome this
    // file exists to make impossible. The channel under test is the EGRESS
    // adapter (sendJson → redactForUserDisplay), so the canary is taught to
    // the redactor the way production teaches it (the credential mint) and
    // driven through the adapter directly.
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    const description = `Resource eventLoop.utilization ${canary} (${marker}): 0.42ratio`;
    const out = redactForUserDisplay({ events: [{ description }] }) as { events: { description: string }[] };
    const egressed = out.events[0]!.description;
    expect(egressed, "the innocuous marker survives the same pass").toContain(marker);
    expect(egressed, "the canary does not").not.toContain(canary);
    expect(egressed, "and the pass says what it did").toContain("[REDACTED:");
    // The MEASUREMENT half survives the SAME pass that masked the canary —
    // both directions on one string, because they share one description.
    expect(egressed).toContain("0.42ratio");
  });

  test("masking happens BEFORE the chain hash, so the ledger still verifies", () => {
    // ORDER MATTERS AND NOTHING ELSE SAYS SO. The chain hash is computed over
    // the record envelope; masking after the hash would leave a ledger whose
    // every verification fails, and masking after the INSERT would leave the
    // projection and the log disagreeing. Both are silent until someone
    // verifies, so the verification is asserted here.
    const verification = getTimelineStore().verifyChain();
    expect(verification.valid, `chain verification failed: ${JSON.stringify(verification)}`).toBe(true);
    expect(verification.verifiedRecords, "the chain must have records to verify").toBeGreaterThan(0);
  });
});

describe("a credential cannot reach the ledger's DOCUMENTS either", () => {
  test("a key the model echoes back is masked BEFORE the response document exists — zero bytes on disk", async () => {
    // THE DOCUMENT CHANNEL IS UNMASKED BY DESIGN. The store masks an event's
    // failure text but deliberately stores document content verbatim — a
    // document's digest must match its stored bytes for the restore and
    // verification contracts to hold. So for captured payloads the redaction
    // has to happen BEFORE the document is built, inside the capture. This
    // drives the REAL streamChat (only the transport is stubbed, and its
    // scripted "output" echoes a live canary back the way a misbehaving
    // model would) and then reads both the stored documents and the ledger's
    // actual bytes.
    delete process.env.HARNESS_WEB_LLM_FIXTURES;
    resetStubLlmProvider();
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    stubLlmProviderScript.push(
      { type: "content", text: `as requested: ${canary} (${marker})` },
      { type: "finish", reason: "stop" },
    );
    const providerStore = parseProviderStore({
      providers: [{
        id: `echo-${randomUUID()}`,
        baseUrl: "https://provider.invalid/v1",
        apiKey: `sk-echo-${randomUUID().replaceAll("-", "")}`,
        models: [{ id: "echo-model" }],
      }],
    });
    const credential = resolveProviderCredential(providerStore, "echo-model", PROVIDER_FIXTURE_OWNER);
    const actorId = `ledger-redaction-doc-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      // The prompt declares the canary too: the request document must be the
      // REDACTED messages (what the provider actually received), not a
      // re-read of the raw prompt.
      for await (const event of streamChat(`my key is ${canary}, witness ${marker}`, {
        credential,
        systemPrompt: "echo probe",
      })) {
        void event;
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const events = providerEventsFor(actorId);
    expect(events.length, "the provider event must be recorded").toBe(1);
    const docs = events[0]!.documents ?? [];
    const request = docs.find((d) => d.name === TIMELINE_LLM_REQUEST_DOCUMENT);
    const response = docs.find((d) => d.name === TIMELINE_LLM_RESPONSE_DOCUMENT);
    expect(request, "the request document must be recorded").toBeDefined();
    expect(response, "the response document must be recorded").toBeDefined();
    // THE REQUEST DOCUMENT: the canary was masked at the choke point, and
    // the marker proves the document is this turn's real payload.
    expect(request!.contentJson ?? "").toContain("[REDACTED:");
    expect(request!.contentJson ?? "").not.toContain(canary);
    expect(request!.contentJson ?? "").toContain(marker);
    // THE RESPONSE DOCUMENT: the model echoed the key; the capture masked it
    // through the single redaction owner before the document existed.
    expect(response!.contentJson ?? "").toContain("[REDACTED:");
    expect(response!.contentJson ?? "").not.toContain(canary);
    expect(response!.contentJson ?? "").toContain(marker);
    // AND THE BYTES: both documents live in the ledger's files, so the file
    // scan is the assertion that matters.
    expect(
      canaryMatchesOnDisk(marker),
      `the witness is not in the ledger's bytes — the scan is reading the wrong ` +
      `files or reading them too early. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      canaryMatchesOnDisk(canary),
      `the canary appears in the ledger's bytes. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBe(0);
    resetStubLlmProvider();
  });

  test("a credential inside TOOL ARGUMENTS is masked before the args document exists — zero bytes on disk", async () => {
    // THE ARGS DOCUMENT IS A SECOND DOCUMENT CHANNEL, and it is fed by the
    // tool executor's args getter — the arguments the model sent. A tool
    // call's arguments are a likely place for a credential to appear (the
    // model echoing a key back into an execute_command, a fetch_page URL
    // with a token in it), and the store stores document content verbatim.
    // So the masking must happen INSIDE the args getter — before the args
    // exist as a value, let alone as a stored document. This drives the REAL
    // executeToolCall (the production choke point; the tool itself refuses,
    // which is fine — the args document travels on the failed event too) and
    // reads both the stored documents and the ledger's actual bytes.
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    const actorId = `ledger-redaction-args-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      const result = await executeToolCall("nonexistent_tool", { command: `echo ${canary} ${marker}` }, { projectRoot: process.cwd() });
      expect(result.success).toBe(false);
    });
    await new Promise((resolve) => setImmediate(resolve));
    const events = getTimelineQuery()
      .byEventType("tool", { ascending: false, limit: 500 }).events
      .filter((event) => event.actorId === actorId);
    expect(events.length, "the tool effect must be recorded").toBe(1);
    const docs = events[0]!.documents ?? [];
    const argsDoc = docs.find((d) => d.name === TIMELINE_EFFECT_ARGS_DOCUMENT);
    expect(argsDoc, "the args document must be recorded").toBeDefined();
    // THE MASKING HAPPENED BEFORE THE DOCUMENT: the redacted marker survives,
    // the canary does not.
    expect(argsDoc!.contentJson ?? "").toContain("[REDACTED:");
    expect(argsDoc!.contentJson ?? "").toContain(marker);
    expect(argsDoc!.contentJson ?? "").not.toContain(canary);
    // AND THE BYTES: the ledger's files hold every copy of every document.
    expect(
      canaryMatchesOnDisk(marker),
      `the witness is not in the ledger's bytes — the scan is reading the wrong ` +
      `files or reading them too early. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      canaryMatchesOnDisk(canary),
      `the canary appears in the ledger's bytes. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBe(0);
  });
});

describe("a credential cannot reach the ledger through the http lane's query string", () => {
  let srv: HttpTestServer;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ledger-redaction-http-",
      isPublicPath: () => true,
      register: (router) => {
        router.get("/ledger-redaction-http/probe", (ctx) => {
          // An ordinary route that answers and touches nothing: the leak was
          // the lane's own args capture, not anything a handler did.
          sendJson(ctx.res, { fine: true });
        });
      },
    });
  });

  afterAll(async () => {
    await srv.stop();
  });

  test("a credential in an HTTP request's QUERY STRING is masked before the http args document exists — zero bytes on disk", async () => {
    // THE QUERY STRING IS A THIRD DOCUMENT CHANNEL, and the one clients leak
    // through most naturally: `?token=…` and `?api_key=…` are ordinary
    // spelling on the web, and the http lane's args getter used to record
    // `url.search` verbatim — a live credential rode the request line
    // straight into the ledger's bytes. The store stores document content
    // verbatim, so the masking must happen INSIDE the args getter, before
    // the args exist as a value. This drives the REAL router over real HTTP
    // (the production choke point for the http lane) with a REGISTERED
    // canary in the query, and reads both the stored documents and the
    // ledger's actual bytes.
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    // LIVENESS FOR THE DETECTOR ON THIS SHAPE, before the ledger is
    // involved: a query string is a raw `key=value` concatenation, not the
    // JSON or prose the arms above drive, so the redactor must recognise the
    // credential there too.
    //
    // THE CREDENTIAL COMES FIRST, and the order is the calibrated behaviour
    // this arm holds. The declared-credential layer treats `&` (with `?`
    // and `#`) as a value terminator, so a credential at the HEAD of a
    // query masks only its own parameter and the innocuous parameter beside
    // it stays readable — which is the debugging value the lane is supposed
    // to keep (a reader can still see WHICH parameters the request carried).
    // The shape is also the honest harder case: pre-calibration the head
    // credential swallowed every later parameter into one mask, witness
    // included, and the disk scan below would have lost its liveness marker
    // to the very redaction under test.
    const query = `?token=${canary}&witness=${marker}`;
    expect(redactContent(query), "the redactor must know this key in a query string").not.toContain(canary);
    expect(redactContent(query), "the innocuous parameter must survive the same pass").toContain(marker);

    const { status } = await jsonRequest(srv.baseUrl, `/ledger-redaction-http/probe${query}`);
    expect(status, "the probe request itself must succeed").toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    const events = getTimelineQuery()
      .byEventType("network", { ascending: false, limit: 500 }).events
      .filter((event) => event.description === "http:GET /ledger-redaction-http/probe");
    expect(events.length, "the http effect must be recorded").toBeGreaterThanOrEqual(1);
    const docs = events[0]!.documents ?? [];
    const argsDoc = docs.find((d) => d.name === TIMELINE_EFFECT_ARGS_DOCUMENT);
    expect(argsDoc, "the args document must be recorded").toBeDefined();
    // THE MASKING HAPPENED BEFORE THE DOCUMENT, AND THE DEBUGGING VALUE
    // SURVIVED: the parameter names and the innocuous value are still there
    // (a reader can still see WHICH parameters the request carried), the
    // canary is not.
    expect(argsDoc!.contentJson ?? "").toContain("token=");
    expect(argsDoc!.contentJson ?? "").toContain(marker);
    expect(argsDoc!.contentJson ?? "").toContain("[REDACTED:");
    expect(argsDoc!.contentJson ?? "").not.toContain(canary);
    // EVERY document on the event, not only the args document: the canary
    // must not ride any other capture either.
    expect(JSON.stringify(docs), "no document on the http event may hold the canary").not.toContain(canary);
    // AND THE BYTES: the ledger's files hold every copy of every document.
    expect(
      canaryMatchesOnDisk(marker),
      `the witness is not in the ledger's bytes — the scan is reading the wrong ` +
      `files or reading them too early. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      canaryMatchesOnDisk(canary),
      `the canary appears in the ledger's bytes. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBe(0);
  });

  test("a credential followed by a `#fragment` masks only its own parameter — the fragment stays readable", () => {
    // THE OTHER TWO TERMINATORS, each pinned the way `&` is pinned above.
    // `#` opens a URL fragment, so a credential at the head of a query runs
    // INTO one whenever the URL carries a fragment after the query — and
    // the fragment is exactly the neighbouring structure the calibrated
    // boundary exists to keep readable: without `#` in the terminator set,
    // the mask crosses the boundary and swallows the fragment into the
    // credential's span, destroying content that is not credential bytes.
    //
    // THIS SHAPE CANNOT RIDE THE REQUEST LINE, and that is a property of
    // the wire, not a gap in the arm: a fragment is client-side only (the
    // URL parser drops it before a request is sent, and the router reads
    // its query through `new URL(...).search`, which excludes it), so no
    // http args document can ever contain one. What CAN hold this shape
    // is every OTHER string the same redaction owner masks — a full URL
    // with a fragment in failure text, in a tool's arguments, in a pasted
    // message — and the args getter calls that same owner. The pin sits at
    // the owner, one boundary earlier than the lane.
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    const query = `?token=${canary}#${marker}`;
    expect(redactContent(query), "the redactor must bound the value at the fragment").not.toContain(canary);
    expect(redactContent(query), "the fragment after the boundary must survive the same pass").toContain(marker);
  });

  test("a credential whose value runs into a second `?` masks only up to the boundary — document and bytes included", async () => {
    // A `?` OPENS the query, and only the FIRST one does: every later `?`
    // in the string is value bytes, and it rides the request line verbatim
    // (`?token=…?…` is a legal query whose first parameter carries a raw
    // `?` mid-value). Without `?` in the terminator set, the mask runs
    // through the boundary and swallows everything after the credential
    // into one span. Unlike the fragment, this shape DOES reach the
    // server, so the arm drives the full lane: the real router, the stored
    // args document, and the ledger's actual bytes.
    const canary = freshCanary();
    mintThroughTheRealDoor(canary);
    const marker = witness();
    const query = `?token=${canary}?${marker}`;
    expect(redactContent(query), "the redactor must bound the value at the second `?`").not.toContain(canary);
    expect(redactContent(query), "the tail after the boundary must survive the same pass").toContain(marker);

    const { status } = await jsonRequest(srv.baseUrl, `/ledger-redaction-http/probe${query}`);
    expect(status, "the probe request itself must succeed").toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    const events = getTimelineQuery()
      .byEventType("network", { ascending: false, limit: 500 }).events
      .filter((event) => event.description === "http:GET /ledger-redaction-http/probe");
    expect(events.length, "the http effect must be recorded").toBeGreaterThanOrEqual(1);
    // THIS ARM'S OWN EVENT, found by its marker rather than by position:
    // the `&` arm above hits the same route, so "the newest event" would be
    // a positional accident rather than a claim.
    const event = events.find((e) =>
      (e.documents ?? []).some(
        (d) => d.name === TIMELINE_EFFECT_ARGS_DOCUMENT && (d.contentJson ?? "").includes(marker),
      ),
    );
    expect(event, "the http event carrying this arm's marker must be recorded").toBeDefined();
    const docs = event!.documents ?? [];
    const argsDoc = docs.find((d) => d.name === TIMELINE_EFFECT_ARGS_DOCUMENT);
    expect(argsDoc, "the args document must be recorded").toBeDefined();
    // The credential masked to its own parameter; the tail after the raw
    // `?` is still there (a reader can still see what the request carried).
    expect(argsDoc!.contentJson ?? "").toContain("token=");
    expect(argsDoc!.contentJson ?? "").toContain(marker);
    expect(argsDoc!.contentJson ?? "").toContain("[REDACTED:");
    expect(argsDoc!.contentJson ?? "").not.toContain(canary);
    // EVERY document on the event, not only the args document.
    expect(JSON.stringify(docs), "no document on this http event may hold the canary").not.toContain(canary);
    // AND THE BYTES: the ledger's files hold every copy of every document.
    expect(
      canaryMatchesOnDisk(marker),
      `the witness is not in the ledger's bytes — the scan is reading the wrong ` +
      `files or reading them too early. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      canaryMatchesOnDisk(canary),
      `the canary appears in the ledger's bytes. Files scanned: ${ledgerFiles().join(", ")}`,
    ).toBe(0);
  });
});
