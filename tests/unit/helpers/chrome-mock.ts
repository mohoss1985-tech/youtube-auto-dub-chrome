// Minimal in-memory chrome.* mock for unit tests (Wave 0, shared; request changes via research/wave1-<L>.md).
import { vi } from 'vitest';

type Listener = (...args: any[]) => any;

function event() {
  const ls = new Set<Listener>();
  return {
    addListener: (l: Listener) => void ls.add(l),
    removeListener: (l: Listener) => void ls.delete(l),
    hasListener: (l: Listener) => ls.has(l),
    _fire: (...a: unknown[]) => [...ls].map((l) => l(...a)),
    _listeners: ls,
  };
}

/** Install `globalThis.chrome` with storage.local (+onChanged), runtime, tabs, commands, permissions. Returns it. */
export function installChromeMock(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const onChanged = event();
  const local = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return structuredClone(data);
      const ks = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      onChanged._fire(changes, 'local');
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    clear: vi.fn(async () => {
      for (const k of Object.keys(data)) delete data[k];
    }),
  };
  const chromeMock = {
    storage: { local, onChanged },
    runtime: {
      id: 'test-extension-id',
      lastError: undefined as undefined | { message: string },
      sendMessage: vi.fn(async (_msg: unknown) => undefined as unknown),
      onMessage: event(),
      getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
    },
    tabs: {
      query: vi.fn(async (_q: unknown) => [] as { id?: number; url?: string }[]),
      sendMessage: vi.fn(async (_id: number, _msg: unknown) => undefined as unknown),
    },
    commands: { onCommand: event() },
    permissions: {
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      contains: vi.fn(async () => false),
    },
    _data: data,
  };
  (globalThis as any).chrome = chromeMock;
  return chromeMock;
}
