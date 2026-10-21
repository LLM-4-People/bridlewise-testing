/**
 * THE SEALED REALM'S PROCESS (spawned by `realm.ts` `sealedCall`, never
 * imported). It reads one request from stdin — `{ entry, modules, exportName,
 * input }` — builds a fresh realm holding only the language's built-ins with
 * every source of time, randomness, locale and I/O poisoned, loads `entry`
 * and the declared modules into it (TypeScript types stripped; any other
 * specifier refused), calls `exportName(input)` and writes its text answer
 * to stdout. Its exit status names a refusal (`REALM_EXIT`): impure 3,
 * import refused 4, failed 5. It writes no log: its one answer is the
 * channel, and the host logs the refusal.
 */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

import { REALM_EXIT } from "./realm.ts";

type Request = { entry: string; modules: string[]; exportName: string; input: string };

/** Every global the realm must not reach: a touch throws `projection_impure: <name>`. */
const POISONED_GLOBALS = [
  "Date", "Intl", "performance", "crypto", "fetch", "process", "require", "module", "Buffer", "setTimeout", "setInterval",
  "setImmediate", "queueMicrotask", "WeakRef", "FinalizationRegistry", "SharedArrayBuffer", "Atomics", "WebAssembly",
  "navigator", "XMLHttpRequest", "WebSocket", "EventSource", "Worker",
];
/** Every intrinsic method whose answer depends on the host (the locale, randomness). */
const POISONED_METHODS: readonly (readonly [string, string])[] = [
  ["Math", "random"],
  ["String.prototype", "localeCompare"],
  ["String.prototype", "toLocaleLowerCase"],
  ["String.prototype", "toLocaleUpperCase"],
  ["Number.prototype", "toLocaleString"],
  ["Array.prototype", "toLocaleString"],
  ["Object.prototype", "toLocaleString"],
  ["BigInt.prototype", "toLocaleString"],
];

const SEAL = `"use strict";
(() => {
  const impure = (name) => { throw new TypeError("projection_impure: " + name); };
  for (const name of ${JSON.stringify(POISONED_GLOBALS)}) {
    Object.defineProperty(globalThis, name, { get: () => impure(name), set: () => impure(name), configurable: false });
  }
  for (const [owner, name] of ${JSON.stringify(POISONED_METHODS)}) {
    const target = owner.split(".").reduce((value, part) => value[part], globalThis);
    Object.defineProperty(target, name, { value: () => impure(owner + "." + name), writable: false, configurable: false });
  }
})();`;

function fail(status: number, message: string): never {
  process.stderr.write(`${message.replace(/\n/gu, " ")}\n`);
  process.exit(status);
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, "utf8")) as Request;
  const allowed = new Set(request.modules.map((path) => resolve(path)));
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(SEAL, context);
  const loaded = new Map<string, vm.SourceTextModule>();
  const load = (path: string): vm.SourceTextModule => {
    if (!allowed.has(path)) fail(REALM_EXIT.importRefused, `projection_import_refused: ${path} is not a module of the sealed realm`);
    let module = loaded.get(path);
    if (module === undefined) {
      module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context, identifier: path });
      loaded.set(path, module);
    }
    return module;
  };
  const entry = load(resolve(request.entry));
  await entry.link((specifier, referencing) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) fail(REALM_EXIT.importRefused, `projection_import_refused: ${specifier} (imported by ${referencing.identifier}) is not a module of the sealed realm`);
    return load(resolve(dirname(referencing.identifier), specifier));
  });
  let answer: unknown;
  try {
    await entry.evaluate();
    const exported = (entry.namespace as Record<string, unknown>)[request.exportName];
    if (typeof exported !== "function") fail(REALM_EXIT.failed, `projection_failed: ${request.entry} exports no function ${request.exportName}`);
    answer = (exported as (input: string) => unknown)(request.input);
  } catch (error) {
    const message = error instanceof Error || (typeof error === "object" && error !== null && "message" in error) ? String((error as { message: unknown }).message) : String(error);
    if (message.startsWith("projection_impure: ")) fail(REALM_EXIT.impure, message);
    if (/Code generation from strings disallowed|WebAssembly/u.test(message)) fail(REALM_EXIT.impure, `projection_impure: code generation (${message})`);
    fail(REALM_EXIT.failed, `projection_failed: ${message}`);
  }
  if (typeof answer !== "string") fail(REALM_EXIT.failed, `projection_failed: ${request.exportName} answered ${typeof answer}, not text`);
  process.stdout.write(answer);
}

await main();
