/**
 * THE WEB STORAGE DOUBLE — a working `Storage` for the node test environment.
 *
 * The node project has no Web Storage, so a test that exercises a real
 * preference path must install one. The double has to honor the FULL contract
 * the app relies on: a write is visible to the very next read. A double that
 * accepts `setItem` and then answers `getItem` from nothing is not a browser
 * in a private window — it is a broken store that manufactures a refusal the
 * app would never see, and the failure lands in whichever owner started
 * confirming its writes.
 *
 * `RefusingStorage` is the opposite shape: a genuinely refusing browser, where
 * `setItem` throws (quota exceeded, private mode) and the already-stored value
 * is what a read returns. Callers use it to prove a refused write is reported
 * and the previous value is kept, rather than painted as saved.
 *
 * Both are keyed like the platform object: values are strings, `key(index)`
 * walks insertion order, and `clear()` empties the store.
 */

/** A `Storage` that round-trips every write, as a working browser does. */
export class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, String(value));
  }
}

/**
 * A `Storage` whose writes are refused the way a full or locked-down browser
 * refuses them: `setItem` throws, while reads still answer the stored state.
 */
export class RefusingStorage extends MemoryStorage {
  override setItem(key: string, value: string): never {
    void key;
    void value;
    throw new DOMException("the storage quota is exhausted", "QuotaExceededError");
  }
}
