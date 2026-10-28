/**
 * THE RELEASE ASSETS' RAW BODIES on the forge port (#400): `upload` to the
 * uploads host, `download` through GitHub's signed redirect and
 * `downloadToFile`, streamed through the one HTTP door, size-bounded,
 * checksum-verified and bounded by progress, against the fake GitHub:
 * - an upload streams its chunks with the credential and its declared
 *   length, and answers GitHub's record, whose digest must be the one sent;
 * - a body that does not match its declared size or SHA-256 is cut before
 *   it completes, at every size and chunking: once the server has seen the
 *   connection end, no request was handled and nothing is stored; an asset
 *   over the bound is refused before anything is sent; a record carrying
 *   another digest is refused;
 * - a download follows ONE redirect, only to `assets.origins` and never with
 *   the API credential; a chain is refused; the bytes are held to the
 *   caller's SHA-256, and the sink never sees a byte past the bound;
 * - a download to a file publishes only verified bytes: a refused download
 *   leaves no file, no temporary sibling, and an existing file untouched;
 * - a transfer that stops moving ends at the stall bound, and one that keeps
 *   moving is never cut, however long it takes (the mocked clock).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import type { ForgeAssetBody, ForgeEndpoint } from "../../src/workflow/forge/port.ts";
import { address, connectionsClosed, connectionsSettled, holdRequestBodies, mockDoorClock } from "../support/loopback-upstream.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { FAKE_ASSETS_ORIGIN, FAKE_UPLOADS_ORIGIN, fakeGithub, type FakeGithub } from "./fake-github.ts";

const UPLOADS = "/repos/o/r/releases/1/assets";
const ASSETS_HOST = new URL(FAKE_ASSETS_ORIGIN).host;
const UPLOADS_HOST = new URL(FAKE_UPLOADS_ORIGIN).host;

function hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `bytes` as a streamed body in `chunk`-byte chunks, declaring `declared` (defaults: its own size and digest). */
function body(bytes: Uint8Array, declared: Partial<Pick<ForgeAssetBody, "size" | "sha256">> = {}, chunk = 16_384): ForgeAssetBody {
  return {
    chunks: (async function* () { for (let at = 0; at < bytes.byteLength; at += chunk) yield bytes.subarray(at, at + chunk); })(),
    size: declared.size ?? bytes.byteLength,
    sha256: declared.sha256 ?? hex(bytes),
  };
}

function client(fake: FakeGithub, assets: Partial<ForgeEndpoint["assets"]> = {}, overrides: Partial<ForgeEndpoint> = {}) {
  const endpoint = fake.endpoint(overrides);
  return githubClient({ ...endpoint, assets: { ...endpoint.assets, ...assets } }, memoryCredential("user:publisher", fake.userToken("publisher")));
}

/** An asset uploaded through the client: its id. */
async function uploaded(fake: FakeGithub, bytes: Uint8Array): Promise<number> {
  return (await client(fake).upload<{ id: number }>({ path: UPLOADS, query: { name: "docs.tar.gz" }, contentType: "application/gzip", body: body(bytes) })).data.id;
}

test("an upload streams the asset to the uploads host with the credential and its length, and answers GitHub's record", async () => {
  const fake = fakeGithub();
  const bytes = new Uint8Array(randomBytes(200_000));
  const answer = await client(fake).upload<{ id: number; name: string; size: number; digest: string }>({ path: UPLOADS, query: { name: "bridlewise-0.1.0.tar.gz" }, contentType: "application/gzip", body: body(bytes) });
  assert.equal(answer.status, 201);
  assert.deepEqual({ name: answer.data.name, size: answer.data.size, digest: answer.data.digest }, { name: "bridlewise-0.1.0.tar.gz", size: 200_000, digest: `sha256:${hex(bytes)}` });
  const stored = fake.assets.get(answer.data.id);
  assert.ok(stored !== undefined && Buffer.from(stored.bytes).equals(Buffer.from(bytes)), "GitHub holds exactly the bytes sent");
  const sent = fake.requests.find((request) => request.host === UPLOADS_HOST)!;
  assert.equal(sent.headers.get("content-length"), "200000");
  assert.equal(sent.headers.get("content-type"), "application/gzip");
  assert.match(sent.headers.get("authorization") ?? "", /^Bearer gho_/u, "the upload carries the credential");
});

