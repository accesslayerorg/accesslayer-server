// src/modules/account/account.constants.ts
// Timing and status constants for the data export and account deletion
// workflow (#1325).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Days between a deletion request and anonymization; cancellable until then. */
export const DELETION_GRACE_PERIOD_MS = 14 * DAY_MS;

/** How long a completed export's download link (and archive) stays available. */
export const DATA_EXPORT_LINK_TTL_MS = DAY_MS;

/** Purpose string bound into export download signatures. */
export const DATA_EXPORT_PURPOSE = 'data-export-download';

/** A `processing` export older than this is assumed abandoned and re-queued. */
export const DATA_EXPORT_STALE_PROCESSING_MS = 15 * 60 * 1000;

/** Interval for the account lifecycle worker. */
export const ACCOUNT_LIFECYCLE_TICK_MS = 60 * 1000;

/** Limit-order statuses that still represent an outstanding obligation. */
export const OPEN_LIMIT_ORDER_STATUSES = ['OPEN', 'EXECUTABLE'] as const;
