// IndexedDB cache in the service worker, db 'autodub', stores 'lines' + 'audio' (LRU 200 MB) (§7). Owner: B.
// Falls back to an in-memory map when IndexedDB is unavailable (tests, broken profile).
import type { CacheStore } from '../shared/types';

export const DB_NAME = 'autodub';
export const DB_VERSION = 1;
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
const STORES: readonly CacheStore[] = ['lines', 'audio'];

interface Rec { key: string; val: unknown; size: number; at: number }

let dbPromise: Promise<IDBDatabase | null> | null = null;
const mem = new Map<CacheStore, Map<string, Rec>>(STORES.map((s) => [s, new Map()]));
let audioBytes: number | null = null;
let lastAt = 0;
let maxBytes = CACHE_MAX_BYTES;

const stamp = (): number => (lastAt = Math.max(Date.now(), lastAt + 1));

function sizeOf(val: unknown): number {
  if (val && typeof val === 'object' && typeof (val as { audioB64?: unknown }).audioB64 === 'string') {
    return (val as { audioB64: string }).audioB64.length + 64;
  }
  try {
    return (JSON.stringify(val) ?? '').length * 2;
  } catch {
    return 1024;
  }
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'key' }).createIndex('at', 'at');
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Read a value (and refresh its LRU timestamp); undefined if missing or on error. */
export async function cacheGet<T>(store: CacheStore, key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    if (!db) {
      const rec = mem.get(store)?.get(key);
      if (rec) rec.at = stamp();
      return rec?.val as T | undefined;
    }
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const rec = (await req(os.get(key))) as Rec | undefined;
    if (rec) os.put({ ...rec, at: stamp() });
    await txDone(tx);
    return rec?.val as T | undefined;
  } catch {
    return undefined;
  }
}

/** Write a value (updates LRU timestamp); may trigger eviction of old 'audio' entries. */
export async function cachePut(store: CacheStore, key: string, val: unknown): Promise<void> {
  const rec: Rec = { key, val, size: sizeOf(val), at: stamp() };
  const db = await openDb();
  if (!db) {
    mem.get(store)!.set(key, rec);
  } else {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    await txDone(tx);
  }
  if (store !== 'audio') return;
  if (audioBytes === null) await cacheEvict(maxBytes);
  else {
    audioBytes += rec.size;
    if (audioBytes > maxBytes) await cacheEvict(maxBytes);
  }
}

/** Evict least-recently-used 'audio' entries until total ≤ `limit` (default 200 MB). Returns nothing; never throws. */
export async function cacheEvict(limit: number = maxBytes): Promise<void> {
  try {
    const db = await openDb();
    if (!db) {
      const m = mem.get('audio')!;
      let total = 0;
      for (const r of m.values()) total += r.size;
      for (const r of [...m.values()].sort((a, b) => a.at - b.at)) {
        if (total <= limit) break;
        m.delete(r.key);
        total -= r.size;
      }
      audioBytes = total;
      return;
    }
    // Pass 1: total size.
    let total = 0;
    {
      const tx = db.transaction('audio', 'readonly');
      await new Promise<void>((resolve, reject) => {
        const c = tx.objectStore('audio').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return resolve();
          total += (cur.value as Rec).size || 0;
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      await txDone(tx);
    }
    // Pass 2: delete oldest first.
    if (total > limit) {
      const tx = db.transaction('audio', 'readwrite');
      await new Promise<void>((resolve, reject) => {
        const c = tx.objectStore('audio').index('at').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || total <= limit) return resolve();
          total -= (cur.value as Rec).size || 0;
          cur.delete();
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      await txDone(tx);
    }
    audioBytes = total;
  } catch {
    audioBytes = null;
  }
}

/** Test helper: close the DB, forget state, optionally set the size cap. */
export function _resetCacheForTests(capBytes: number = CACHE_MAX_BYTES): void {
  void dbPromise?.then((db) => db?.close());
  dbPromise = null;
  for (const m of mem.values()) m.clear();
  audioBytes = null;
  maxBytes = capBytes;
}
