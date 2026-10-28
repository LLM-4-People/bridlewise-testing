// @vitest-environment node
/**
 * ONE DEAD DATABASE THREAD IS REPLACED, NEVER A PERMANENT OUTAGE (SCALE-CR1 C4).
 *
 * ── The defect (reproduced) ──
 * `ThreadBackend.failAll` was permanent: once any database thread died (a
 * reader that runs out of memory on a huge history read is exactly how one
 * dies), every later call failed `db_worker_exited` for the life of the
 * process — the server stayed up and served nothing.
 *
 * ── The rule ──
 * After the open, each thread is supervised. A dead reader is respawned and
 * the reads it held are retried; a dead writer is respawned (its open
 * re-verifies the schema) and the writes it held are answered
 * `db_write_outcome_unknown`; restarts past the window's budget open a
 * circuit that answers `db_unavailable` for one window, then retries.
 * Driven through the real facade on real worker threads.
 */
import { expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { nativeModuleUrl as url, runNativeScript } from "../helpers/native-script.ts";

const CAPTURE = `
  import assert from 'node:assert/strict';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';
  const NativeWorker=workers.Worker,captured=[];workers.Worker=class extends NativeWorker{constructor(target,options){super(target,options);this.fixtureRole=options.workerData.role;captured.push(this);}};syncBuiltinESMExports();
  const{ThreadBackend,databaseThreadSupervision}=await import(${url("db/thread-backend.ts")});
  const live=(role)=>captured.filter(w=>w.fixtureRole===role&&w.threadId!==-1);
  const settle=(p)=>p.then(v=>({ok:true,value:v}),e=>({ok:false,code:e.code}));
`;

test("a killed reader is replaced and its read retried; a killed writer is replaced, its in-flight write answered typed, later writes succeed", () => {
  const dir = createTempDir("db-supervision-");
  const result = runNativeScript(`${CAPTURE}
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0,restartMax:5,restartWindowMs:60000});
    const watchdog=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));process.exit(3);},20000);
    try{
      await backend.call('createProject',[{name:'before',path:'/before'},'owner']);
      // A read in flight when its reader dies is retried on the replacement.
      const [reader]=live('reader');const read=settle(backend.call('listProjects',['owner']));void reader.terminate();
      const readOutcome=await read;
      assert.equal(readOutcome.ok,true);assert.deepEqual(readOutcome.value.map(p=>p.name),['before']);
      assert.equal(live('reader').length,1);assert.notEqual(live('reader')[0],reader);
      // A write posted to a writer that is being stopped: its outcome is unknown, typed — never a hang.
      const [writer]=live('writer');const stopping=writer.terminate();const inflight=settle(backend.call('createProject',[{name:'in flight',path:'/in-flight'},'owner']));await stopping;
      const inflightOutcome=await inflight;
      assert.ok(inflightOutcome.ok===true||inflightOutcome.code==='db_write_outcome_unknown',JSON.stringify(inflightOutcome));
      // Later writes and reads succeed on the replacement writer.
      await backend.call('createProject',[{name:'after',path:'/after'},'owner']);
      const names=(await backend.call('listProjects',['owner'])).map(p=>p.name);
      assert.ok(names.includes('before')&&names.includes('after'),JSON.stringify(names));
      const supervision=databaseThreadSupervision();
      assert.equal(supervision.state,'ready');assert.equal(supervision.restarts,2);
      // The circuit's budget in force is readable (the database.threads.restartMax|restartWindowMs signals).
      assert.equal(supervision.restartMax,5);assert.equal(supervision.restartWindowMs,60000);
      console.log(JSON.stringify({inflight:inflightOutcome.ok?'committed':inflightOutcome.code,supervision}));
    }finally{clearTimeout(watchdog);await backend.close();}
    assert.equal(captured.filter(w=>w.threadId!==-1).length,0);
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("restarts past the window's budget open the circuit: calls answer db_unavailable (retryable) instead of hanging, and it is not permanent", () => {
  const dir = createTempDir("db-circuit-");
  const result = runNativeScript(`${CAPTURE}
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0,restartMax:1,restartWindowMs:1500});
    const watchdog=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));process.exit(3);},20000);
    try{
      await backend.call('createProject',[{name:'one',path:'/one'},'owner']);
      // First loss: restarted (budget 1). Second loss inside the window: the circuit opens.
      await live('writer')[0].terminate();
      await backend.call('createProject',[{name:'two',path:'/two'},'owner']);
      await live('writer')[0].terminate();
      await new Promise(r=>setTimeout(r,50));
      const refused=await settle(backend.call('createProject',[{name:'refused',path:'/refused'},'owner']));
      assert.deepEqual(refused,{ok:false,code:'db_unavailable'});
      assert.equal(databaseThreadSupervision().state,'circuit-open');
      // Reads still serve from the live reader meanwhile.
      assert.equal((await settle(backend.call('listProjects',['owner']))).ok,true);
      // After the window the writer is restarted and writes succeed again.
      await new Promise(r=>setTimeout(r,2500));
      await backend.call('createProject',[{name:'three',path:'/three'},'owner']);
      assert.equal(databaseThreadSupervision().state,'ready');
      console.log(JSON.stringify({ok:true}));
    }finally{clearTimeout(watchdog);await backend.close();}
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("a thread that stops while the facade closes answers its calls, so the close completes", () => {
  const dir = createTempDir("db-close-loss-");
  // The writer is held INSIDE a write (a gate it waits on), so the write is
  // certainly in flight when the writer is stopped during the close.
  const result = runNativeScript(`
    import assert from 'node:assert/strict';import fs from 'node:fs';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';
    const gate=new Int32Array(new SharedArrayBuffer(4)),held=Promise.withResolvers(),captured=[];
    const wrapper=${JSON.stringify(join(dir, "writer-gate.mjs"))};
    fs.writeFileSync(wrapper,'import{parentPort,workerData}from"node:worker_threads";parentPort.on("message",message=>{if(message.method==="createProject"){parentPort.postMessage({fixtureHeld:true});Atomics.wait(new Int32Array(workerData.fixtureGate),0,0);}});await import(workerData.fixtureOriginal);');
    const NativeWorker=workers.Worker;
    workers.Worker=class extends NativeWorker{constructor(target,options){const writer=options.workerData.role==='writer';super(writer?new URL('file://'+wrapper):target,writer?{...options,workerData:{...options.workerData,fixtureGate:gate.buffer,fixtureOriginal:target.href}}:options);this.fixtureRole=options.workerData.role;captured.push(this);this.on('message',m=>{if(m.fixtureHeld)held.resolve();});}};syncBuiltinESMExports();
    const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0});
    const watchdog=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));process.exit(3);},15000);
    try{
      const write=backend.call('createProject',[{name:'in flight',path:'/in-flight'},'owner']).then(()=>({ok:true}),e=>({ok:false,code:e.code}));
      await held.promise;
      const closing=backend.close();
      await captured.find(w=>w.fixtureRole==='writer').terminate();
      assert.deepEqual(await write,{ok:false,code:'db_closed'});
      await closing;
      assert.equal(captured.filter(w=>w.threadId!==-1).length,0,'every thread joined; nothing was restarted');
      assert.equal(captured.length,2);
      console.log(JSON.stringify({closed:true}));
    }finally{clearTimeout(watchdog);Atomics.store(gate,0,1);Atomics.notify(gate,0);}
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("a respawn that fails before it is ready starts ONE replacement: one live writer, restarts counted once each, writes commit in issue order (W1, SCALE-CR1-FIX N1)", () => {
  const dir = createTempDir("db-failed-respawn-");
  // A path THROUGH a regular file: no open can succeed there (ENOTDIR).
  writeFileSync(join(dir, "blocker"), "");
  // The SECOND writer spawn opens an unopenable path (a transient open
  // failure: a busy lock, EMFILE): its thread answers ready:false and exits.
  // Before the fix that one failure was seen twice — by the spawn's promise
  // AND by the exit listener — so two replacements started, both lived, and
  // writes committed on two writers out of issue order.
  const result = runNativeScript(`
    import assert from 'node:assert/strict';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';import{DatabaseSync}from'node:sqlite';
    const NativeWorker=workers.Worker,captured=[];let writerSpawns=0;
    workers.Worker=class extends NativeWorker{constructor(target,options){let o=options;if(options.workerData.role==='writer'){writerSpawns+=1;if(writerSpawns===2)o={...options,workerData:{...options.workerData,path:${JSON.stringify(join(dir, "blocker", "web.db"))}}};}super(target,o);this.fixtureRole=options.workerData.role;captured.push(this);}};syncBuiltinESMExports();
    const{ThreadBackend,databaseThreadSupervision}=await import(${url("db/thread-backend.ts")});
    const live=(role)=>captured.filter(w=>w.fixtureRole===role&&w.threadId!==-1);
    const path=${JSON.stringify(join(dir, "web.db"))};
    const backend=await ThreadBackend.open({path,readers:1,durabilityWindowMs:0,restartMax:5,restartWindowMs:60000});
    const watchdog=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));process.exit(3);},30000);
    try{
      await backend.call('createProject',[{name:'first',path:'/first'},'owner']);
      await live('writer')[0].terminate();
      // Writes issued while the writer is being replaced, in a known order.
      const issued=[];for(let i=0;i<120;i+=1){issued.push(backend.call('createProject',[{name:'p'+i,path:'/p'+i},'owner']));await new Promise(r=>setTimeout(r,2));}
      await Promise.all(issued);
      await new Promise(r=>setTimeout(r,300));
      assert.equal(writerSpawns,3,'one failed respawn, then exactly one replacement');
      assert.equal(live('writer').length,1,'exactly one live writer');
      const supervision=databaseThreadSupervision();
      assert.equal(supervision.restarts,2);assert.equal(supervision.state,'ready');
      const byId=new Map((await backend.call('listProjects',['owner'])).map(p=>[p.id,p.path]));
      await backend.close();
      const db=new DatabaseSync(path,{readOnly:true});
      const order=db.prepare('SELECT id FROM projects ORDER BY rowid').all().map(r=>byId.get(r.id)).filter(p=>/^\\/p\\d+$/.test(p)).map(p=>Number(p.slice(2)));
      db.close();
      assert.deepEqual(order,[...order].sort((a,b)=>a-b),'writes committed out of issue order');
      assert.equal(order.length,120);
      console.log(JSON.stringify({writerSpawns,restarts:supervision.restarts}));
    }finally{clearTimeout(watchdog);await backend.close();}
    assert.equal(captured.filter(w=>w.threadId!==-1).length,0);
  `, 80_000);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("a close while a respawn is in flight answers the call held for it (db_closed) and completes (SCALE-CR1-FIX N2)", () => {
  const dir = createTempDir("db-close-respawn-");
  const result = runNativeScript(`${CAPTURE}
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0});
    const watchdog=setTimeout(()=>{console.log(JSON.stringify({timeout:true}));process.exit(3);},15000);
    try{
      await backend.call('createProject',[{name:'a',path:'/a'},'owner']);
      await live('writer')[0].terminate();
      // The exit was seen and the replacement is starting: this write is HELD for it.
      await new Promise(r=>setTimeout(r,20));
      const held=settle(backend.call('createProject',[{name:'held',path:'/held'},'owner']));
      await backend.close();
      assert.deepEqual(await held,{ok:false,code:'db_closed'});
      console.log(JSON.stringify({closed:true}));
    }finally{clearTimeout(watchdog);}
    await new Promise(r=>setTimeout(r,200));
    assert.equal(captured.filter(w=>w.threadId!==-1).length,0,'every thread joined, the replacement included');
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
