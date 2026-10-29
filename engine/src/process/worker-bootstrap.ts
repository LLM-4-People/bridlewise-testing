/**
 * THE WORKER THREADS' BOOTSTRAP (SCALE-CR1-FIX H2).
 *
 * A worker thread is its own JavaScript realm: the fault policy its spawning
 * thread installed does not reach it, and its entry module runs whatever it
 * imports before any line of its own. So every worker thread is started on ONE
 * entry, THIS module (its PRELUDE half, at the bottom): in a thread started
 * with a boot record it installs the policy for the thread's role, then
 * imports the thread's real entry. Nothing of the entry runs before the
 * policy, and no entry module has to remember it. The spawn half
 * ({@link bootstrappedWorker}) and the prelude half are the two ends of one
 * protocol, so they are one module.
 *
 * {@link bootstrappedWorker} is the one spelling: `new Worker(...bootstrappedWorker(entry, role, options))`.
 * It hands the prelude the entry and the role in `workerData` under
 * {@link WORKER_BOOT_KEY} (the thread's own `workerData` keys are kept as they
 * are). It does not touch `execArgv`: an explicit list replaces node's own
 * inheritance, and a parent's process-level options (a test runner's) are
 * refused by a worker. One inherited option does not fit a FILE entry: a
 * parent started on eval input with `--input-type` (`node --input-type=module
 * -e …`) hands it to the thread, which then refuses to start ("--input-type
 * can only be used with string input") — and a thread that blocks on a worker
 * (the synchronous work-bounded door) never sees the `error` event. Such a
 * parent's thread starts on EVAL input that imports the prelude (an eval
 * entry takes `--input-type`, and `import()` is the same in both kinds): the
 * same prelude, the same inherited options, nothing re-parsed.
 *
 * The role decides what a lost fault does (`fault-policy.ts`): the database
 * facade's supervised threads are `server-thread`s (they live on; a dead one
 * is respawned by its supervisor), a pooled task's thread is a `worker` (it
 * fails closed). `tests/prevention/guarded-callbacks.test.ts` refuses a
 * `new Worker(` that is not started this way.
 *
 * A thread starts ONLY on a DECLARED entry ({@link DECLARED_WORKER_ENTRIES}:
 * a fixed list of repository files, each with its owner). The prelude's import
 * of the entry is the one dynamic module load of this module, so it can never
 * load arbitrary code. An undeclared entry is refused typed
 * (`worker_entry_undeclared`): by `bootstrappedWorker` before a thread
 * starts, and again by the prelude, which never trusts a boot record it was
 * handed.
 */
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, workerData, type WorkerOptions } from "node:worker_threads";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { reportAlwaysOn } from "../shared/debug/debug-system.ts";
import { describeFaultLine } from "../shared/fault-description.ts";
import { installProcessFaultPolicy, PROCESS_FAULT_EXIT_CODE, type ProcessFaultRole } from "./fault-policy.ts";

export type WorkerThreadRole = Extract<ProcessFaultRole, "server-thread" | "worker">;

/** The `workerData` key the prelude reads: `{ entry, role }`. */
const WORKER_BOOT_KEY = "__bridlewiseWorkerBoot";

export type WorkerBoot = Readonly<{ entry: string; role: WorkerThreadRole }>;

const PRELUDE = new URL(import.meta.url);

/** The repository this module is part of (`engine/src/process/` is three folders down). */
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", PRELUDE));

/**
 * THE ENTRIES A BOOTSTRAPPED THREAD MAY START ON, repository-relative, each
 * with its owner. Nothing else is ever imported as a thread's entry.
 */
const DECLARED_WORKER_ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  "engine/src/process/bounded-run-sync.ts": "the one bounded run's synchronous bridge (runCpuBoundedSync)",
  "engine/scripts/concurrent/worker-entry.mjs": "the engine worker pool's task thread (src/tools/concurrent/worker-pool.ts)",
  "server/awareness/awareness-worker.ts": "the web server's awareness thread",
  "server/db/db-worker.ts": "the web server's database facade thread",
  "server/db/key-scan-worker.ts": "the web server's key scan thread",
  "server/intelligence/content-search-worker.ts": "the web server's content search thread",
  "server/intelligence/quick-view-worker.ts": "the web server's quick view thread",
  "server/intelligence/repository-map-worker.ts": "the web server's repository map thread",
  "server/observability/timeline-migration-worker.ts": "the web server's timeline migration thread",
  "engine/test/fixtures/worker-entries/up.mjs": "test fixture: a thread that starts and answers",
  "tests/fixtures/workers/bad-payload-worker.ts": "test fixture: the worker pool's malformed-payload thread",
  "tests/fixtures/workers/echo-worker.ts": "test fixture: the worker pool's echo thread",
  "tests/fixtures/workers/hanging-worker.ts": "test fixture: the worker pool's thread that never answers",
  "engine/test/fixtures/worker-entries/role-probe.mjs": "test fixture: a thread that reports its fault role and its workerData",
  "engine/test/fixtures/worker-entries/load-failure.mjs": "test fixture: an entry that fails to load",
  "engine/test/fixtures/worker-entries/lost-rejection.mjs": "test fixture: a thread that loses a rejection",
});