test("an upload whose bytes break their declaration is cut before it completes: once the server has seen the connection end, nothing was handled or stored", async () => {
  for (const size of [1, 16_384, 100_000]) {
    const bytes = new Uint8Array(randomBytes(size));
    for (const chunk of [4_096, 16_384, size]) {
      for (const [why, declared] of [
        ["another digest", { sha256: hex(new Uint8Array(randomBytes(32))) }],
        ["a longer declared size", { size: size + 1 }],
        ["a shorter declared size", { size: size - 1 }],
      ] as const) {
        const fake = fakeGithub();
        const mark = connectionsClosed();
        await within(assert.rejects(client(fake).upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(bytes, declared, chunk) }),
          (error: unknown) => isForgeError(error, "forge_asset_integrity"), `${why}, ${String(size)} bytes in ${String(chunk)}-byte chunks`), `${why}, ${String(size)}/${String(chunk)}`);
        await connectionsSettled(mark);
        assert.deepEqual(fake.requests.filter((request) => request.host === UPLOADS_HOST), [], `${why}, ${String(size)}/${String(chunk)}: the server never handled a complete body`);
        assert.equal(fake.assets.size, 0, `${why}, ${String(size)}/${String(chunk)}: nothing was stored`);
      }
    }
  }
  // Over the bound: refused before anything is sent.
  const fake = fakeGithub();
  await assert.rejects(client(fake, { maxBytes: 50_000 }).upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(new Uint8Array(100_000)) }), (error: unknown) => isForgeError(error, "forge_asset_too_large"));
  assert.equal(fake.requests.length, 0);
});

test("an upload GitHub records with another digest is refused: the release would hold bytes nobody checked", async () => {
  const fake = fakeGithub();
  fake.route("POST", /^\/repos\/o\/r\/releases\/1\/assets$/u, () => ({ status: 201, body: { id: 7, name: "x.bin", size: 4, digest: `sha256:${"0".repeat(64)}` } }));
  await assert.rejects(client(fake).upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(new Uint8Array([1, 2, 3, 4])) }), (error: unknown) => isForgeError(error, "forge_asset_integrity") && /recorded/u.test(error.message));
});

test("a download follows GitHub's redirect to the asset host without the credential, holds the bytes to the caller's SHA-256, and the sink never sees a byte past the bound", async () => {
  const fake = fakeGithub();
  const bytes = new Uint8Array(randomBytes(150_000));
  const id = await uploaded(fake, bytes);
  const received: Uint8Array[] = [];
  const answer = await client(fake).download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(bytes), sink: (chunk) => { received.push(chunk); } });
  assert.deepEqual(answer, { bytes: 150_000, sha256: hex(bytes) });
  assert.ok(Buffer.concat(received).equals(Buffer.from(bytes)), "the sink saw exactly the asset's bytes");
  const signed = fake.requests.filter((request) => request.host === ASSETS_HOST);
  assert.equal(signed.length, 1);
  assert.equal(signed[0]!.headers.get("authorization"), null, "the signed URL never sees the API credential");
  // Another digest than the caller's: refused once the body ends.
  await assert.rejects(client(fake).download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(new Uint8Array([9])), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_integrity"));
  // Over the bound: refused while reading, and no byte past the bound ever reaches the sink.
  let seen = 0;
  await assert.rejects(client(fake, { maxBytes: 100_000 }).download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(bytes), sink: (chunk) => { seen += chunk.byteLength; } }), (error: unknown) => isForgeError(error, "forge_asset_too_large"));
  assert.ok(seen <= 100_000, `the sink saw ${String(seen)} bytes, past the bound`);
});

