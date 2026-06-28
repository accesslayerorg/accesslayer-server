import { decodeCursor, CursorChecksumError } from './cursor.utils';

/**
 * Decodes a pagination cursor into a human-readable key-value map for debug
 * logging. Returns `null` when the cursor cannot be decoded (tampered, malformed,
 * or wrong type) so callers can safely skip the log entry.
 *
 * IMPORTANT: call this helper only on `logger.debug(...)` paths. Never use it
 * in info-level or higher log entries — cursors may carry internal pagination
 * anchors that should not appear in production log streams.
 *
 * @param raw - Raw cursor string from a query parameter or request body
 * @returns A flat key-value record suitable for structured logging, or `null`
 *
 * @example
 * logger.debug({ cursor: formatCursorForDebug(raw), msg: 'Processing cursor' });
 */
export function formatCursorForDebug(raw: unknown): Record<string, string> | null {
    if (typeof raw !== 'string' || raw === '') {
        return null;
    }

    try {
        const payload = decodeCursor<Record<string, unknown>>(raw);

        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            return null;
        }

        return Object.fromEntries(
            Object.entries(payload).map(([key, value]) => [
                key,
                value === null || value === undefined ? '' : String(value),
            ]),
        );
    } catch (err) {
        if (err instanceof CursorChecksumError) {
            return null;
        }
        return null;
    }
}
