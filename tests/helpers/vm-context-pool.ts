/**
 * Fresh DOM contexts in externally killable Vitest child processes. Each
 * request executes one file, including one-slot batches. Module/global/mock
 * state is context-local; process.env is restored by the existing setup.
 * Node/security tests retain fresh forks in vitest.config.ts. Native modules
 * remain process-scoped: this pool is only for the declared jsdom population.
 * Watch invalidations retire processes, and all processes close at run end.
 * The public VmForksPoolWorker owns spawn, graceful stop, kill and wait.
 */
import { EventEmitter } from "node:events";
import * as nodeos from "node:os";
import {
  VmForksPoolWorker,
  type PoolOptions, type PoolWorker, type PoolTask, type WorkerRequest,
  type WorkerResponse, type PoolRunnerInitializer, type ResolvedConfig,
} from "vitest/node";
import { HarnessError, InputError } from "../../engine/src/kernel/errors.ts";

type FileRequest = Extract<WorkerRequest, { type: "run" | "collect" }>;
type StartRequest = Extract<WorkerRequest, { type: "start" }>;

class ContextWorker implements PoolWorker {
  name = "context-forks";
  reportMemory = true;
  events = new EventEmitter();
  pendingRequest: FileRequest | undefined;
  nextFile = 0;
  cancelled = false;
  usedMemory = 0;
  transition: Promise<void> | undefined;
  startMessage: StartRequest | undefined;
  running = false;
  stopping = false;
  deferredStop: WorkerRequest | undefined;
  worker!: VmForksPoolWorker;
  readonly options: PoolOptions;
  memoryLimit: number;
  watch: boolean;

  constructor(options: PoolOptions) {
    this.options = options;
    const config = options.project.vitest.config;
    const memoryLimit = stringToBytes(getWorkerMemoryLimit(config),
      config.watch ? nodeos.totalmem() / 2 : nodeos.totalmem());
    if (typeof memoryLimit !== "number" || !Number.isFinite(memoryLimit)) {
      throw new InputError("Invalid VM memory limit", "context_worker_memory_invalid");
    }
    this.memoryLimit = memoryLimit;
    this.watch = config.watch;
  }

  on(event: string, callback: (arg: any) => void) { this.events.on(event, callback); }
  off(event: string, callback: (arg: any) => void) { this.events.off(event, callback); }
  deserialize(message: unknown) { return message; }
  canReuse(task: PoolTask) {
    return !this.cancelled && !this.watch && this.usedMemory < this.memoryLimit
      && !task.context.invalidates?.length;
  }

  async start() { await this.startDelegate(); }
  async startDelegate() {
    this.worker = new VmForksPoolWorker(this.options);
    await this.worker.start();
    this.running = true;
    this.worker.on("message", message => this.message(message));
    this.worker.on("error", error => this.events.emit("error", error));
    this.worker.on("exit", code => {
      if (!this.transition && !this.stopping) this.events.emit("exit", code);
    });
  }

  clearPending() { this.pendingRequest = undefined; this.nextFile = 0; }
  sendNextFile() {
    const request = this.pendingRequest;
    if (!request || this.cancelled) return;
    const file = request.context.files[this.nextFile++];
    if (this.nextFile >= request.context.files.length) this.clearPending();
    this.worker.send({ ...request, context: { ...request.context, files: file ? [file] : [] } });
  }

  send(message: WorkerRequest) {
    if (message?.__vitest_worker_request__ && message.type === "start") this.startMessage = message;
    if (message?.__vitest_worker_request__ && (message.type === "run" || message.type === "collect")) {
      this.cancelled = false;
      this.pendingRequest = message;
      this.nextFile = 0;
      this.sendNextFile();
      return;
    }
    if (message?.type === "stop" || message?.type === "cancel"
      || (message as unknown as { m?: string })?.m === "onCancel") {
      this.cancelled = true;
      this.clearPending();
      if (this.transition) {
        if (message.type === "stop") this.deferredStop = message;
        return;
      }
    }
    this.worker.send(message);
  }

  message(message: WorkerResponse) {
    if (this.transition && message?.__vitest_worker_response__
      && (message.type === "started" || message.type === "stopped")) {
      this.events.emit("lifecycle", message);
      return;
    }
    if (message?.__vitest_worker_response__ && message.type === "testfileFinished") {
      this.usedMemory = message.usedMemory ?? 0;
      if (message.error) this.clearPending();
      if (this.pendingRequest && !this.cancelled) {
        if (this.watch || this.usedMemory >= this.memoryLimit || this.pendingRequest.context.invalidates?.length) {
          this.transition = this.recycle().then(() => {
            this.transition = undefined;
            if (this.deferredStop) {
              this.worker.send(this.deferredStop);
              this.deferredStop = undefined;
            } else if (this.cancelled) this.events.emit("message", message);
            else this.sendNextFile();
          }).catch(error => {
            this.transition = undefined;
            this.clearPending();
            this.events.emit("error", error);
          });
        } else this.sendNextFile();
        return;
      }
    }
    this.events.emit("message", message);
  }