test("a download is redirected once, only to an asset origin: another origin, a look-alike and a chain from the asset host are refused, and nothing is asked there", async () => {
  const fake = fakeGithub();
  fake.route("GET", /^\/repos\/o\/r\/releases\/assets\/1$/u, () => ({ status: 302, headers: { location: `${address("https://elsewhere.example")}/asset` } }));
  await assert.rejects(client(fake).download({ path: "/repos/o/r/releases/assets/1", sha256: "a".repeat(64), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_redirect_refused"));
  assert.ok(!fake.requests.some((request) => request.host === "elsewhere.example"), "the other origin was never asked");
  // A path that only starts like an allowed origin is not one (the origin is matched with its trailing slash).
  fake.route("GET", /^\/repos\/o\/r\/releases\/assets\/2$/u, () => ({ status: 302, headers: { location: `${address(FAKE_ASSETS_ORIGIN)}-evil/asset` } }));
  await assert.rejects(client(fake).download({ path: "/repos/o/r/releases/assets/2", sha256: "a".repeat(64), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_redirect_refused"));
  // The asset host redirecting again, even to its own origin: a chain is never followed.
  const id = await uploaded(fake, new Uint8Array([1, 2, 3]));
  fake.onAssetHost((request) => request.path === "/chained" ? { status: 200, raw: new Uint8Array([1, 2, 3]) } : { status: 302, headers: { location: `${address(FAKE_ASSETS_ORIGIN)}/chained` } });
  await assert.rejects(client(fake).download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(new Uint8Array([1, 2, 3])), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_redirect_refused") && /chain/u.test(error.message));
  assert.ok(!fake.requests.some((request) => request.host === ASSETS_HOST && request.path === "/chained"), "the chained location was never asked");
});

test("a download to a file publishes only verified bytes: a refused download leaves no file, no temporary sibling, and an existing file untouched", async () => {
  const fake = fakeGithub();
  const directory = createTempDir("forge-asset-download");
  const bytes = new Uint8Array(randomBytes(120_000));
  const id = await uploaded(fake, bytes);
  const path = `/repos/o/r/releases/assets/${String(id)}`;
  const destination = join(directory, "docs.tar.gz");
  assert.deepEqual(await client(fake).downloadToFile({ path, sha256: hex(bytes), destination }), { bytes: 120_000, sha256: hex(bytes) });
  assert.ok(readFileSync(destination).equals(Buffer.from(bytes)), "the file holds exactly the asset");
  // A refused checksum: the existing file is untouched, and no temporary file is left beside it.
  await assert.rejects(client(fake).downloadToFile({ path, sha256: hex(new Uint8Array([7])), destination }), (error: unknown) => isForgeError(error, "forge_asset_integrity"));
  assert.ok(readFileSync(destination).equals(Buffer.from(bytes)), "the existing file is untouched");
  assert.deepEqual(readdirSync(directory), ["docs.tar.gz"], "no temporary sibling is left");
  // A refused first download: no file at all.
  const fresh = join(directory, "fresh.tar.gz");
  await assert.rejects(client(fake, { maxBytes: 100_000 }).downloadToFile({ path, sha256: hex(bytes), destination: fresh }), (error: unknown) => isForgeError(error, "forge_asset_too_large"));
  assert.equal(existsSync(fresh), false, "no partial file");
  assert.deepEqual(readdirSync(directory), ["docs.tar.gz"]);
});

/** `promise`, settled within event-loop turns (never a clock): one still pending after them is a red with its name, never a hang. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let settled = false;
  const watched = promise.finally(() => { settled = true; });
  for (let turn = 0; turn < 200_000 && !settled; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(settled, `${what} never settled`);
  return watched;
}

/** Event-loop turns until `condition` holds (never a clock). */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200_000 && !condition(); turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(condition(), "the condition never held");
}

test("no total wall cap: a slow download and a slow upload that keep moving past the floor finish, however long; a drip under the floor, or silence, ends (mocked clock)", async (t) => {
  mockDoorClock(t);
  const fake = fakeGithub();
  const id = await uploaded(fake, new Uint8Array([0]));
  const path = `/repos/o/r/releases/assets/${String(id)}`;
  // The floor in this test: 64 bytes in every 1 s window, and a request timeout of 1 s that assets do not use.
  const floor = { progressWindowMs: 1_000, minBytesPerWindow: 64 };
  // A trickle the test drives: each chunk is pushed only when the test says so.
  let push: ((chunk: Uint8Array | null) => void) | undefined;
  fake.onAssetHost(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => chunk === null ? controller.close() : controller.enqueue(chunk); } }), { status: 200 }));
  // Moving: twenty 64-byte chunks, one every 900 ms (18 s in all, eighteen windows), all arrive.
  const moving = new Uint8Array(randomBytes(20 * 64));
  let received = 0;
  const slow = client(fake, floor, { timeoutMs: 1_000 }).download({ path, sha256: hex(moving), sink: (chunk) => { received += chunk.byteLength; } });
  await until(() => push !== undefined);
  for (let index = 0; index < 20; index += 1) {
    t.mock.timers.tick(900);
    push!(moving.subarray(index * 64, (index + 1) * 64));
    await until(() => received === (index + 1) * 64);
  }
  push!(null);
  assert.deepEqual(await within(slow, "the slow download"), { bytes: moving.byteLength, sha256: hex(moving) });
  // A drip under the floor: the first window passes (GitHub's answer arrived in it), the second moves 10 bytes and ends it.
  push = undefined;
  let got = 0;
  const dripping = client(fake, floor).download({ path, sha256: hex(moving), sink: (chunk) => { got += chunk.byteLength; } });
  const dripRefused = assert.rejects(dripping, (error: unknown) => isForgeError(error, "forge_asset_stalled"));
  await until(() => push !== undefined);
  push!(moving.subarray(0, 10));
  await until(() => got === 10);
  t.mock.timers.tick(1_000);
  push!(moving.subarray(10, 20));
  await until(() => got === 20);
  t.mock.timers.tick(1_000);
  await within(dripRefused, "the drip's end at the floor");
  // A slow UPLOAD that keeps moving (the reviewer's shape): twenty 64-byte chunks, one every 900 ms, the 1 s request timeout far behind.
  fake.onAssetHost(undefined);
  const bytes = new Uint8Array(randomBytes(20 * 64));
  let release: (() => void) | undefined;
  let sent = 0;
  const chunks = (async function* () {
    for (let index = 0; index < 20; index += 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      sent += 64;
      yield bytes.subarray(index * 64, (index + 1) * 64);
    }
  })();
  const upload = client(fake, floor, { timeoutMs: 1_000 }).upload<{ size: number }>({ path: UPLOADS, query: { name: "slow.bin" }, contentType: "application/octet-stream", body: { chunks, size: bytes.byteLength, sha256: hex(bytes) } });
  for (let index = 0; index < 20; index += 1) {
    await until(() => release !== undefined);
    t.mock.timers.tick(900);
    const go = release!;
    release = undefined;
    go();
    await until(() => sent === (index + 1) * 64);
  }
  assert.equal((await within(upload, "the slow upload")).data.size, bytes.byteLength, "the slow upload landed whole");
});

test("a stream that reaches its declared size exactly and then yields more is refused before it completes (the reviewer's shape), at every chunk boundary", async () => {
  // 12 288 bytes declared as 8 192, with the SHA-256 of the first 8 192: size and digest hold at 8 192, and more follows.
  const bytes = new Uint8Array(randomBytes(12_288));
  for (const chunk of [4_096, 8_192, 1_024]) {
    const fake = fakeGithub();
    const mark = connectionsClosed();
    await within(assert.rejects(client(fake).upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(bytes, { size: 8_192, sha256: hex(bytes.subarray(0, 8_192)) }, chunk) }),
      (error: unknown) => isForgeError(error, "forge_asset_integrity"), String(chunk)), String(chunk));
    await connectionsSettled(mark);
    assert.deepEqual(fake.requests.filter((request) => request.host === UPLOADS_HOST), [], `${String(chunk)}: the server never handled a complete body`);
    assert.equal(fake.assets.size, 0, `${String(chunk)}: nothing was stored`);
  }
});

