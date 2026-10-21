/**
 * AN IN-MEMORY PROJECTION STORE (src/workflow/forge/projector/store.ts) for
 * the projector's tests: it keeps each object's git-owned fields, counts the
 * writes, and plays GitHub's failure modes on demand — a field it silently
 * does not keep (V-28), a refusal at the n-th write, an edit made by someone
 * else (V-27).
 */
import { BORN_FIELDS, FIELD_PHASES, type Fields, type Json, type ProjectionClass } from "../../src/workflow/forge/projector/model.ts";
import type { LiveObject, ProjectionStore, ProjectionWrite } from "../../src/workflow/forge/projector/store.ts";
import { HarnessError } from "../../src/kernel/errors.ts";

export type MemoryStoreOptions = Readonly<{
  /** A field the store accepts and silently does not keep (`issue.type`: GitHub drops `type` for a caller without the right). */
  drops?: readonly string[];
  /** Refuse the write with this index (0-based, counted over the store's life) with this error. */
  refuseAt?: Readonly<{ write: number; error: HarnessError }>;
}>;

export type MemoryStore = Readonly<{
  store: ProjectionStore;
  /** Every write the store received, in order. */
  writes: () => readonly ProjectionWrite[];
  /** The live object, or undefined. */
  get: (klass: ProjectionClass, key: string) => LiveObject | undefined;
  /** An edit by someone else: set `fields` directly (V-27). */
  edit: (klass: ProjectionClass, key: string, fields: Fields) => void;
  /** An object someone else created. */
  put: (object: LiveObject) => void;
}>;

export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const objects = new Map<string, LiveObject>();
  const received: ProjectionWrite[] = [];
  const kept = (klass: ProjectionClass, fields: Fields): Fields => Object.fromEntries(Object.entries(fields)
    .filter(([field]) => FIELD_PHASES[klass][field] !== undefined && !(options.drops ?? []).includes(`${klass}.${field}`)));
  const copy = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;
  const store: ProjectionStore = {
    read: async (classes) => [...objects.values()].filter((object) => classes.includes(object.class)).map((object) => ({ ...object, fields: copy(object.fields) as Fields })),
    write: async (write) => {
      const index = received.length;
      received.push(write);
      if (options.refuseAt?.write === index) throw options.refuseAt.error;
      const id = `${write.class}/${write.key}`;
      const current = objects.get(id);
      if (write.kind === "create") {
        if (current !== undefined) throw new HarnessError(`${id} already exists`, "memory_store_conflict");
        objects.set(id, { class: write.class, key: write.key, fields: { ...BORN_FIELDS[write.class], ...kept(write.class, write.fields) } });
        return;
      }
      if (current === undefined) throw new HarnessError(`${id} does not exist`, "memory_store_missing");
      objects.set(id, { ...current, fields: { ...current.fields, ...kept(write.class, write.fields) } });
    },
  };
  return {
    store,
    writes: () => [...received],
    get: (klass, key) => objects.get(`${klass}/${key}`),
    edit: (klass, key, fields) => {
      const current = objects.get(`${klass}/${key}`);
      if (current === undefined) throw new Error(`${klass}/${key} does not exist`);
      objects.set(`${klass}/${key}`, { ...current, fields: { ...current.fields, ...fields } });
    },
    put: (object) => { objects.set(`${object.class}/${object.key}`, object); },
  };
}
