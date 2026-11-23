// IndexedDB cache in the service worker, db 'autodub', stores 'lines' + 'audio' (LRU 200 MB) (§7). Owner: B.
import type { CacheStore } from '../shared/types';

/** Read a value; undefined if missing or on error. */
export async function cacheGet<T>(store: CacheStore, key: string): Promise<T | undefined> {
  void store; void key;
  return undefined; // TODO B
}

/** Write a value (updates LRU timestamp); may trigger eviction. */
export async function cachePut(store: CacheStore, key: string, val: unknown): Promise<void> {
  void store; void key; void val;
  // TODO B
}

/** Evict oldest 'audio' entries until total ≤ 200 MB. */
export async function cacheEvict(): Promise<void> {
  // TODO B
}