test("a local failure (a full disk) and the caller's own cancellation are their own failures, never GitHub's", async () => {
  const fake = fakeGithub();
  const bytes = new Uint8Array(randomBytes(40_000));
  const id = await uploaded(fake, bytes);
  const path = `/repos/o/r/releases/assets/${String(id)}`;
  const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  await assert.rejects(client(fake).download({ path, sha256: hex(bytes), sink: () => { throw full; } }),
    (error: unknown) => isForgeError(error, "forge_asset_sink_failed") && /ENOSPC/u.test(error.message));
  // The caller cancels with its own reason (not an AbortError): it gets that reason back, unchanged.
  const controller = new AbortController();
  const reason = new Error("the release was withdrawn");
  await assert.rejects(client(fake).download({ path, sha256: hex(bytes), signal: controller.signal, sink: () => { controller.abort(reason); } }), (error: unknown) => error === reason);
});

test("once an upload's every byte is handed over, the floor stops and GitHub's answer has its own declared silence bound: storing the asset for three windows is not a stall, and past the bound it is forge_asset_unanswered (mocked clock)", async (t) => {
  mockDoorClock(t);
  const fake = fakeGithub();
  const bounds = { progressWindowMs: 1_000, minBytesPerWindow: 64, answerSilenceMs: 5_000 };
  const bytes = new Uint8Array(randomBytes(64 * 1024));
  // GitHub holds its answer (the reviewer's shape: the body is fully received, the answer comes windows later).
  let release: (() => void) | undefined;
  fake.onUploadsHost((request) => new Promise((resolve) => {
    release = () => resolve({ status: 201, body: { id: 9, name: "held.bin", size: request.bytes?.byteLength ?? 0, digest: `sha256:${hex(request.bytes ?? new Uint8Array())}` } });
  }));
  const held = client(fake, bounds).upload<{ size: number }>({ path: UPLOADS, query: { name: "held.bin" }, contentType: "application/octet-stream", body: body(bytes) });
  await until(() => release !== undefined);
  for (let window = 0; window < 3; window += 1) t.mock.timers.tick(1_000);
  release!();
  assert.equal((await within(held, "the held upload")).data.size, bytes.byteLength, "three silent windows while GitHub stores it: not a stall");
  // Past the silence bound: refused by its own code, never the floor's.
  release = undefined;
  const silent = client(fake, bounds).upload({ path: UPLOADS, query: { name: "silent.bin" }, contentType: "application/octet-stream", body: body(bytes) });
  const refused = assert.rejects(silent, (error: unknown) => isForgeError(error, "forge_asset_unanswered"));
  await until(() => release !== undefined);
  t.mock.timers.tick(4_999);
  t.mock.timers.tick(1);
  await within(refused, "the unanswered upload's refusal");
  fake.onUploadsHost(undefined);
});

