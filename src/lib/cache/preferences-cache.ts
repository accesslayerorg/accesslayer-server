
// SPDX-License-Identifier: MIT

/**
 * In-memory cache for user preferences.
 *
 * Cache entries are scoped by wallet identity and expire after a configurable TTL.
 * This cache is intended to reduce repeated database reads for user preferences.
 *
 * Notes:
 * - The cache is process-local; it is not shared across multiple server instances.
 * - Wallet identifiers are trimmed but not lowercased because wallet identifiers
 *   may be case-sensitive.
 * - Expired entries are removed lazily on access and during writes.
 * - No background timers are used, keeping this implementation simple and
 *   test-friendly.
 */

export interface PreferencesCacheOptions {
  /** Cache entry lifetime in milliseconds. @default 5 minutes */
  ttlMs?: number;

  /** Maximum number of wallet entries to store. @default 1000 */
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Default cache lifetime: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Default maximum cache size. */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Wallet-scoped preferences cache.
 *
 * Uses Map insertion order to support simple LRU-style eviction:
 * recently accessed entries are moved to the end of the Map.
 *
 * Example:
 * ```ts
 * const cache = new PreferencesCache<UserPreferences>();
 *
 * cache.set(walletAddress, preferences);
 *
 * const cached = cache.get(walletAddress);
 *
 * cache.invalidate(walletAddress);
 * ```
 */
export class PreferencesCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: PreferencesCacheOptions = {}) {
    const { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } =
      options;

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("PreferencesCache ttlMs must be a positive number.");
    }

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("PreferencesCache maxEntries must be a positive integer.");
    }

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Retrieves cached preferences for a wallet.
   *
   * Returns undefined when no entry exists or the entry has expired.
   * Successful reads refresh the entry's LRU position but do not extend TTL.
   */
  get(wallet: string): T | undefined {
    const key = this.normalizeWallet(wallet);
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh LRU position without extending the expiration time.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  /**
   * Stores preferences for a wallet.
   *
   * Replacing an existing entry refreshes its TTL and LRU position.
   * Expired entries are cleaned up before capacity is evaluated.
   */
  set(wallet: string, value: T): void {
    const key = this.normalizeWallet(wallet);

    this.removeExpiredEntries();

    // Replace existing entry to refresh insertion order.
    this.entries.delete(key);

    // Evict the least recently used entry if capacity is reached.
    if (this.entries.size >= this.maxEntries) {
      this.evictOldestEntry();
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Invalidates the cached preferences for a specific wallet.
   *
   * Should be called after a successful preferences update.
   */
  invalidate(wallet: string): void {
    const key = this.normalizeWallet(wallet);
    this.entries.delete(key);
  }

  /**
   * Clears all cached preferences.
   *
   * Useful for testing, administrative operations, and cache resets.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Returns the current number of stored entries, including entries that may
   * have expired but have not yet been lazily removed.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Removes expired entries from the cache.
   *
   * Returns the number of entries removed.
   */
  prune(): number {
    return this.removeExpiredEntries();
  }

  /**
   * Returns the configured TTL in milliseconds.
   */
  get ttl(): number {
    return this.ttlMs;
  }

  /**
   * Returns the configured maximum entry count.
   */
  get capacity(): number {
    return this.maxEntries;
  }

  private normalizeWallet(wallet: string): string {
    if (typeof wallet !== "string" || wallet.trim().length === 0) {
      throw new Error("Wallet identifier must be a non-empty string.");
    }

    return wallet.trim();
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() >= entry.expiresAt;
  }

  /**
   * Removes expired cache entries.
   *
   * @returns Number of entries removed.
   */
  private removeExpiredEntries(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Evicts the oldest entry (least recently used).
   *
   * Map iteration order is insertion order. Since successful reads move entries
   * to the end of the Map, the first entry is the least recently used.
   */
  private evictOldestEntry(): void {
    const oldestKey = this.entries.keys().next().value;

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * Shared preferences cache instance.
 *
 * Use this singleton in the preferences service when a process-wide cache
 * is desired.
 */
export const preferencesCache = new PreferencesCache<unknown>({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
});
