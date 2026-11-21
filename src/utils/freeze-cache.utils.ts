type Entry = { value: any; expiresAt: number };
const cache = new Map<string, Entry>();
const TTL_MS = 30_000;
const k = (x: string) => `freeze:${x}`;
export function getCachedFreezeStatus(key: string) {
  const e = cache.get(k(key));
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { cache.delete(k(key)); return null; }
  return e.value;
}
export function setCachedFreezeStatus(key: string, v: any) { cache.set(k(key), { value: v, expiresAt: Date.now() + TTL_MS }); }
export function invalidateFreezeCache(key: string) { cache.delete(k(key)); }
export function resetFreezeCache() { cache.clear(); }
