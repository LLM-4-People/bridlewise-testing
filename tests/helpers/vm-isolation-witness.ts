/** Real runner witness for the existing test-isolation guard. */
import { runBoundedTestProcess } from "../../engine/src/process/supervised-run.ts";
import { ensureTestProcessSupervisor } from "../../engine/guardian/build.ts";
import { globSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { createTempDir } from "./temp-dir.ts";
import { webSuiteKillGraceMs } from "./budget-config.ts";
import { NESTED_RUNNER_LAUNCH_MS, TEST_HANG_BACKSTOP_MS } from "../test-budget.ts";
import { TEST_INCLUDE } from "../test-include.ts";

type Event = { kind: string; pid: number; ppid?: number; thread?: number; file?: string; context?: number; value?: string; cause?: string; state?: string; errors?: string[]; tests?: string[]; cancelled?: boolean };
/** A launch's record; `rewrittenFiles` counts the fixture files whose earlier, different bytes it replaced in place. */
export type IsolationRun = { events: Event[]; runnerPid: number; cancelled: boolean; rewrittenFiles: number };

/** Everything one real runner launch varies, and what it must show — one row per scenario. */
export type IsolationScenario = Readonly<{
  /** The word the fixture sources carry (`first` bytes, or the `later` rewrite). */
  value: "first" | "later";
  /** The runner's worker slots and the rate the per-file environment carries. */
  slots: number;
  rate: number;
  /** A forced per-worker memory limit (the launcher's argument), or none. */
  memoryLimit?: number;
  /** A keyboard cancel after the first file. */
  cancel: boolean;
  /** The launch establishes its own first bytes, then rewrites them in place. */
  rewrite: boolean;
  /** The runner's exit status. */
  expectedStatus: number;
  /** How many DOM worker processes the files ran in (a cancelled launch runs one file). */
  expectedDomProcesses?: number;
}>;

/**
 * The four real runner launches over one fixture folder: the first bytes on
 * two slots, a same-path/same-length/same-mtime rewrite on one slot, the same
 * under a forced memory limit, and a keyboard cancel. Each row is
 * self-contained: no launch depends on which one ran before it.
 */
export const ISOLATION_SCENARIOS = Object.freeze({
  firstBytes: Object.freeze({ value: "first", slots: 2, rate: 127, cancel: false, rewrite: false, expectedStatus: 0, expectedDomProcesses: 2 }),
  rewrittenBytes: Object.freeze({ value: "later", slots: 1, rate: 239, cancel: false, rewrite: true, expectedStatus: 0, expectedDomProcesses: 1 }),
  memoryLimit: Object.freeze({ value: "later", slots: 1, rate: 239, memoryLimit: 2, cancel: false, rewrite: false, expectedStatus: 0, expectedDomProcesses: 4 }),
  cancelled: Object.freeze({ value: "later", slots: 1, rate: 239, cancel: true, rewrite: false, expectedStatus: 1 }),
} satisfies Record<string, IsolationScenario>);

/**
 * ONE LAUNCH PER TEST. The witness writes its fixture once; `discover()` and
 * each `launch(scenario)` are single bounded runner processes, so a test that
 * calls one of them pays one launch against the per-test budget — never five
 * sequential launches inside one test, which blocked the event loop past the
 * budget on a loaded machine and surfaced as a timeout.
 */
export type IsolationWitness = Readonly<{
  /** The discovery launch: the effective project globs select every required file once, each in its declared environment's process boundary. */
  discover(): void;
  /** One real runner launch of `scenario` over the shared fixture (scenarios run in declaration order). */
  launch(scenario: IsolationScenario): IsolationRun;
}>;

export function isolationWitness(): IsolationWitness {
  // The child launches are fixture runs of a few files: light by the one definition of heavy, they take no lock
  // (engine/scripts/tooling/test-run-lock.ts), whether or not an outer suite holds it.
  const directory = createTempDir("runner-context-boundary-");
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
  const log = join(directory, "events.jsonl");
  const observer = join(directory, "observer.mjs");
  const configuration = join(directory, "vitest.config.mjs");
  const configOwner = pathToFileURL(resolve("vitest.config.ts")).href;
  const serverConfig = pathToFileURL(resolve("server/kernel/config.ts")).href;
  const discovery = join(directory, "discover.mjs");
  writeFileSync(discovery, `import {createVitest} from 'vitest/node';
const ctx=await createVitest('test',{config:${JSON.stringify(resolve("vitest.config.ts"))},run:true},{configLoader:'runner'});
try{const groups=await Promise.all(ctx.projects.map(async project=>({name:project.name,files:(await project.globTestFiles()).testFiles})));console.log(JSON.stringify(groups));}finally{await ctx.close();}`);
  const discover = (): void => {
    const discovered = runBoundedTestProcess(ensureTestProcessSupervisor(), process.execPath, [discovery], { timeoutMs: TEST_HANG_BACKSTOP_MS, killGraceMs: webSuiteKillGraceMs() });
    expect(discovered.supervision.noOwnedChildren).toBe(true);
    expect(discovered.error).toBeUndefined();
    expect(discovered.status, discovered.stdout + discovered.stderr).toBe(0);
    const groups = JSON.parse(discovered.stdout) as { name: string; files: string[] }[];
    const expectedFiles = [...globSync(TEST_INCLUDE)].map((path) => resolve(path)).sort();
    expect(groups.flatMap((group) => group.files).sort(),
      "the effective project globs must select every required file exactly once").toEqual(expectedFiles);
    for (const group of groups) for (const file of group.files) {
      const environment = readFileSync(file, "utf8").match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/)?.[1];
      expect(group.name, `${file} must use its declared environment's process boundary`).toBe(environment === "jsdom" ? "dom" : "node");
    }
  };
  const launcher = join(directory, "run.mjs");
  writeFileSync(launcher, `import {createVitest} from 'vitest/node';
let ctx,closing,cancelled=false;
import {appendFileSync} from 'node:fs';
const record=event=>appendFileSync(${JSON.stringify(log)},JSON.stringify({...event,pid:process.pid})+'\\n');
const cancelReporter={
 onTestModuleEnd(){if(process.env.RUNNER_CONTEXT_CANCEL==='1'&&!cancelled){cancelled=true;record({kind:'cancel-requested',cause:'keyboard-input'});closing=ctx.cancelCurrentRun('keyboard-input');}},
 onTestRunEnd(modules,errors,state){record({kind:'run-ended',state,errors:errors.map(String),tests:modules.flatMap(module=>Array.from(module.children.allTests(),test=>test.result()?.state))});},
};
ctx=await createVitest('test',{config:process.argv[2],run:true,reporters:['json',cancelReporter],...(process.argv[3]?{vmMemoryLimit:Number(process.argv[3])}:{})},{configLoader:'runner'});
const stop=()=>{process.exitCode=1;return closing??=Promise.all([ctx.cancelCurrentRun('keyboard-input'),ctx.cancelCurrentRun('keyboard-input')]);};
// Two cancellation requests invoke Vitest's force-stop path. The runner
// stays alive to wait for its workers; killing only the launcher loses them.
process.on('SIGTERM',stop);process.on('SIGINT',stop);
try{await ctx.start();await closing;}finally{await ctx.close();record({kind:'closed',cancelled:ctx.isCancelling});}
`);
  const domFiles = Array.from({ length: 4 }, (_, index) => join(directory, `dom-${index}.test.ts`));
  const nodeFiles = Array.from({ length: 2 }, (_, index) => join(directory, `node-${index}.test.ts`));
  writeFileSync(observer, `import vm from 'node:vm'; import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs'; import {threadId} from 'node:worker_threads';
let context=0; const create=vm.createContext;
vm.createContext=function(...args){const value=Reflect.apply(create,this,args);appendFileSync(${JSON.stringify(log)},JSON.stringify({kind:'context',pid:process.pid,thread:threadId,context:++context})+'\\n');return value;};
syncBuiltinESMExports();`);
  writeFileSync(configuration, `import base from ${JSON.stringify(configOwner)};
import {BaseSequencer} from 'vitest/node';
class Ordered extends BaseSequencer {sort(files){return files.sort((a,b)=>a.moduleId.localeCompare(b.moduleId));}}
const files={dom:${JSON.stringify(domFiles)},node:${JSON.stringify(nodeFiles)}};
export default {...base,test:{...base.test,include:[],maxWorkers:Number(process.env.RUNNER_CONTEXT_SLOTS),reporters:['json'],globalSetup:[],
 sequence:{...base.test.sequence,sequencer:Ordered},execArgv:['--import',${JSON.stringify(pathToFileURL(observer).href)}],
 projects:base.test.projects.map(project=>({...project,test:{...project.test,include:files[project.test.name],exclude:[],globalSetup:[]}}))}};`);
  writeFileSync(join(directory, "consumer.ts"), `import {word} from './leaf.ts'; export const consume=()=>word;
export const state={count:0};`);
  for (const [index, file] of domFiles.entries()) {
    writeFileSync(file, `// @vitest-environment jsdom
import {test,expect,vi} from 'vitest'; import {appendFileSync} from 'node:fs';
import {threadId} from 'node:worker_threads';
globalThis[Symbol.for('bridlewise.global-boundary.allow-leak')]=true;
${index === 1 ? "vi.mock('./leaf.ts',()=>({word:'mocked'}));" : ""}
import {consume,state} from './consumer.ts'; import native from './dependency.cjs';
import {serverConfig} from ${JSON.stringify(serverConfig)};
test('fresh evaluated state, mocks, environment and current dependency bytes',()=>{
 expect(globalThis[Symbol.for('runner-context-poison')]).toBeUndefined();
 expect(process.env.RUNNER_CONTEXT_POISON).toBeUndefined();
 expect(state.count++).toBe(0); expect(native.count++).toBe(0);
 expect(consume()).toBe(${index === 1 ? "'mocked'" : "process.env.RUNNER_CONTEXT_VALUE"});
 expect(native.word).toBe(process.env.RUNNER_CONTEXT_VALUE);
 expect(serverConfig.rateLimitPerMinute).toBe(Number(process.env.RUNNER_CONTEXT_RATE));
 appendFileSync(${JSON.stringify(log)},JSON.stringify({kind:'file',file:${JSON.stringify(file)},pid:process.pid,ppid:process.ppid,thread:threadId,value:native.word})+'\\n');
 globalThis[Symbol.for('runner-context-poison')]=true;
 process.env.RUNNER_CONTEXT_POISON='must be removed'; process.env.HARNESS_WEB_RATE_LIMIT='11';
});`);
  }
  for (const file of nodeFiles) {
    writeFileSync(file, `// @vitest-environment node
import {test,expect} from 'vitest'; import {appendFileSync} from 'node:fs'; import {threadId} from 'node:worker_threads';
test('Node files keep their own process',()=>{expect(typeof window).toBe('undefined');appendFileSync(${JSON.stringify(log)},JSON.stringify({kind:'file',file:${JSON.stringify(file)},pid:process.pid,ppid:process.ppid,thread:threadId})+'\\n');});`);
  }
  // Integer seconds are exactly representable by utimes. Establish the
  // timestamp on first creation, then assert the actual ns and ms values
  // after every same-path, same-length rewrite. Date rounding proves none
  // of this. These are separate runner launches, not an in-process watch
  // invalidation claim.
  const fixtureTime = Math.floor(Date.now() / 1000) - 2;
  const sources = (word: string) => [
    ["leaf.ts", `export const word='${word}';`],
    ["dependency.cjs", `module.exports={word:'${word}',count:0};`],
  ] as const;
  const launch = (scenario: IsolationScenario): IsolationRun => {
    const { value } = scenario;
    // A REWRITE establishes its own first bytes (written, then stamped) before
    // it rewrites them: the scenario never depends on which launch ran before
    // it — filtered to itself, shuffled, or after a failed launch it once
    // rewrote nothing and passed having tested first bytes (a4-design M8).
    if (scenario.rewrite) {
      for (const [name, source] of sources("first")) {
        writeFileSync(join(directory, name), source);
        utimesSync(join(directory, name), fixtureTime, fixtureTime);
      }
    }
    let rewrittenFiles = 0;
    for (const [name, source] of sources(value)) {
      const path = join(directory, name);
      const before = statSync(path, { throwIfNoEntry: false, bigint: true });
      const previous = before ? readFileSync(path, "utf8") : undefined;
      writeFileSync(path, source);
      utimesSync(path, fixtureTime, fixtureTime);
      const after = statSync(path, { bigint: true });
      expect(after.mtimeNs).toBe(BigInt(fixtureTime) * 1_000_000_000n);
      if (before) {
        expect(after.size).toBe(before.size);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        if (previous !== source) rewrittenFiles += 1;
      }
    }
    writeFileSync(log, "");
    const child = runBoundedTestProcess(ensureTestProcessSupervisor(), process.execPath, [launcher, configuration,
      ...(scenario.memoryLimit === undefined ? [] : [String(scenario.memoryLimit)])], {
      timeoutMs: NESTED_RUNNER_LAUNCH_MS,
      killGraceMs: webSuiteKillGraceMs(),
      env: { ...process.env, RUNNER_CONTEXT_VALUE: value, RUNNER_CONTEXT_RATE: String(scenario.rate),
        RUNNER_CONTEXT_SLOTS: String(scenario.slots), RUNNER_CONTEXT_CANCEL: scenario.cancel ? "1" : "0",
        HARNESS_WEB_RATE_LIMIT: String(scenario.rate) },
    });
    expect(child.error, "the bounded real runner must complete").toBeUndefined();
    expect(child.supervision.noOwnedChildren).toBe(true);
    expect(child.supervision.killed, "ordinary completion must own and close its processes").toEqual([]);
    expect(child.status, child.stdout + child.stderr).toBe(scenario.expectedStatus);
    const report = JSON.parse(child.stdout) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: { name: string; assertionResults: { status: string }[]; status: string; message: string }[] };
    if (!scenario.cancel) {
      expect(report.numTotalTests).toBe(domFiles.length + nodeFiles.length);
      expect(report.numPassedTests).toBe(report.numTotalTests);
      expect(report.testResults.map((file) => file.name).sort()).toEqual([...domFiles, ...nodeFiles].sort());
    }
    const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Event);
    const completed = events.filter(event => event.kind === "run-ended");
    const closed = events.filter(event => event.kind === "closed");
    expect(completed).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(completed[0]?.errors, "cancellation cannot conceal unrelated unhandled errors").toEqual([]);
    if (scenario.cancel) {
      expect(report.numTotalTests).toBe(1);
      expect(report.numPassedTests, "the completed cancellation test must actually pass").toBe(1);
      expect(report.numFailedTests).toBe(0);
      expect(report.testResults.filter(file => file.assertionResults.length > 0).map(file => file.name))
        .toEqual([domFiles[0]]);
      expect(report.testResults.flatMap(file => file.assertionResults.map(test => test.status))).toEqual(["passed"]);
      for (const file of report.testResults) expect(file.message).toBe("");
      expect(events.filter(event => event.kind === "cancel-requested"))
        .toEqual([{ kind: "cancel-requested", cause: "keyboard-input", pid: child.pid }]);
      expect(completed[0]).toMatchObject({ state: "interrupted", tests: ["passed"] });
      expect(closed[0]?.cancelled).toBe(true);
    } else {
      expect(report.numFailedTests).toBe(0);
      expect(completed[0]?.state).toBe("passed");
      expect(events.some(event => event.kind === "cancel-requested")).toBe(false);
      expect(closed[0]?.cancelled).toBe(false);
    }
    return { events, runnerPid: child.pid, cancelled: closed[0]?.cancelled === true, rewrittenFiles };
  };
  return { discover, launch };
}
