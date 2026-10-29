/**
 * A PRODUCTION-SHAPED STATIC SERVER for the built client.
 *
 * WHY THIS HAD TO BE WRITTEN. Boot numbers taken against the Vite dev server
 * are not product numbers: dev serves ~266 unbundled ES modules totalling
 * 8.4MB, and that module waterfall — not the app — dominates time-to-usable.
 * The honest comparison needs the built bundle. But `vite preview` cannot
 * serve it here, because `vite.config.ts` declares its `/api` proxy under
 * `server` (dev only) and has no `preview` block, so every API call from a
 * previewed build would 404. Adding one would be a product-code edit.
 *
 * So this is the smallest correct thing: static files from `dist/client`
 * plus a transparent `/api` proxy to a real API server. It deliberately
 * behaves like a competent production host in the two ways that change the
 * measurement — it serves `Content-Encoding: gzip` when the client accepts
 * it, and it sets long-lived immutable caching on content-hashed assets —
 * because a measurement against a server that does neither would understate
 * transfer and overstate warm revisit cost.
 *
 * It does NOT pretend to be a CDN: no HTTP/2, no push, no brotli. Those
 * would each make the numbers better, so their absence keeps this a
 * conservative floor rather than an optimistic one.
 *
 * Usage:
 *   node --experimental-strip-types tests/performance/cockpit/preview-server.ts [webPort] [apiPort]
 *
 * @test-only — never imported by the runtime bundle.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { extname, join, normalize } from "node:path";

const ROOT = join(process.cwd(), "dist", "client");

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

/** Content-hashed assets (`name-HASH.js`) are immutable by construction —
 * caching them for a year is what any real host does, and it is the whole
 * difference between a cold boot and a warm revisit. */
function isImmutable(path: string): boolean {
  return /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|map)$/.test(path);
}

/** Gzip cache, so repeated runs measure the network rather than our zlib. */
const gzCache = new Map<string, Buffer>();

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(ROOT, clean);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback — the cockpit is served at `/`.
    filePath = join(ROOT, "index.html");
  }
  if (!existsSync(filePath)) { res.writeHead(404).end("not found"); return; }

  const ext = extname(filePath);
  const type = MIME[ext] ?? "application/octet-stream";
  const cacheControl = isImmutable(filePath)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const acceptsGzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
  const compressible = /^(text\/|application\/(javascript|json|manifest))/.test(type)
    || ext === ".js" || ext === ".css" || ext === ".svg";

  if (acceptsGzip && compressible) {
    let buf = gzCache.get(filePath);
    if (buf === undefined) {
      buf = gzipSync(readFileSync(filePath), { level: 6 });
      gzCache.set(filePath, buf);
    }
    res.writeHead(200, {
      "content-type": type,
      "content-encoding": "gzip",
      "content-length": buf.length,
      "cache-control": cacheControl,
      vary: "accept-encoding",
    });
    res.end(buf);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": statSync(filePath).size,
    "cache-control": cacheControl,
  });
  createReadStream(filePath).pipe(res);
}

export function startPreview(webPort: number, apiPort: number): { close: () => void } {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/")) {
      const proxy = httpRequest(
        { host: "127.0.0.1", port: apiPort, path: url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => { if (!res.headersSent) res.writeHead(502).end("api unreachable"); });
      req.pipe(proxy);
      return;
    }
    serveStatic(req, res, url);
  });
  server.listen(webPort, "127.0.0.1");
  return { close: () => server.close() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const webPort = Number(process.argv[2] ?? 5401);
  const apiPort = Number(process.argv[3] ?? 5174);
  if (!existsSync(ROOT)) {
    // A refusal is thrown, never `process.exit()`, which can deadlock at shutdown (Node #54918, #351).
    throw new Error(`no build at ${ROOT} — run \`npx vite build\` first`);
  }
  startPreview(webPort, apiPort);
  process.stdout.write(
    JSON.stringify({ ready: true, url: `http://127.0.0.1:${webPort}/`, root: ROOT, apiPort }) + "\n",
  );
}
