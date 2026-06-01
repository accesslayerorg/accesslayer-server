// src/utils/creator-feed-cursor.utils.ts
// Decode and validate creator feed cursors in one place.
// All feed endpoint paths should use decodeCreatorFeedCursor instead of
// calling decodeCursor directly, so parse errors are consistent.

import { decodeCursor, CursorChecksumError } from './cursor.utils';

/**
 * Shape of a decoded creator feed cursor payload.
 */
export interface CreatorFeedCursorPayload {
  /** ISO timestamp used as the pagination anchor */
  createdAt: string;
  /** Tiebreaker ID for stable ordering */
  id: string;
}

export type CreatorFeedCursorResult =
  | { ok: true; payload: CreatorFeedCursorPayload }
  | { ok: false; error: string };

/**
 * Decode and validate a creator feed cursor string.
 *
 * Returns a discriminated union so callers can handle parse errors
 * without catching exceptions.
 *
 * @param raw - Raw cursor string from query params
 * @returns `{ ok: true, payload }` or `{ ok: false, error }`
 *
 * @example
 * const result = decodeCreatorFeedCursor(req.query.cursor);
 * if (!result.ok) return sendValidationError(res, result.error);
 */
export function decodeCreatorFeedCursor(raw: unknown): CreatorFeedCursorResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: 'Cursor is required' };
  }

  if (typeof raw !== 'string') {
    return { ok: false, error: 'Cursor must be a string' };
  }

  let payload: CreatorFeedCursorPayload;
  try {
    payload = decodeCursor<CreatorFeedCursorPayload>(raw);
  } catch (err) {
    const message =
      err instanceof CursorChecksumError ? err.message : 'Invalid cursor';
    return { ok: false, error: message };
  }

  if (
    typeof payload.createdAt !== 'string' ||
    typeof payload.id !== 'string' ||
    !payload.createdAt ||
    !payload.id
  ) {
    return { ok: false, error: 'Cursor payload is missing required fields' };
  }

  return { ok: true, payload };
}