test("a download's answer counts in its window: headers that arrive before the first byte keep the first window from stalling (mocked clock)", async (t) => {
  mockDoorClock(t);
  const fake = fakeGithub();
  const id = await uploaded(fake, new Uint8Array([0]));
  const bytes = new Uint8Array(randomBytes(128));
  let push: ((chunk: Uint8Array | null) => void) | undefined;
  fake.onAssetHost(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => chunk === null ? controller.close() : controller.enqueue(chunk); } }), { status: 200 }));
  let got = 0;
  const late = client(fake, { progressWindowMs: 1_000, minBytesPerWindow: 64 }).download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(bytes), sink: (chunk) => { got += chunk.byteLength; } });
  await until(() => push !== undefined);
  // The headers reach the client (already in the kernel's buffers when written; event-loop turns, never a clock).
  for (let turn = 0; turn < 2_000; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  // The first window carries no byte, only the answer: it passes. The second carries the bytes.
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(500);
  push!(bytes);
  await until(() => got === bytes.byteLength);
  push!(null);
  assert.deepEqual(await within(late, "the late download"), { bytes: 128, sha256: hex(bytes) });
});

test("the silence bound starts only once the last byte is WRITTEN: an upload whose final chunk is still blocked on a receiver that does not read is judged by the floor (a stall), never the answer's bound (mocked clock)", async (t) => {
  mockDoorClock(t);
  const fake = fakeGithub();
  const release = holdRequestBodies();
  t.after(release);
  const first = new Uint8Array(randomBytes(64 * 1024));
  // The final chunk is far larger than the loopback socket's buffers: its write blocks while nobody reads.
  const last = new Uint8Array(32 * 1024 * 1024);
  let pulledLast = false;
  const chunks = (async function* () { yield first; pulledLast = true; yield last; })();
  const whole = new Uint8Array(first.byteLength + last.byteLength);
  whole.set(first);
  whole.set(last, first.byteLength);
  const stalled = client(fake, { maxBytes: 64 * 1024 * 1024, progressWindowMs: 1_000, minBytesPerWindow: 64, answerSilenceMs: 60_000 })
    .upload({ path: UPLOADS, query: { name: "blocked.bin" }, contentType: "application/octet-stream", body: { chunks, size: whole.byteLength, sha256: hex(whole) } });
  const refused = assert.rejects(stalled, (error: unknown) => isForgeError(error, "forge_asset_stalled"));
  await until(() => pulledLast);
  for (let turn = 0; turn < 2_000; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  // The first window carried the bytes; the second carries none, and the answer's bound has not started.
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(1_000);
  await within(refused, "the blocked upload's stall");
});

test("an upload's answer ends its silence bound and returns to the floor: an answer whose body then stops is a stall, judged within a window, not at the silence bound (mocked clock)", async (t) => {
  mockDoorClock(t);
  const fake = fakeGithub();
  let answered = false;
  // GitHub answers at once, then its answer's body never ends.
  fake.onUploadsHost(() => { answered = true; return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), { status: 201 }); });
  const bytes = new Uint8Array(randomBytes(4 * 1024));
  const silent = client(fake, { progressWindowMs: 1_000, minBytesPerWindow: 64, answerSilenceMs: 60_000 }).upload({ path: UPLOADS, query: { name: "answered.bin" }, contentType: "application/octet-stream", body: body(bytes) });
  const refused = assert.rejects(silent, (error: unknown) => isForgeError(error, "forge_asset_stalled"));
  await until(() => answered);
  for (let turn = 0; turn < 2_000; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(1_000);
  await within(refused, "the answered upload's stall");
  fake.onUploadsHost(undefined);
});
