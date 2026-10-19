import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTempDir } from "../support/temp-dir.ts";

// Real owner-produced envelopes are poisoned on disk. Every child starts with
// fresh module/result caches in its own filesystem namespace.
const PROBE = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const [owner,root] = process.argv.slice(1), home=process.env.TMPDIR;
const load = relative => import(pathToFileURL(path.join(root,relative)).href);
const {canonicalJson}=await load('src/kernel/integrity.ts');
const {ARCHITECTURE_MANIFEST}=await load('src/architecture-manifest.ts');
const arch=await load('scripts/verification/architecture.ts');
const lex=await load('scripts/verification/static-source.ts');
const s1=await load('scripts/tooling/s1-verification.ts');
const governed=await load('scripts/tooling/verification/governed-source.ts');
const candidate=owner==='s1' ? (await load('test/support/repository-local-temporary.ts')).createRepositoryLocalTemporaryDirectory('cache-admission-') : undefined;
if(candidate!==undefined)fs.mkdirSync(path.join(candidate,'src'));
const source={
 architecture:'import {readFileSync} from "node:fs"; export class Probe extends Error {} export function run(){ return readFileSync("./fixed"); }',
 lexical:'import {x} from "./helper.ts"; import type {T} from "./types.ts"; export const p=import(runtimeName); const e=process.env.HOME; const u=process["env"];',
 literal:'const VALUE={fraction:1.5,large:1e200,zero:0,no:false,nil:null,empty:"",list:[],record:{},nested:[1,{x:2}]};',
 governed:'const value=process.env.HOME;',
};
const directory={architecture:'harness-arch-cache',lexical:'harness-static-cache',literal:'harness-static-literal-cache',s1:'harness-s1-cache',governed:'harness-governed-cache'}[owner];
const cacheDir=path.join(home,directory);
const clear=()=>{arch.clearArchitectureSourceCache();lex.clearStaticModuleShapeCache();governed.clearGovernedSourceParseCache();s1.clearVerifyS1StructureCache();};
const call=()=>{
 if(owner==='architecture')return arch.analyzeArchitectureSource('src/cache-shape.ts',source[owner]);
 if(owner==='lexical')return lex.analyzeStaticModuleShape(source[owner],'src/cache-shape.ts');
 if(owner==='literal')return s1.extractBoundedTopLevelStaticLiteral(source[owner],'VALUE',[]);
 if(owner==='s1')return s1.verifyS1Structure(candidate);
 const out=[];governed.verifyGovernedTypeScriptSource('src/cache-shape.ts',source[owner],out,true,new Set());return out;
};
clear();const baseline=call(),baselineJson=canonicalJson(baseline);
const files=fs.readdirSync(cacheDir).filter(n=>n.endsWith('.json'));
assert.equal(files.length,1,'fixture owns one legitimate cache envelope');
const file=path.join(cacheDir,files[0]),original=fs.readFileSync(file,'utf8'),entry=JSON.parse(original),field=owner==='s1'?'result':'value';
assert.equal(canonicalJson(entry[field]),baselineJson);
const nativeRead=fs.readFileSync;let reads=0;
fs.readFileSync=function(p,...args){if(String(p)===file)reads++;return nativeRead.call(this,p,...args);};syncBuiltinESMExports();
const counter=()=>nativeRead(path.join(cacheDir,'.write-counter')).length;
const cases=[];
function arm(name,mutate){cases.push({name,mutate});}
function fieldArms(keys){for(const key of keys){arm('missing '+key,v=>{delete v[key];});arm('null '+key,v=>{v[key]=null;});}}
if(owner==='architecture'){
 fieldArms(['dependencies','typeOnlyDependencies','importedSymbols','exportedNames','declaredNames','constructedTypes','directEffectFacts','unmodeledEffects','directExecutionEntrypoint','topLevelExecution','nodeCount']);
 for(const key of ['dependencies','typeOnlyDependencies','exportedNames','constructedTypes','unmodeledEffects'])arm('nonstring '+key,v=>{v[key]=[1];});
 for(const key of ['importedName','localName','source']){arm('missing imported '+key,v=>{delete v.importedSymbols[0][key];});arm('bad imported '+key,v=>{v.importedSymbols[0][key]=1;});}
 for(const key of ['name','kind','extendsGlobalError']){arm('missing declared '+key,v=>{delete v.declaredNames[0][key];});arm('bad declared '+key,v=>{v.declaredNames[0][key]=key==='extendsGlobalError'?'false':1;});}
 for(const key of ['importedSymbols','declaredNames','directEffectFacts'])arm('null nested '+key,v=>{v[key]=[null];});
 assert.ok(baseline.directEffectFacts.length>0);
 arm('missing effect owner',v=>{delete v.directEffectFacts[0].ownerLabel;});arm('bad effect owner',v=>{v.directEffectFacts[0].ownerLabel=1;});
 arm('missing effect array',v=>{delete v.directEffectFacts[0].effects;});arm('bad effect array',v=>{v.directEffectFacts[0].effects=null;});
 arm('unknown effect',v=>{v.directEffectFacts[0].effects=['made-up-effect'];});arm('numeric effect',v=>{v.directEffectFacts[0].effects=[1];});
 for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1])arm('node count '+value,v=>{v.nodeCount=value;});
 arm('overflow node count',v=>{v.nodeCount='CACHE_NUMERIC_OVERFLOW';});
}else if(owner==='lexical'){
 fieldArms(['exportedNames','analysis']);
 arm('nonstring exports',v=>{v.exportedNames=[1];});
 for(const key of Object.keys(baseline.analysis)){arm('missing analysis '+key,v=>{delete v.analysis[key];});arm('null analysis '+key,v=>{v.analysis[key]=null;});}
 arm('bad erased reference',v=>{v.analysis.typeOnlyModuleReferences=[1];});
 for(const key of ['moduleAcquisitions','environmentAcquisitions'])arm('null nested '+key,v=>{v.analysis[key]=[null];});
 for(const key of ['kind','specifier']){arm('missing acquisition '+key,v=>{delete v.analysis.moduleAcquisitions[0][key];});arm('bad acquisition '+key,v=>{v.analysis.moduleAcquisitions[0][key]=key==='kind'?'made-up-kind':1;});}
 for(const key of ['form','name']){arm('missing environment '+key,v=>{delete v.analysis.environmentAcquisitions[0][key];});arm('bad environment '+key,v=>{v.analysis.environmentAcquisitions[0][key]=key==='form'?'made-up-form':1;});}
 assert.ok(baseline.analysis.moduleAcquisitions.some(x=>x.specifier===null));assert.ok(baseline.analysis.environmentAcquisitions.some(x=>x.name===null));
}else if(owner==='literal'){
 arm('missing successful value',v=>{delete v.value;});arm('numeric ok',v=>{v.ok=1;});
 arm('overflow scalar',v=>{v.value='CACHE_NUMERIC_OVERFLOW';});arm('overflow nested array',v=>{v.value=[{deep:['CACHE_NUMERIC_OVERFLOW']}];});
}else if(owner==='s1'){
 fieldArms(['ok','repositoryManifestHash','violations']);
 arm('nonstring violation',v=>{v.violations.push(1);});arm('foreign result hash',v=>{v.repositoryManifestHash='0'.repeat(64);});
 arm('true with violations',v=>{v.ok=true;});arm('false without violations',v=>{v.ok=false;v.violations=[];});
 assert.equal(baseline.ok,false);assert.ok(baseline.violations.length>0);
}else{
 arm('nonstring violation',v=>{v.push(1);});arm('nested violation',v=>{v.push([]);});
}
const failures=[],observed=[];
try{
 // A valid entry must really hit: cold result memory, observed file read,
 // exact complete value, and no result write/counter increment.
 clear();reads=0;const warmCounter=counter();assert.equal(canonicalJson(call()),baselineJson);assert.ok(reads>0, 'actual filesystem warm path: '+baselineJson);assert.equal(counter(),warmCounter);
 for(const {name,mutate}of cases){
  const poisoned=JSON.parse(original);mutate(poisoned[field]);
  const raw=JSON.stringify(poisoned).replaceAll('"CACHE_NUMERIC_OVERFLOW"','1e309');
  fs.writeFileSync(file,raw);assert.equal(nativeRead(file,'utf8'),raw);
  clear();reads=0;const before=counter();
  try{const actual=call();assert.equal(canonicalJson(actual),baselineJson);assert.ok(reads>0);assert.ok(counter()>before,'refused cache is replaced by actual computation');assert.equal(canonicalJson(JSON.parse(nativeRead(file,'utf8'))[field]),baselineJson);observed.push(name);}catch(error){failures.push({name,message:error.message});}
 }
 const validVariants=[];
 if(owner==='architecture')validVariants.push({...baseline,nodeCount:ARCHITECTURE_MANIFEST.analysisLimits.maximumAstNodes+1});
 if(owner==='literal')for(const value of [null,false,0,1.5,1e200,'',[],{}])validVariants.push({ok:true,value});
 if(owner==='literal')validVariants.push({ok:false});
 if(owner==='s1')validVariants.push({...baseline,ok:true,violations:[]});
 for(const valid of validVariants){const value={...entry,[field]:valid};fs.writeFileSync(file,JSON.stringify(value));clear();reads=0;const before=counter();assert.equal(canonicalJson(call()),canonicalJson(valid));assert.ok(reads>0);assert.equal(counter(),before,'valid cache variant must hit');}
 console.log(JSON.stringify({owner,arms:cases.length,rejected:observed.length,failures,validWarm:true,validVariants:validVariants.length}));
 assert.deepEqual(failures,[],'all malformed values must be refused at the actual owner');
}finally{fs.readFileSync=nativeRead;syncBuiltinESMExports();fs.writeFileSync(file,original);clear();}
`;

for (const owner of ["architecture", "lexical", "literal", "s1", "governed"]) {
  test(`cache value admission: ${owner} rejects complete malformed records and keeps valid warmth`, () => {
    const home = createTempDir(`cache-values-${owner}-`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE, owner,
      fileURLToPath(new URL("../../", import.meta.url))], {
      env: { ...process.env, TMPDIR: home }, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.rejected, report.arms);
    assert.equal(report.validWarm, true);
  });
}

test("cache value admission: literal binding holes refuse in either cache order", async () => {
  const { extractBoundedTopLevelStaticLiteral: extract } = await import("../../scripts/tooling/s1-verification.ts");
  const { InputError } = await import("../../src/kernel/errors.ts");
  for (const sparseFirst of [false, true]) {
    const source = `import {Values} from "./values.ts"; const ROOT={selected:Values.marker}; // sparse-${sparseFirst}`;
    const empty = { Values: { importSource: "./values.ts", value: { marker: [] } } };
    const sparse = { Values: { importSource: "./values.ts", value: { marker: Array(1) } } };
    const readEmpty = () => {
      const result = extract(source, "ROOT", ["selected"], undefined, empty);
      assert.ok(result.ok && Array.isArray(result.value));
      assert.equal(result.value.length, 0);
      assert.equal(Object.hasOwn(result.value, 0), false);
    };
    const readSparse = () => assert.throws(() => extract(source, "ROOT", ["selected"], undefined, sparse), InputError);
    if (sparseFirst) { readSparse(); readEmpty(); } else { readEmpty(); readSparse(); }
    readEmpty();
    assert.throws(() => extract(source + " // cold", "ROOT", ["selected"], undefined, sparse), InputError);
  }
});