/** The declared entry `href` names (repository-relative), or `undefined` when it names none. */
function declaredEntry(href: string): string | undefined {
  if (!href.startsWith("file:")) return undefined;
  const path = relative(REPOSITORY_ROOT, fileURLToPath(href)).split(sep).join("/");
  return Object.hasOwn(DECLARED_WORKER_ENTRIES, path) ? path : undefined;
}

/** The refusal of an entry that is not declared. */
function undeclaredEntry(href: string): string {
  return `a worker thread may start only on a declared entry (DECLARED_WORKER_ENTRIES in src/process/worker-bootstrap.ts); ${href} is not one`;
}

/**
 * The arguments of a bootstrapped worker thread: the prelude as its entry, and
 * `options` with the boot record added to its `workerData` (an object, or
 * none).
 */
export function bootstrappedWorker(entry: URL | string, role: WorkerThreadRole, options: WorkerOptions = {}): [URL | string, WorkerOptions] {
  if (role !== "server-thread" && role !== "worker") throw new InputError(`not a worker thread role: ${String(role)}`, "worker_role_invalid");
  const data: unknown = options.workerData;
  if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
    throw new InputError("a bootstrapped worker's workerData is an object (the prelude adds its boot record to it)", "worker_data_not_object");
  }
  const boot: WorkerBoot = { entry: entry instanceof URL ? entry.href : new URL(entry, "file://").href, role };
  if (declaredEntry(boot.entry) === undefined) throw new InputError(undeclaredEntry(boot.entry), "worker_entry_undeclared");
  const workerOptions = { ...options, workerData: { ...(data as Record<string, unknown> | undefined), [WORKER_BOOT_KEY]: boot } };
  // A thread that inherits `--input-type` starts on eval input importing the prelude (see the header).
  const inheritsInputType = options.execArgv === undefined && process.execArgv.some((option) => option === "--input-type" || option.startsWith("--input-type="));
  return inheritsInputType ? [`import(${JSON.stringify(PRELUDE.href)});`, { ...workerOptions, eval: true }] : [PRELUDE, workerOptions];
}

// ── The prelude half: this module as a worker thread's entry ──────────────
//
// A thread started by `bootstrappedWorker` carries its boot record; it gets
// the policy for its role, then its real entry. A record that names no valid
// role, or an entry that is not declared, refuses to start the thread (its
// `error` event): a worker with no
// policy is the defect this exists to end. Imported anywhere else (the main
// thread, or a thread that imports it as a library) it does nothing.
//
// The entry is imported WITHOUT a top-level await: the entry's own graph may
// import this module again (the server's hub re-exports `bootstrappedWorker`),
// and a module awaiting inside an import cycle never settles. An entry that
// fails to load is reported and the thread's exit code set to 70 (never a
// hard exit: nothing else of the thread is running, so it ends with that
// code), which its owner sees as any thread that stopped before it was ready.
const boot = isMainThread ? undefined : (workerData as Readonly<Record<string, unknown>> | null | undefined)?.[WORKER_BOOT_KEY];
if (boot !== undefined) {
  const record = boot as Partial<WorkerBoot>;
  if ((record.role !== "server-thread" && record.role !== "worker") || typeof record.entry !== "string") {
    throw new HarnessError("worker prelude: this thread's boot record names no valid role and entry (start it with bootstrappedWorker)", "worker_boot_missing");
  }
  if (declaredEntry(record.entry) === undefined) throw new HarnessError(undeclaredEntry(record.entry), "worker_entry_undeclared");
  installProcessFaultPolicy({ role: record.role });
  const entry = record.entry;
  void import(entry).then(undefined, (error: unknown) => {
    reportAlwaysOn("process", `a worker thread's entry failed to load: ${describeFaultLine(error)}`, { entry, role: record.role });
    process.exitCode = PROCESS_FAULT_EXIT_CODE;
  });
}
