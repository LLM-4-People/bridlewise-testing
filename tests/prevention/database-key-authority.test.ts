// @vitest-environment node
import { expect, test } from "vitest";
import { join } from "node:path";
import { nativeModuleUrl as url, runNativeScript } from "../helpers/native-script.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

function native(source: string) {
  const result = runNativeScript(source);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

for (const source of ["memory", "file", "passphrase"] as const) {
  test(`web bootstrap shares the admitted ${source} capability with database, memory and timeline`, () => {
    const dir = createTempDir("shared-web-key-");
    const result = native(`
      import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
      process.env.HARNESS_WEB_DB_PATH=${JSON.stringify(source === "memory" ? ":memory:" : join(dir, "web.db"))};
      process.env.HARNESS_WEB_TIMELINE_DB_PATH=${JSON.stringify(join(dir, "timeline.db"))};
      process.env.HARNESS_WEB_DB_KEY=${JSON.stringify(source === "passphrase" ? "unchanged passphrase input" : "")};
      const {getOrCreateDb}=await import(${url("db/index.ts")});
      const {getDatabaseKey}=await import(${url("db/bootstrap-key.ts")});
      const {createDbCryptoFromKey,memoryBinding}=await import(${url("db/db-crypto.ts")});
      const db=getOrCreateDb(); const admitted=getDatabaseKey(); const crypto=createDbCryptoFromKey(admitted);
      const project=db.createProject({name:'kept key',path:'/kept-key'},'owner');
      if(admitted.filePath)fs.writeFileSync(admitted.filePath,Buffer.alloc(32,71));
      const {getTimelineStore}=await import(${url("observability/timeline-bridge.ts")});
      const {createTimelineStore}=await import(${url("timeline/timeline-store.ts")});
      const {storeProvenance,getMemoryEntry}=await import(${url("context/memory-bridge.ts")});
      const store=getTimelineStore();let reopened;
      try {
        const id=storeProvenance('one admitted memory key',{source:'manual',userId:'owner'});
        assert.equal(getMemoryEntry(id,'owner').content,'one admitted memory key');
        const rows=store.query({eventTypes:['memory'],limit:100});
        const encrypted=rows.flatMap(e=>e.documents).flatMap(d=>{if(d.contentJson===null)return[];try{return[JSON.parse(d.contentJson)];}catch{return[];}});
        // Bound to its owner and seal (never unbound): the same capability opens it.
        const sealed=(d)=>crypto.decryptField(d.content,memoryBinding(d.metadata.userId,d.metadata.sealId));
        assert.ok(encrypted.some(d=>typeof d.content==='string'&&d.metadata?.sealId!==undefined&&sealed(d)==='one admitted memory key'));
        reopened=createTimelineStore({path:${JSON.stringify(join(dir, "timeline.db"))},ledgerId:store.ledgerId,key:admitted.key});
        assert.equal(reopened.verifyChain().valid,true);
        const {createMemoryStore}=await import(${url("memory/memory-store.ts")});
        const cold=createMemoryStore({store:reopened});
        assert.equal(sealed(cold.get(id)),'one admitted memory key');
        assert.equal(getDatabaseKey(),admitted);
        assert.throws(()=>getDatabaseKey({dbPath:'/different-owner',passphrase:'different'}),{code:'database_key_owner_conflict'});
        assert.equal(db.listProjects('owner')[0].id,project.id);
        console.log(JSON.stringify({sameCapability:true,memory:true,timeline:true,persisted:admitted.persisted}));
      }finally{reopened?.close();store.close();db.close();}
    `);
    expect(result).toEqual({ sameCapability: true, memory: true, timeline: true, persisted: source !== "memory" });
  });
}

test("native writer and reader workers clone the admitted key without re-reading a replaced source", () => {
  const dir = createTempDir("worker-admitted-key-");
  const result = native(`
    import assert from 'node:assert/strict';import fs from 'node:fs';
    const{resolvePersistedKey}=await import(${url("filesystem/persisted-key.ts")});
    const{ThreadBackend}=await import(${url("db/thread-backend.ts")});
    const{DbClient}=await import(${url("db/client.ts")});
    const{SCHEMA_VERSION_LATEST}=await import(${url("db/schema.ts")});
    const{createDbCryptoFromKey}=await import(${url("db/db-crypto.ts")});
    const path=${JSON.stringify(join(dir, "web.db"))};
    const admittedKey=resolvePersistedKey({dbPath:path,disposition:'create-or-load'});
    // Replace the key file itself after admission: the workers must use the admitted capability, never re-read the source.
    assert.equal(typeof admittedKey.filePath,'string');fs.writeFileSync(admittedKey.filePath,Buffer.alloc(32,91));
    const backend=await ThreadBackend.open({path,admittedKey,readers:1,durabilityWindowMs:0});
    try{
      const project=await backend.call('createProject',[{name:'worker-secret',path:'/worker-secret'},'owner']);
      const listed=await backend.call('listProjects',['owner']);assert.equal(listed[0].name,'worker-secret');
      const reader=new DbClient({path,readOnly:true,crypto:createDbCryptoFromKey(admittedKey)});
      try{assert.equal(reader.listProjects('owner')[0].name,'worker-secret');assert.equal(reader.schemaVersion,SCHEMA_VERSION_LATEST);}finally{reader.close();}
      console.log(JSON.stringify({writer:true,reader:true,originalKey:true}));
    }finally{await backend.close();}
  `);
  expect(result).toEqual({ writer: true, reader: true, originalKey: true });
});