  lifecycle(type: "started" | "stopped", message: WorkerRequest) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("lifecycle", receive);
        this.events.off("error", fail);
      };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const receive = (response: WorkerResponse) => {
        if (response.type !== type) return;
        cleanup();
        response.error ? reject(response.error) : resolve();
      };
      const timer = setTimeout(() => fail(new HarnessError(
        `Context worker ${type} timeout`, "context_worker_lifecycle_timeout")),
      this.options.project.vitest.config.teardownTimeout);
      this.events.on("lifecycle", receive);
      this.events.on("error", fail);
      this.worker.send(message);
    });
  }

  async recycle() {
    await this.lifecycle("stopped", { __vitest_worker_request__: true, type: "stop" });
    await this.worker.stop();
    this.running = false;
    await this.startDelegate();
    if (!this.startMessage) throw new HarnessError(
      "Context worker start request is absent", "context_worker_start_missing");
    await this.lifecycle("started", this.startMessage);
    this.usedMemory = 0;
  }

  async stop() {
    this.cancelled = true;
    this.clearPending();
    this.stopping = true;
    await this.transition;
    if (this.running) { await this.worker.stop(); this.running = false; }
    this.events.removeAllListeners();
  }
}

export const contextPool: PoolRunnerInitializer = {
  name: "context-forks", createPoolWorker: options => new ContextWorker(options),
};

// Memory-limit conversion adapted from Vitest v4.1.10
// https://github.com/vitest-dev/vitest/blob/v4.1.10/packages/vitest/src/utils/memory-limit.ts
// Pinned source commit: db616d227b6e0cb07a94f5d1bba262ee95db7e46.
// The original source and MIT license are retained with the CPU research.
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of facebook/jest GitHub project tree.
 *
 * MIT License
 *
 * Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

function getDefaultThreadsCount(config: Pick<ResolvedConfig, 'watch'>) {
  const numCpus
    = typeof nodeos.availableParallelism === 'function'
      ? nodeos.availableParallelism()
      : nodeos.cpus().length

  return config.watch
    ? Math.max(Math.floor(numCpus / 2), 1)
    : Math.max(numCpus - 1, 1)
}

function getWorkerMemoryLimit(config: Pick<ResolvedConfig, 'vmMemoryLimit' | 'maxWorkers' | 'watch'>): string | number {
  if (config.vmMemoryLimit) {
    return config.vmMemoryLimit
  }

  const workers = config.maxWorkers ?? getDefaultThreadsCount(config)

  return 1 / workers
}

/**
 * Converts a string representing an amount of memory to bytes.
 *
 * @param input The value to convert to bytes.
 * @param percentageReference The reference value to use when a '%' value is supplied.
 */
function stringToBytes(
  input: string | number | null | undefined,
  percentageReference?: number,
): number | null | undefined {
  if (input === null || input === undefined) {
    return input
  }

  if (typeof input === 'string') {
    if (Number.isNaN(Number.parseFloat(input.slice(-1)))) {
      // Split the final unit suffix once. The upstream unanchored regexp
      // retries every prefix when a long malformed number ends in '-' or
      // '.', despite there being no suffix. This backward scan is linear.
      let suffix = input.length;
      while (suffix > 0) {
        const code = input.charCodeAt(suffix - 1);
        if ((code >= 48 && code <= 57) || code === 45 || code === 46) break;
        suffix--;
      }
      if (suffix === input.length) return null;
      // Preserve the upstream regexp's dot/newline behavior in the numeric
      // part, including refusal of unsupported or empty suffix shapes.
      let start = suffix;
      while (start > 0) {
        const code = input.charCodeAt(start - 1);
        if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
        start--;
      }
      const numericString = input.slice(start, suffix);
      let trailingChars = input.slice(suffix)

      if (trailingChars && numericString) {
        const numericValue = Number.parseFloat(numericString)
        trailingChars = trailingChars.toLowerCase()

        switch (trailingChars) {
          case '%':
            input = numericValue / 100
            break
          case 'kb':
          case 'k':
            return numericValue * 1000
          case 'kib':
            return numericValue * 1024
          case 'mb':
          case 'm':
            return numericValue * 1000 * 1000
          case 'mib':
            return numericValue * 1024 * 1024
          case 'gb':
          case 'g':
            return numericValue * 1000 * 1000 * 1000
          case 'gib':
            return numericValue * 1024 * 1024 * 1024
        }
      }

      // It ends in some kind of char so we need to do some parsing
    }
    else {
      input = Number.parseFloat(input)
    }
  }

  if (typeof input === 'number') {
    if (input <= 1 && input > 0) {
      if (percentageReference) {
        return Math.floor(input * percentageReference)
      }
      else {
        throw new InputError(
          'For a percentage based memory limit a percentageReference must be supplied',
          'context_worker_memory_reference_missing',
        )
      }
    }
    else if (input > 1) {
      return Math.floor(input)
    }
    else {
      throw new InputError('Unexpected numerical input for "memoryLimit"', "context_worker_memory_invalid")
    }
  }

  return null
}
