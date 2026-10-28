// @vitest-environment node
import { expect, test } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { nativeModuleUrl as url, runNativeScript } from "../helpers/native-script.ts";

test("reader count admission precedes key, database and worker acquisition while one reader remains supported", () => {
  const dir = createTempDir("db-reader-count-");
  const result = runNativeScript(`
    import assert from 'node:assert/strict';import fs from 'node:fs';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';
    const NativeWorker=workers.Worker,captured=[];workers.Worker=class extends NativeWorker{constructor(...args){super(...args);captured.push(this);}};syncBuiltinESMExports();
    const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
    const path=${JSON.stringify(join(dir, "web.db"))};
    const{databaseKeyFile,admitKeyHome,keyHomeLocation}=await import(${url("filesystem/self-protection/key-home.ts")});
    const keyPath=databaseKeyFile(admitKeyHome(keyHomeLocation(),[]),path);
    for(const readers of [0,-1,NaN,Infinity,-Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
      await assert.rejects(ThreadBackend.open({path,readers,durabilityWindowMs:0}),{code:'db_reader_count_invalid'});
      assert.equal(captured.length,0);assert.equal(fs.existsSync(path),false);assert.equal(fs.existsSync(keyPath),false);
    }
    const backend=await ThreadBackend.open({path,readers:1,durabilityWindowMs:0});
    try{assert.deepEqual(await backend.call('listProjects',['owner']),[]);assert.equal(captured.length,2);}
    finally{await backend.close();await Promise.allSettled(captured.map(w=>w.terminate()));}
    assert.ok(captured.every(w=>w.threadId===-1));console.log(JSON.stringify({invalid:7,workers:captured.length,joined:true}));
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ invalid: 7, workers: 2, joined: true });
});

test("concurrent web migrations re-read the registry only after acquiring the write transaction", () => {
  const dir = createTempDir("web-migration-startup-");
  const result = runNativeScript(`
    import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn}from'node:child_process';import {DatabaseSync}from'node:sqlite';
    const path=${JSON.stringify(join(dir, "web.db"))};
    const{createDbCrypto}=await import(${url("db/db-crypto.ts")});createDbCrypto({dbPath:path});
    const raw=new DatabaseSync(path);raw.exec('PRAGMA journal_mode=WAL;CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');raw.close();
    const source='import fs from "node:fs";import{DatabaseSync}from"node:sqlite";let gated=false;const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(!gated&&sql.trim().startsWith("BEGIN")){gated=true;console.log("READY");fs.readSync(0,Buffer.alloc(1),0,1,null);}return exec.call(this,sql);};const{DbClient}=await import('+JSON.stringify(${url("db/client.ts")})+');try{const db=new DbClient({path:'+JSON.stringify(path)+',durabilityWindowMs:0});console.log(JSON.stringify({opened:true,version:db.schemaVersion}));db.close();}catch(e){console.log(JSON.stringify({opened:false,code:e.code,errcode:e.errcode,message:e.message}));}';
    const children=[];const timer=setTimeout(()=>children.forEach(c=>c.child.kill('SIGKILL')),15000);
    function launch(){const child=spawn(process.execPath,['--input-type=module','-e',source]);let out='',err='';const ready=Promise.withResolvers();const joined=new Promise(resolve=>child.on('close',(code,signal)=>{ready.reject(Error('early exit'));resolve({code,signal,out,err});}));child.stdout.on('data',b=>{out+=b;if(out.includes('READY'))ready.resolve();});child.stderr.on('data',b=>err+=b);child.on('error',ready.reject);void ready.promise.catch(()=>{});const c={child,ready:ready.promise,joined};children.push(c);return c;}
    try{const a=launch(),b=launch();await Promise.all([a.ready,b.ready]);a.child.stdin.write('x');const ar=await a.joined;b.child.stdin.write('x');const br=await b.joined;const results=[ar,br].map(r=>{assert.equal(r.code,0,r.err);return JSON.parse(r.out.split('\\n').find(l=>l.startsWith('{')));});console.log(JSON.stringify({results}));assert.ok(results.every(r=>r.opened));assert.equal(results[0].version,results[1].version);}
    finally{clearTimeout(timer);children.forEach(c=>{if(c.child.exitCode===null)c.child.kill('SIGKILL');});await Promise.allSettled(children.map(c=>c.joined));}
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

for (const fault of ["reader-open", "before-ready-exit", "ready-writer-exit", "running-writer-exit"] as const) {
  test(`threaded startup joins every acquired worker after ${fault}`, () => {
    const dir = createTempDir("db-startup-");
    const result = runNativeScript(`
      import assert from 'node:assert/strict';import fs from 'node:fs';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';
      const fault=${JSON.stringify(fault)},gate=new Int32Array(new SharedArrayBuffer(4)),captured=[],ready=[];
      const gated=Promise.withResolvers(),readerReady=Promise.withResolvers(),writerReady=Promise.withResolvers();
      const NativeWorker=workers.Worker;let readers=0;
      const wrapper=${JSON.stringify(join(dir, "gated.mjs"))};
      fs.writeFileSync(wrapper, 'import{parentPort,workerData}from"node:worker_threads";parentPort.postMessage({fixtureGate:true});Atomics.wait(new Int32Array(workerData.fixtureGate),0,0);await import(workerData.fixtureOriginal);');
      workers.Worker=class extends NativeWorker{constructor(target,options){
        const data=options.workerData;const held=data.role==='reader'&&++readers===2;
        super(held?new URL('file://'+wrapper):target,held?{...options,workerData:{...data,...(fault==='reader-open'?{path:${JSON.stringify(join(dir, "missing.db"))}}:{}),fixtureGate:gate.buffer,fixtureOriginal:target.href}}:options);
        captured.push(this);this.on('message',m=>{if(m.fixtureGate)gated.resolve(this);if(m.ready===true){ready.push(this);(data.role==='writer'?writerReady:readerReady).resolve(this);}});
        this.on('error',()=>{});
      }};syncBuiltinESMExports();
      const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
      const unhandled=[];process.on('unhandledRejection',e=>unhandled.push(String(e)));
      const opening=ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:2,durabilityWindowMs:0});
      const settled=opening.then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
      let deadline;const bounded=new Promise(resolve=>{deadline=setTimeout(()=>resolve({timeout:true}),5000);});
      try{
        const held=await gated.promise;await readerReady.promise;const writer=await writerReady.promise;
        if(fault==='before-ready-exit')await held.terminate();
        if(fault==='ready-writer-exit')await writer.terminate();
        if(fault!=='before-ready-exit'){Atomics.store(gate,0,1);Atomics.notify(gate,0);}
        let outcome=await Promise.race([settled,bounded]);
        // A writer that dies AFTER the open is supervised (SCALE-CR1 C4): it is
        // respawned and the next write succeeds; the facade then closes cleanly.
        if(fault==='running-writer-exit'&&outcome.ok){const backend=outcome.value;await writer.terminate();outcome=await Promise.race([backend.call('createProject',[{name:'after failure',path:'/after-failure'},'owner']).then(()=>({ok:true,respawned:true}),e=>({ok:false,code:e.code})),bounded]);await backend.close();}
        clearTimeout(deadline);
        const live=captured.filter(w=>w.threadId!==-1).length;
        console.log(JSON.stringify({fault,outcome:outcome.timeout?'timeout':outcome.respawned?'respawned':outcome.ok?'opened':outcome.code,live,workers:captured.length,unhandled}));
        assert.equal(outcome.timeout,undefined);
        if(fault==='running-writer-exit')assert.equal(outcome.respawned,true);
        else{assert.equal(outcome.ok,false);assert.equal(outcome.code,fault==='reader-open'?'db_worker_error':'db_worker_exited');}
        assert.equal(live,0);assert.equal(unhandled.length,0);
      }finally{clearTimeout(deadline);Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.allSettled(captured.map(w=>w.terminate()));}
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { live: number; workers: number };
    // The supervised writer's replacement is the fourth thread (C4).
    expect(receipt.live).toBe(0); expect(receipt.workers).toBe(fault === "running-writer-exit" ? 4 : 3);
  });
}

test("transactions after a joined close refuse without posting to a terminated worker", () => {
  const dir = createTempDir("db-closed-transaction-");
  const result = runNativeScript(`
    import assert from 'node:assert/strict';
    const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0});
    await backend.close();let timer;
    try{const outcome=await Promise.race([backend.transaction([]).then(()=>({ok:true}),e=>({code:e.code})),new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),1000);})]);console.log(JSON.stringify(outcome));assert.deepEqual(outcome,{code:'db_closed'});}finally{clearTimeout(timer);await backend.close();}
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("an uncloneable later write cannot release reads past an earlier native write", () => {
  const dir = createTempDir("db-write-frontier-");
  const result = runNativeScript(`
    import assert from 'node:assert/strict';import fs from 'node:fs';import workers from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';
    const gate=new Int32Array(new SharedArrayBuffer(4)),held=Promise.withResolvers(),captured=[];let reading=0,armed=false;
    const wrapper=${JSON.stringify(join(dir, "writer-gate.mjs"))};
    fs.writeFileSync(wrapper,'import{parentPort,workerData}from"node:worker_threads";parentPort.on("message",message=>{if(message.method==="createProject"){parentPort.postMessage({fixtureHeld:true});Atomics.wait(new Int32Array(workerData.fixtureGate),0,0);}});await import(workerData.fixtureOriginal);');
    const NativeWorker=workers.Worker;
    workers.Worker=class extends NativeWorker{constructor(target,options){const writer=options.workerData.role==='writer';super(writer?new URL('file://'+wrapper):target,writer?{...options,workerData:{...options.workerData,fixtureGate:gate.buffer,fixtureOriginal:target.href}}:options);this.fixtureRole=options.workerData.role;captured.push(this);this.on('message',m=>{if(m.fixtureHeld)held.resolve();});}postMessage(message,...rest){if(armed&&this.fixtureRole==='reader'&&message.method==='listProjects')reading++;return super.postMessage(message,...rest);}};syncBuiltinESMExports();
    const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
    const backend=await ThreadBackend.open({path:${JSON.stringify(join(dir, "web.db"))},readers:1,durabilityWindowMs:0});
    let first,second,read;const watchdog=setTimeout(()=>{Atomics.store(gate,0,1);Atomics.notify(gate,0);},5000);
    try{armed=true;first=backend.call('createProject',[{name:'first',path:'/first'},'owner']);void first.catch(()=>{});await held.promise;
      second=backend.call('createProject',[{name:'bad',path:'/bad',uncloneable:()=>{}},'owner']);await assert.rejects(second,{name:'DataCloneError'});
      read=backend.call('listProjects',['owner']);void read.catch(()=>{});let closed=false;const closing=backend.close().then(()=>{closed=true;});await assert.rejects(backend.transaction([]),{code:'db_closed'});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
      const beforeRelease=reading;Atomics.store(gate,0,1);Atomics.notify(gate,0);await first;const rows=await read;
      console.log(JSON.stringify({beforeRelease,names:rows.map(r=>r.name)}));assert.equal(beforeRelease,0);assert.deepEqual(rows.map(r=>r.name),['first']);
      await closing;assert.ok(captured.every(w=>w.threadId===-1));
    }finally{clearTimeout(watchdog);Atomics.store(gate,0,1);Atomics.notify(gate,0);await Promise.allSettled([first,second,read]);await backend.close();await Promise.allSettled(captured.map(w=>w.terminate()));}
  `);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
