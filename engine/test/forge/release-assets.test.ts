/**
 * THE RELEASE ASSETS' RAW BODIES on the forge port (#400): `upload` to the
 * uploads host and `download` through GitHub's signed redirect, both
 * streamed through the one HTTP door, size-bounded and checksum-verified,
 * against the fake GitHub:
 * - an upload streams its chunks with the credential and its declared
 *   length, and answers GitHub's record, whose digest must be the one sent;
 * - a body that does not match its declared size or SHA-256 is cut before
 *   it completes, so GitHub stores nothing; an asset over the bound is
 *   refused before anything is sent; a record carrying another digest is
 *   refused;
 * - a download follows GitHub's redirect only to `assetOrigins`, never
 *   with the API credential, and holds the bytes to the caller's SHA-256
 *   and to the bound.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import type { ForgeAssetBody } from "../../src/workflow/forge/port.ts";
import { address } from "../support/loopback-upstream.ts";
import { FAKE_ASSETS_ORIGIN, FAKE_UPLOADS_ORIGIN, fakeGithub } from "./fake-github.ts";

const UPLOADS = "/repos/o/r/releases/1/assets";

function hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `bytes` as a streamed body in `size`-byte chunks, declaring `declared` (defaults: its own size and digest). */
function body(bytes: Uint8Array, declared: Partial<Pick<ForgeAssetBody, "size" | "sha256">> = {}, chunk = 16_384): ForgeAssetBody {
  return {
    chunks: (async function* () { for (let at = 0; at < bytes.byteLength; at += chunk) yield bytes.subarray(at, at + chunk); })(),
    size: declared.size ?? bytes.byteLength,
    sha256: declared.sha256 ?? hex(bytes),
  };
}

function setup(overrides: Parameters<ReturnType<typeof fakeGithub>["endpoint"]>[0] = {}) {
  const fake = fakeGithub();
  const client = githubClient(fake.endpoint(overrides), memoryCredential("user:publisher", fake.userToken("publisher")));
  return { fake, client };
}

test("an upload streams the asset to the uploads host with the credential and its length, and answers GitHub's record", async () => {
  const { fake, client } = setup();
  const bytes = new Uint8Array(randomBytes(200_000));
  const answer = await client.upload<{ id: number; name: string; size: number; digest: string }>({ path: UPLOADS, query: { name: "bridlewise-0.1.0.tar.gz" }, contentType: "application/gzip", body: body(bytes) });
  assert.equal(answer.status, 201);
  assert.deepEqual({ name: answer.data.name, size: answer.data.size, digest: answer.data.digest }, { name: "bridlewise-0.1.0.tar.gz", size: 200_000, digest: `sha256:${hex(bytes)}` });
  const stored = fake.assets.get(answer.data.id);
  assert.ok(stored !== undefined && Buffer.from(stored.bytes).equals(Buffer.from(bytes)), "GitHub holds exactly the bytes sent");
  const sent = fake.requests.find((request) => request.host === new URL(FAKE_UPLOADS_ORIGIN).host)!;
  assert.equal(sent.headers.get("content-length"), "200000");
  assert.equal(sent.headers.get("content-type"), "application/gzip");
  assert.match(sent.headers.get("authorization") ?? "", /^Bearer gho_/u, "the upload carries the credential");
});

test("an upload whose bytes break their declaration is cut before it completes: GitHub stores nothing", async () => {
  const bytes = new Uint8Array(randomBytes(100_000));
  for (const [why, declared] of [
    ["another digest", { sha256: hex(new Uint8Array(randomBytes(32))) }],
    ["a longer declared size", { size: 100_001 }],
    ["a shorter declared size", { size: 99_999 }],
  ] as const) {
    const { fake, client } = setup();
    await assert.rejects(client.upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(bytes, declared) }),
      (error: unknown) => isForgeError(error, "forge_asset_integrity"), why);
    assert.equal(fake.assets.size, 0, `${why}: nothing was stored`);
  }
  // Over the bound: refused before anything is sent.
  const { fake, client } = setup({ maxAssetBytes: 50_000 });
  await assert.rejects(client.upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(bytes) }), (error: unknown) => isForgeError(error, "forge_asset_too_large"));
  assert.equal(fake.requests.length, 0);
});

test("an upload GitHub records with another digest is refused: the release would hold bytes nobody checked", async () => {
  const { fake, client } = setup();
  fake.route("POST", /^\/repos\/o\/r\/releases\/1\/assets$/u, () => ({ status: 201, body: { id: 7, name: "x.bin", size: 4, digest: `sha256:${"0".repeat(64)}` } }));
  await assert.rejects(client.upload({ path: UPLOADS, query: { name: "x.bin" }, contentType: "application/octet-stream", body: body(new Uint8Array([1, 2, 3, 4])) }), (error: unknown) => isForgeError(error, "forge_asset_integrity") && /recorded/u.test(error.message));
});

test("a download follows GitHub's redirect to the asset host without the credential, and holds the bytes to the caller's SHA-256", async () => {
  const { fake, client } = setup();
  const bytes = new Uint8Array(randomBytes(150_000));
  const id = (await client.upload<{ id: number }>({ path: UPLOADS, query: { name: "docs.tar.gz" }, contentType: "application/gzip", body: body(bytes) })).data.id;
  const received: Uint8Array[] = [];
  const answer = await client.download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(bytes), sink: (chunk) => { received.push(chunk); } });
  assert.deepEqual(answer, { bytes: 150_000, sha256: hex(bytes) });
  assert.ok(Buffer.concat(received).equals(Buffer.from(bytes)), "the sink saw exactly the asset's bytes");
  const signed = fake.requests.filter((request) => request.host === new URL(FAKE_ASSETS_ORIGIN).host);
  assert.equal(signed.length, 1);
  assert.equal(signed[0]!.headers.get("authorization"), null, "the signed URL never sees the API credential");
  // Another digest than the caller's: refused once the body ends.
  await assert.rejects(client.download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(new Uint8Array([9])), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_integrity"));
  // Over the bound: refused while reading.
  const small = githubClient(fake.endpoint({ maxAssetBytes: 100_000 }), memoryCredential("user:publisher", fake.userToken("publisher")));
  await assert.rejects(small.download({ path: `/repos/o/r/releases/assets/${String(id)}`, sha256: hex(bytes), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_too_large"));
});

test("a download redirected anywhere but the asset origins is refused, and nothing is asked there", async () => {
  const { fake, client } = setup();
  fake.route("GET", /^\/repos\/o\/r\/releases\/assets\/1$/u, () => ({ status: 302, headers: { location: `${address("https://elsewhere.example")}/asset` } }));
  await assert.rejects(client.download({ path: "/repos/o/r/releases/assets/1", sha256: "a".repeat(64), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_redirect_refused"));
  assert.ok(!fake.requests.some((request) => request.host === "elsewhere.example"), "the other origin was never asked");
  // A path that only starts like an allowed origin is not one (the origin is matched with its trailing slash).
  fake.route("GET", /^\/repos\/o\/r\/releases\/assets\/2$/u, () => ({ status: 302, headers: { location: `${address(FAKE_ASSETS_ORIGIN)}-evil/asset` } }));
  await assert.rejects(client.download({ path: "/repos/o/r/releases/assets/2", sha256: "a".repeat(64), sink: () => {} }), (error: unknown) => isForgeError(error, "forge_asset_redirect_refused"));
});
