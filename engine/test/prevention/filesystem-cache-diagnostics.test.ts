import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTempDir } from "../support/temp-dir.ts";

const PROBE = String.raw`
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import{pathToFileURL}from'node:url';import{syncBuiltinESMExports}from'node:module';
const [owner,fault,root]=process.argv.slice(1),load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const {createFilesystemCache}=await load('scripts/verification/filesystem-cache.ts');
const {atomicWriteFile}=await load('src/filesystem/atomic-write.ts');
const {resetDebugSystem,getDebugSignals}=await load('src/shared/debug/debug-system.ts');
const s1=await load('scripts/tooling/s1-verification.ts');
const {DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY,DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES}=await load('src/workflow/workflow-config.ts');
const directory=owner==='s1'?DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY:'diagnostic-cache',cacheDir=path.join(process.env.TMPDIR,directory),counter=path.join(cacheDir,'.write-counter');
const cache=createFilesystemCache({directory,maxEntries:2});
let baseline,candidate,file,oldBytes,write;
if(owner==='s1'){
 candidate=(await load('test/support/repository-local-temporary.ts')).createRepositoryLocalTemporaryDirectory('cache-diagnostics-');fs.mkdirSync(path.join(candidate,'src'));
 baseline=s1.verifyS1Structure(candidate);file=path.join(cacheDir,baseline.repositoryManifestHash+'.json');
 const stale=JSON.parse(fs.readFileSync(file,'utf8'));stale.schemaVersion='unrecognized-cache-schema';fs.writeFileSync(file,JSON.stringify(stale));
 write=()=>{s1.clearVerifyS1StructureCache();return s1.verifyS1Structure(candidate);};
}else{
 cache.write('target',{marker:'original'});file=path.join(cacheDir,fs.readdirSync(cacheDir).find(name=>name.endsWith('.json')));
 write=()=>cache.write(fault==='trim-stat'||fault==='trim-readdir'?'next':'target',{marker:'replacement'});
}
oldBytes=fs.readFileSync(file);
fs.writeFileSync(counter,'1'.repeat((owner==='s1'?DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES:2)-1));
const native={statSync:fs.statSync,readdirSync:fs.readdirSync,renameSync:fs.renameSync},warn=console.warn,warnings=[];
let failures=0,lowerReports=null,lowerThrew=false,targetStats=0;
const fail=()=>{failures++;throw Error('private-cache-path-and-secret');};
try{
 console.warn=(...args)=>{warnings.push(args);};
 fs.statSync=function(p,...args){if(String(p)===file)targetStats++;if((fault==='counter-stat'&&String(p)===counter)||(fault==='existing-stat'&&String(p)===file)||(fault==='trim-stat'&&String(p)===file&&(owner!=='s1'||targetStats>1)))return fail();return native.statSync.call(this,p,...args);};
 fs.readdirSync=function(p,...args){if(fault==='trim-readdir'&&String(p)===cacheDir)return fail();return native.readdirSync.call(this,p,...args);};
 fs.renameSync=function(from,to,...args){if(fault==='publish-rename'&&String(to)===file)return fail();return native.renameSync.call(this,from,to,...args);};
 syncBuiltinESMExports();
 if(owner==='generic'&&fault==='publish-rename'){
  resetDebugSystem();const lower=atomicWriteFile(file,'replacement');assert.equal(lower.success,false);lowerReports=getDebugSignals().bestEffortFailures;assert.equal(lowerReports,0,'primary rename failure is returned without lower-owner reporting');assert.deepEqual(fs.readFileSync(file),oldBytes);
 }
 if(owner==='generic'&&fault==='existing-stat'){
  resetDebugSystem();assert.throws(()=>atomicWriteFile(file,'replacement'));lowerThrew=true;assert.equal(getDebugSignals().bestEffortFailures,0,'pre-try stat propagates before lower reporting');
 }
 resetDebugSystem();warnings.length=0;failures=0;
 const result=write();
 if(owner==='s1')assert.deepEqual(result,baseline,'optional-cache failure cannot change verification result');
 assert.equal(failures,1,'the selected native boundary must be reached exactly once');
 if(owner==='s1'&&fault==='trim-stat')assert.equal(targetStats,2,'the pre-publication stat succeeds before the trim stat fails');
 assert.equal(getDebugSignals().bestEffortFailures,1,'one fixed central diagnostic for the isolated cache failure');
 assert.ok(warnings.length>0,'central fallback diagnostic is observable');
 assert.ok(warnings.every(args=>args.length===1&&args[0]==='[debug] diagnostic unavailable'),'no path/reason/value-specific diagnostic');
 if(fault==='publish-rename'||fault==='existing-stat')assert.deepEqual(fs.readFileSync(file),oldBytes,'failed publication leaves prior destination bytes');
 else if(owner==='generic')assert.deepEqual(cache.read(fault.startsWith('trim-')?'next':'target',v=>v),{marker:'replacement'},'successful optional publication remains readable');
 console.log(JSON.stringify({owner,fault,failures,centralReports:getDebugSignals().bestEffortFailures,lowerReports,lowerThrew,primaryStable:true}));
}finally{fs.statSync=native.statSync;fs.readdirSync=native.readdirSync;fs.renameSync=native.renameSync;syncBuiltinESMExports();console.warn=warn;resetDebugSystem();}
`;

for (const owner of ["generic", "s1"]) {
  for (const fault of ["counter-stat", "trim-readdir", "trim-stat", "publish-rename", "existing-stat"]) {
    test(`cache diagnostics: ${owner} ${fault} reports once and preserves its primary outcome`, () => {
      const home = createTempDir(`cache-diagnostic-${owner}-${fault}-`);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE, owner, fault,
        fileURLToPath(new URL("../../", import.meta.url))], {
        env: { ...process.env, TMPDIR: home }, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).primaryStable, true);
      // The witness: the canary-bearing failure really was raised once and
      // reported once centrally — and its text still never reached stderr.
      assert.match(result.stdout, /"failures":1,"centralReports":1,/u);
      assert.ok(!result.stderr.includes("private-cache-path-and-secret"));
    });
  }
}
