// src/constants/creator.constants.ts
// Centralized creator route segments used across modules.

/** Base path for creator collection routes. */
export const BASE = '/creators';

/** Root segment for creator module routes. */
export const ROOT = '/';

/** Route segment for a single key's performance bond resource. */
export const KEY_BOND = '/keys/:key_id/bond';

/** Route segment for a key's bond forfeiture history resource. */
export const KEY_BOND_HISTORY = '/keys/:key_id/bond/history';

/** Cache TTL in seconds for bond state fetched from the get_bond_status contract call. */
export const BOND_STATUS_CACHE_TTL_SECONDS = 60;

/** Route segment for the performance bond status API endpoint. */
export const KEY_BOND_STATUS = '/keys/:key_id/bond/status';
