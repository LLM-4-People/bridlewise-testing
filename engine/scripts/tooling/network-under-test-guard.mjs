/**
 * THE SOCKET GUARD OF A TEST RUN — every node process of the run connects to
 * nothing but this machine.
 *
 * Installed by `network-under-test.ts` ({@link installNetworkGuard}) into
 * every process that runs tests: in-process by the engine test worker and the
 * web setup file, and as a preload (`--import`) into each engine test file's
 * process. Plain JavaScript on node built-ins only, on purpose: a preload runs
 * before a process's first line, and a TypeScript one cost ~35 ms per process
 * against ~3 ms for this (measured on this machine, `node -e 0`). A module
 * that only exports: the installer is called, never run by importing.
 *
 * WHY AT THE SOCKET. The outbound door refuses a remote destination under test
 * (`src/shared/outbound-http.ts`), but only for requests sent through it: a raw
 * `fetch("https://example.com")` in a test process answered 200
 * (wf-del2-correctness NEW-5), and `http.request`, `net.connect`,
 * `tls.connect`, `http2.connect` and a WebSocket bypass the door the same way.
 * Every one of them — the platform's own fetch included — opens its TCP
 * connection through `net.Socket.prototype.connect`, so that one method is
 * the choke point:
 *
 *   - a Unix socket or pipe (`path`) is this machine, and passes;
 *   - an IP destination passes only when it is loopback (127.0.0.0/8, ::1, an
 *     IPv4-mapped loopback) or unspecified (0.0.0.0, ::: this machine);
 *     anything else fails the socket, asynchronously, as a refused connection
 *     does, with the code `outbound_network_under_test` — no packet is sent;
 *   - a NAMED destination connects only to what its resolver answers (the
 *     caller's own `lookup` — the door's pinned one — or the system's), and
 *     every address of that answer must be this machine's; `localhost` is;
 *   - THE ONE OPT-IN: the live hosts the installer is handed (the declared
 *     ones, only when the run consented — `src/process/live-network.ts`) pass
 *     by exact name.
 *
 * Idempotent per process (the installed method carries the mark). A non-node child
 * (git, uvx, a shell) is not covered here: it is offline by its own flags where
 * a test starts one.
 */

import dns from "node:dns";
import net from "node:net";

const INSTALLED = Symbol.for("bridlewise.networkUnderTest.installed");
const REFUSAL_CODE = "outbound_network_under_test";

function bare(host) {
  return (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host).toLowerCase();
}

/** Whether an IP address is this machine: loopback or unspecified (IPv4-mapped included). */
function thisMachine(address) {
  const value = bare(address);
  const mapped = value.startsWith("::ffff:") && net.isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  if (net.isIP(mapped) === 4) return mapped.startsWith("127.") || mapped === "0.0.0.0";
  return mapped === "::1" || mapped === "::";
}

function refusal(destination) {
  const error = new Error(
    `This process is under test, and a test never reaches a host that is not this machine (${destination}), so no ` +
      "connection was made. Serve the test from a local server (127.0.0.1), or run a declared live suite " +
      "(verification.networkUnderTest in the root policy).",
  );
  error.code = REFUSAL_CODE;
  return error;
}

/** A resolver that answers only when every address it found is this machine's. */
function guardedLookup(lookup, host) {
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const asked = typeof options === "function" ? {} : options;
    lookup(hostname, asked, (error, address, family) => {
      if (error) return done(error, address, family);
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      if (addresses.every(thisMachine)) return done(null, address, family);
      return done(refusal(`${host} → ${addresses.join(", ")}`));
    });
  };
}

/** Node's own reading of a pipe name: a string that is not a port number. */
function isPipeName(value) {
  return typeof value === "string" && !(Number(value) >= 0);
}

/**
 * Guards this process: from now on it connects only to this machine and to
 * `liveHosts` (exact names). Idempotent: the first installation a process
 * makes is the one it keeps.
 * @param {readonly string[]} liveHosts
 */
export function installNetworkGuard(liveHosts) {
  // The mark is on the installed method itself, so it is per PROCESS: a
  // vitest DOM file runs in a fresh context (fresh globals) of a process whose
  // `node:net` is shared, and must not wrap the method once per file.
  if (net.Socket.prototype.connect[INSTALLED] === true) return;
  const LIVE_HOSTS = new Set(liveHosts.map((host) => host.toLowerCase()));
  const original = net.Socket.prototype.connect;
  const connectUnderTest = function connectUnderTest(...args) {
    // The three shapes node accepts: the already-normalized list `net.connect`
    // hands over, an options object, or (port[, host]) / (path).
    const normalized = Array.isArray(args[0]) ? args[0] : undefined;
    const callback = args.find((arg) => typeof arg === "function");
    let options;
    if (normalized !== undefined) options = normalized[0];
    else if (typeof args[0] === "object" && args[0] !== null) options = args[0];
    else if (isPipeName(args[0])) options = { path: args[0] };
    else options = { port: args[0], ...(typeof args[1] === "string" ? { host: args[1] } : {}) };
    if (options.path !== undefined && options.path !== null) return original.apply(this, args);
    const host = bare(typeof options.host === "string" && options.host.length > 0 ? options.host : "localhost");
    if (host === "localhost" || LIVE_HOSTS.has(host)) return original.apply(this, args);
    if (net.isIP(host) !== 0) {
      if (thisMachine(host)) return original.apply(this, args);
      process.nextTick(() => this.destroy(refusal(host)));
      return this;
    }
    const guarded = { ...options, lookup: guardedLookup(options.lookup ?? dns.lookup, host) };
    if (normalized !== undefined) {
      normalized[0] = guarded;
      return original.apply(this, args);
    }
    return original.call(this, guarded, ...(callback === undefined ? [] : [callback]));
  };
  connectUnderTest[INSTALLED] = true;
  net.Socket.prototype.connect = connectUnderTest;
}
