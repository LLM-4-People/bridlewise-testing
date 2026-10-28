// @vitest-environment node
/**
 * PWA tests — the web UI is installable: manifest, service worker,
 * registration, icons. Verifies the deliverables mechanically (no browser
 * needed): the manifest is well-formed + served at the root, the service
 * worker is hand-written (no deps) with the required event handlers + the
 * task's caching strategies, registration is wired in exactly one entry
 * owner, and the icons referenced by the manifest actually exist with the
 * declared sizes.
 *
 * no new runtime deps — the SW + icon generator use only
 * Node/browser built-ins. never weaken/fake.
 */
import { describe, it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { cpSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { read } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program (as in floor-site-links.test.ts).
import { markColors, markOutputs } from "../../scripts/generate-pwa-icons.mjs";
import { assetsDigest, cachedFiles, committedServiceWorker, precachedUrls, serviceWorkerDigestPlugin, uncoveredPrecache, withAssetsDigest } from "../../scripts/service-worker-cache.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
const root = resolve(import.meta.dirname, "../..");
// The worker's own cache names: its generation and the generated icons digest (scripts/generate-pwa-icons.mjs).
const SW_SOURCE = readFileSync(resolve(root, "public/sw.js"), "utf8");
const CACHE_VERSION = `${/const CACHE_GENERATION = "([^"]+)";/u.exec(SW_SOURCE)![1]!}-${/const ASSETS_DIGEST = "([0-9a-f]{12})";/u.exec(SW_SOURCE)![1]!}`;
const STATIC_CACHE = `harness-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `harness-runtime-${CACHE_VERSION}`;
function exists(rel: string): boolean {
  return existsSync(resolve(root, rel));
}

describe("PWA — manifest (public/manifest.json)", () => {
  const manifest = JSON.parse(read("public/manifest.json")) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };

  it("has name, short_name, start_url, scope, display standalone", () => {
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("declares theme_color + background_color (valid hex)", () => {
    expect(/^#[0-9a-f]{6}$/i.test(manifest.theme_color)).toBe(true);
    expect(/^#[0-9a-f]{6}$/i.test(manifest.background_color)).toBe(true);
  });

  it("declares at least one 192px + one 512px PNG icon (installability)", () => {
    const pngs = manifest.icons.filter((i) => i.type === "image/png");
    expect(pngs.some((i) => i.sizes === "192x192")).toBe(true);
    expect(pngs.some((i) => i.sizes === "512x512")).toBe(true);
  });

  it("every referenced icon file exists on disk", () => {
    for (const icon of manifest.icons) {
      // icon.src is a root-absolute path like /icons/icon-192.png
      const rel = icon.src.replace(/^\//, "");
      expect(exists(`public/${rel}`)).toBe(true);
    }
  });

  it("the PNG icons are valid PNGs with the declared dimensions", () => {
    for (const icon of manifest.icons.filter((i) => i.type === "image/png")) {
      const rel = icon.src.replace(/^\//, "");
      const buf = readFileSync(resolve(root, `public/${rel}`));
      // PNG signature.
      expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      // IHDR width/height (big-endian, bytes 16–23) match the declared size.
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(buf.readUInt32BE(16)).toBe(w);
      expect(buf.readUInt32BE(20)).toBe(h);
    }
  });
});

describe("PWA — service worker (public/sw.js)", () => {
  const sw = read("public/sw.js");

  it("is hand-written (no import/require of a SW framework dep)", () => {
    // no new deps. The SW must not import workbox or any package.
    expect(sw).not.toMatch(/import\s*['"]workbox/);
    expect(sw).not.toMatch(/require\(['"]workbox/);
  });

  it("implements install + activate + fetch event handlers", () => {
    expect(sw).toContain('addEventListener("install"');
    expect(sw).toContain('addEventListener("activate"');
    expect(sw).toContain('addEventListener("fetch"');
  });

  it("uses cache-first for static assets (strategy)", () => {
    expect(sw).toMatch(/cacheFirst|cache\.match/);
  });

  it("uses network-first for public navigation", () => {
    expect(sw).toMatch(/networkFirst|navigate/);
  });

  it("never caches SSE streams or non-GET mutations (passthrough)", () => {
    // The SW must early-return for non-GET + for the run stream endpoint.
    expect(sw).toMatch(/method\s*!==\s*["']GET["']/);
    expect(sw).toContain("/stream");
  });

  it("versioned cache name: a generation plus the digest of every cached asset, never a hand bump", () => {
    expect(sw).toMatch(/const CACHE_VERSION = `\$\{CACHE_GENERATION\}-\$\{ASSETS_DIGEST\}`;/);
    // The committed line is the one owner's output for today's public assets (icons, fonts, manifest).
    expect(sw, "public/sw.js's digest is stale: run node scripts/service-worker-cache.ts --write").toBe(committedServiceWorker(root));
    const assets = cachedFiles(resolve(root, "public"));
    expect([...assets.keys()]).toContain("icons/icon.svg");
    expect([...assets.keys()]).toContain("manifest.json");
    expect([...assets.keys()].some((name) => name === "sw.js" || name.endsWith("README.md")), "the worker and the READMEs are not cached assets").toBe(false);
    // Any changed asset is a new digest.
    const changed = new Map(assets);
    changed.set("icons/icon.svg", Buffer.from("<svg/>"));
    expect(assetsDigest(changed)).not.toBe(assetsDigest(assets));
    expect(() => withAssetsDigest("const x = 1;", "abc")).toThrow(/carries no/);
  });

  it("the digest covers exactly what the worker precaches: a file it misses is refused, a file added to the list joins it", () => {
    const assets = cachedFiles(resolve(root, "public"));
    const urls = precachedUrls(sw);
    expect(urls, "the worker precaches the app shell, the manifest and the icons").toEqual(expect.arrayContaining(["/", "/manifest.json", "/icons/icon.svg"]));
    expect(uncoveredPrecache(sw, assets), "every precached URL but the navigation root is a digest input").toEqual([]);
    // Plant 1: a precached file left out of the digest's inputs (the NOT_CACHED mutation) is named, and the owner refuses it.
    const missing = new Map(assets);
    missing.delete("icons/icon.svg");
    expect(uncoveredPrecache(sw, missing)).toEqual(["/icons/icon.svg"]);
    const copy = createTempDir("sw-precache-");
    cpSync(resolve(root, "public"), resolve(copy, "public"), { recursive: true });
    const before = committedServiceWorker(copy);
    // Plant 2: a URL added to the precache list with no file behind it is refused by name, never digested around.
    const listed = sw.replace('"/manifest.json",', '"/manifest.json", "/icons/icon-1024.png",');
    expect(listed, "the plant landed").not.toBe(sw);
    writeFileSync(resolve(copy, "public/sw.js"), listed);
    expect(() => committedServiceWorker(copy)).toThrow(/precaches \/icons\/icon-1024\.png, which the cached-assets digest does not cover/u);
    // Once the file exists it is a digest input, so adding it is a new cache.
    writeFileSync(resolve(copy, "public/icons/icon-1024.png"), "png");
    const added = committedServiceWorker(copy);
    expect(added).not.toBe(listed);
    expect(/const ASSETS_DIGEST = "([0-9a-f]{12})";/u.exec(added)![1]).not.toBe(/const ASSETS_DIGEST = "([0-9a-f]{12})";/u.exec(before)![1]);
    // One changed byte of a precached icon is a new digest.
    const icon = readFileSync(resolve(copy, "public/icons/icon.svg"));
    icon.writeUInt8(icon.readUInt8(icon.length - 1) ^ 1, icon.length - 1);
    writeFileSync(resolve(copy, "public/icons/icon.svg"), icon);
    expect(committedServiceWorker(copy)).not.toBe(added);
    expect(() => precachedUrls("const x = 1;")).toThrow(/carries no/u);
    expect(() => precachedUrls("const PRECACHE_URLS = [];")).toThrow(/names no URL/u);
  });

  it("the build sets the BUILT worker's digest from every emitted file, bundles included", () => {
    const dist = createTempDir("sw-digest-");
    cpSync(resolve(root, "public"), dist, { recursive: true });
    mkdirSync(resolve(dist, "assets"), { recursive: true });
    writeFileSync(resolve(dist, "sw.js"), sw);
    writeFileSync(resolve(dist, "assets/index-abc12345.js"), "console.log(1)");
    const plugin = serviceWorkerDigestPlugin();
    plugin.writeBundle({ dir: dist });
    const first = readFileSync(resolve(dist, "sw.js"), "utf8");
    expect(first).toContain(`const ASSETS_DIGEST = "${assetsDigest(cachedFiles(dist))}";`);
    writeFileSync(resolve(dist, "assets/index-abc12345.js"), "console.log(2)");
    plugin.writeBundle({ dir: dist });
    expect(readFileSync(resolve(dist, "sw.js"), "utf8"), "a changed bundle is a new cache").not.toBe(first);
  });
});

describe("PWA request and cache ownership", () => {
  function worker() {
    type Event = { request?: Request; waitUntil: (work: Promise<unknown>) => void; respondWith: (work: Promise<Response>) => void };
    const handlers = new Map<string, (event: Event) => void>();
    const stores = new Map<string, Map<string, Response>>();
    const fetch = vi.fn(async (_request: Request) => new Response("fresh public asset", { headers: { "content-type": "text/html" } }));
    const warnings = vi.fn();
    const writes: Promise<unknown>[] = [];
    const persist = vi.fn(async (entries: Map<string, Response>, key: string, response: Response) => { entries.set(key, response.clone()); });
    const keyOf = (request: Request | string) => typeof request === "string" ? new URL(request, "https://example.test").href : request.url;
    const caches = {
      keys: async () => [...stores.keys()],
      delete: vi.fn(async (key: string) => stores.delete(key)),
      open: async (name: string) => {
        let store = stores.get(name);
        if (!store) { store = new Map(); stores.set(name, store); }
        const entries = store;
        return {
          match: async (request: Request | string) => entries.get(keyOf(request))?.clone(),
          put: (request: Request | string, response: Response) => persist(entries, keyOf(request), response),
          add: async (request: Request) => { entries.set(keyOf(request), await fetch(request)); },
        };
      },
    };
    const claim = vi.fn(async () => undefined), skipWaiting = vi.fn(async () => undefined);
    runInNewContext(read("public/sw.js"), { URL, Response, Request, caches, fetch, console: { warn: warnings },
      self: { location: { origin: "https://example.test" }, clients: { claim }, skipWaiting,
        addEventListener: (type: string, handler: (event: Event) => void) => handlers.set(type, handler) } });
    return { stores, fetch, caches, claim, persist, warnings, writes, async dispatch(type: string, request?: Request) {
      const work: Promise<unknown>[] = []; let response: Promise<Response> | undefined;
      const handler = handlers.get(type); expect(handler, `real worker owns ${type}`).toBeTypeOf("function");
      handler!({ ...(request ? { request } : {}), waitUntil: value => { work.push(value); writes.push(value); }, respondWith: value => { response = value; } });
      if (response !== undefined) return await response;
      await Promise.all(work); return null;
    } };
  }

  it("never intercepts private data, mutations, streams, development modules or arbitrary files, even with old cached bodies", async () => {
    const w = worker();
    const paths = ["/api/models", "/api/auth/status", "/api/projects/p/chats", "/api", "/src/main.ts", "/@vite/client", "/node_modules/.vite/deps/zod.js?v=obsolete", "/shared/wire-types.ts", "/project/private.svg", "/mutable.js"];
    const old = await w.caches.open("harness-runtime-v3");
    for (const path of paths) {
      const request = new Request("https://example.test" + path);
      await old.put(request, new Response("previous account private value"));
      expect(await w.dispatch("fetch", request), `passthrough ${path}`).toBeNull();
    }
    for (const request of [new Request("https://example.test/api/models", { method: "POST" }), new Request("https://example.test/live", { headers: { accept: "text/event-stream" } }), new Request("https://other.test/icons/icon.svg")]) {
      expect(await w.dispatch("fetch", request)).toBeNull();
    }
    expect(w.fetch).not.toHaveBeenCalled();
    expect([...w.stores.keys()]).toEqual(["harness-runtime-v3"]);
  });

  it("retires only owned obsolete versions, including their private API bodies", async () => {
    const w = worker();
    for (const name of ["harness-static-v3", "harness-runtime-v3", "harness-static-v5-aaaaaaaaaaaa", STATIC_CACHE, RUNTIME_CACHE, "another-app", "harness-runtime-other"]) await w.caches.open(name);
    await w.dispatch("activate");
    expect([...w.stores.keys()]).toEqual([STATIC_CACHE, RUNTIME_CACHE, "another-app", "harness-runtime-other"]);
    expect(w.caches.delete.mock.calls.map(call => call[0]).sort()).toEqual(["harness-runtime-v3", "harness-static-v3", "harness-static-v5-aaaaaaaaaaaa"]);
    expect(w.claim).toHaveBeenCalledTimes(1);
  });

  it("keeps exact hashed bundles and icons offline without mixing bundle identities", async () => {
    const w = worker();
    const first = new Request("https://example.test/assets/app-abcdefgh.js"), next = new Request("https://example.test/assets/app-ijklmnop.js");
    expect(await (await w.dispatch("fetch", first))!.text()).toBe("fresh public asset");
    w.fetch.mockResolvedValueOnce(new Response("next bundle"));
    expect(await (await w.dispatch("fetch", next))!.text()).toBe("next bundle");
    const icon = new Request("https://example.test/icons/icon.svg");
    await w.dispatch("fetch", icon);
    w.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await (await w.dispatch("fetch", first))!.text()).toBe("fresh public asset");
    expect(await (await w.dispatch("fetch", next))!.text()).toBe("next bundle");
    expect((await w.dispatch("fetch", icon))!.status).toBe(200);
    expect(w.fetch).toHaveBeenCalledTimes(3);
    expect((await w.dispatch("fetch", new Request("https://example.test/assets/missing-qrstuvwx.js")))!.status).toBe(504);
  });

  it("navigation prefers fresh HTML and falls back to the actual precached shell on a new offline URL", async () => {
    const w = worker();
    await (await w.caches.open(STATIC_CACHE)).put("/", new Response("public app shell"));
    const navigation = (path: string) => {
      const request = new Request("https://example.test" + path);
      Object.defineProperty(request, "mode", { value: "navigate" }); return request;
    };
    expect(await (await w.dispatch("fetch", navigation("/")))!.text()).toBe("fresh public asset");
    w.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await (await w.dispatch("fetch", navigation("/?new-route")))!.text()).toBe("fresh public asset");
  });

  it.each([false, true])("delivers a successful network response while optional cache writes stall or reject (navigation=%s)", async navigation => {
    const w = worker();
    let rejectWrite!: (reason: Error) => void;
    w.persist.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const request = new Request("https://example.test" + (navigation ? "/" : "/assets/app-abcdefgh.js"));
    if (navigation) Object.defineProperty(request, "mode", { value: "navigate" });
    const response = await w.dispatch("fetch", request);
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe("fresh public asset");
    expect(w.persist).toHaveBeenCalledTimes(1);
    expect(w.writes).toHaveLength(1);
    const failure = new Error("QuotaExceededError: storage full");
    rejectWrite(failure);
    await Promise.all(w.writes);
    expect(w.warnings).toHaveBeenCalledExactlyOnceWith("Public asset cache write failed", navigation ? RUNTIME_CACHE : STATIC_CACHE, failure);
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds root query variants to one public shell and refuses private/download document caching", async () => {
    const w = worker();
    const navigation = (path: string) => { const request = new Request("https://example.test" + path); Object.defineProperty(request, "mode", { value: "navigate" }); return request; };
    for (let index = 0; index < 100; index++) await w.dispatch("fetch", navigation("/?conversation=" + index));
    await Promise.all(w.writes);
    expect([...w.stores.get(RUNTIME_CACHE)!.keys()]).toEqual(["https://example.test/"]);
    for (const headers of [{"content-type":"text/html","cache-control":"private"},{"content-type":"text/html","cache-control":"no-store"},{"content-type":"text/html","content-disposition":"attachment"},{"content-type":"application/json"}]) {
      w.fetch.mockResolvedValueOnce(new Response("private value", { headers }));
      expect(await (await w.dispatch("fetch", navigation("/?account=other")))!.text()).toBe("private value");
      await Promise.all(w.writes);
      expect(await w.stores.get(RUNTIME_CACHE)!.get("https://example.test/")!.clone().text()).toBe("fresh public asset");
    }
    expect(await w.dispatch("fetch", navigation("/download/private.html"))).toBeNull();
  });
});

describe("PWA — registration + index.html link", () => {
  it("index.html links the manifest + theme-color + apple-touch-icon", () => {
    const html = read("index.html");
    expect(html).toContain('<link rel="manifest" href="/manifest.json"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("exactly ONE entry owner registers the service worker (guarded for jsdom)", () => {
    // Tolerant of the owner FILE, strict about the ownership: registration
    // lives in App.svelte today and moves into the cockpit entry at the
    // swap — this asserts one owner exists among the two entry candidates,
    // whichever the tree currently is, and that the jsdom guard rides along.
    const candidates = ["src/App.svelte", modulePathMatching("src/cockpit/main.ts"), modulePathMatching("src/main.ts")];
    const owners = candidates.filter((f) => {
      try {
        return read(f).includes("registerServiceWorker");
      } catch {
        return false;
      }
    });
    expect(owners.length, `SW registration owners: ${owners.join(", ") || "none"}`).toBe(1);
    const src = read(owners[0]!);
    expect(src).toContain("navigator.serviceWorker.register");
    // The guard: only registers when serviceWorker is supported (no-op in jsdom).
    expect(src).toContain('"serviceWorker" in navigator');
  });
});

describe("PWA — icon generator (no-dep build tool)", () => {
  it("scripts/generate-pwa-icons.mjs exists + uses only node built-ins and the repository's one checkout writer", () => {
    const src = read("scripts/generate-pwa-icons.mjs");
    expect(src).toMatch(/from\s*["']node:zlib["']/);
    // Writes go through the shared atomic writer (the checkout write door),
    // never a raw fs write of a tracked file.
    expect(src).toMatch(/from\s*["']\.\.\/engine\/src\/filesystem\/atomic-write\.ts["']/);
    // It may READ (the token owner, the committed icons for --check) but
    // never write through node:fs.
    expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|\bfs\.write/);
    // No external image dep (sharp/canvas/jimp) — hand-encoded PNG.
    expect(src).not.toMatch(/from\s*["']sharp["']/);
    expect(src).not.toMatch(/from\s*["']canvas["']/);
    expect(src).toContain("IHDR");
  });

  it("the committed icons are exactly the generator's output (the one mark, in the token owner's colours)", () => {
    const outputs = markOutputs() as Map<string, Buffer>;
    expect([...outputs.keys()].map((p) => p.slice(root.length + 1)).sort()).toEqual([
      "docs/assets/mark.svg",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon.svg",
    ]);
    for (const [path, bytes] of outputs) {
      expect(readFileSync(path).equals(bytes), `${path} drifted: run node scripts/generate-pwa-icons.mjs`).toBe(true);
    }
    // The colours come from the token owner: a planted palette change reaches the mark,
    // and a missing token is a loud refusal, never a default.
    const tokens = read("src/cockpit/tokens.css");
    expect((markColors as (css: string) => Record<string, string>)(tokens.replace(/--beam:\s*#8fd3ff;/, "--beam: #123456;"))["--beam"]).toBe("#123456");
    expect(() => markColors(tokens.replace(/--beam:\s*#8fd3ff;/, ""))).toThrow(/--beam/);
    // The retired indigo disc is gone from every icon.
    expect(readFileSync(resolve(root, "public/icons/icon.svg"), "utf8")).not.toMatch(/#7c8cf8|#9ba5fa|#0d0f14/i);
  });
});
