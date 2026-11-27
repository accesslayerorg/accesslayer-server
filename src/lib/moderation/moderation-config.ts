
// SPDX-License-Identifier: MIT

/**
 * Centralized configuration for the content moderation system.
 *
 * This module defines report limits, auto-hide thresholds, appeal rules,
 * and supported moderation actions/reasons.
 *
 * Keep moderation policy values centralized so services and controllers
 * don't maintain inconsistent hardcoded limits.
 */

/**
 * Reads a positive integer from an environment variable.
 *
 * Falls back to the default when the variable is missing or invalid.
 */
function readPositiveInteger(
  envValue: string | undefined,
  defaultValue: number,
): number {
  if (!envValue) {
    return defaultValue;
  }

  const parsed = Number(envValue);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

/**
 * Reads a non-negative integer from an environment variable.
 *
 * Falls back to the default when the variable is missing or invalid.
 */
export function readNonNegativeInteger(
  envValue: string | undefined,
  defaultValue: number,
): number {
  if (envValue === undefined || envValue.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(envValue);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}

/**
 * Number of unique reports required before content is automatically hidden
 * pending moderator review.
 *
 * Environment variable:
 * MODERATION_AUTO_HIDE_THRESHOLD
 *
 * @default 5
 */
const AUTO_HIDE_THRESHOLD = readPositiveInteger(
  process.env.MODERATION_AUTO_HIDE_THRESHOLD,
  5,
);

/**
 * Maximum number of content reports a wallet may submit per day.
 *
 * Environment variable:
 * MODERATION_REPORTS_PER_DAY_LIMIT
 *
 * @default 10
 */
const REPORTS_PER_DAY_LIMIT = readPositiveInteger(
  process.env.MODERATION_REPORTS_PER_DAY_LIMIT,
  10,
);

/**
 * Duration of the reporting limit window in milliseconds.
 *
 * Environment variable:
 * MODERATION_REPORT_WINDOW_MS
 *
 * @default 24 hours
 */
const REPORT_WINDOW_MS = readPositiveInteger(
  process.env.MODERATION_REPORT_WINDOW_MS,
  24 * 60 * 60 * 1000,
);

/**
 * Maximum time after removal that an author may submit an appeal.
 *
 * Environment variable:
 * MODERATION_APPEAL_WINDOW_DAYS
 *
 * @default 7 days
 */
const APPEAL_WINDOW_DAYS = readPositiveInteger(
  process.env.MODERATION_APPEAL_WINDOW_DAYS,
  7,
);

/**
 * Whether content is automatically hidden when the unique report threshold
 * is reached.
 *
 * Environment variable:
 * MODERATION_AUTO_HIDE_ENABLED
 *
 * @default true
 */
const AUTO_HIDE_ENABLED =
  process.env.MODERATION_AUTO_HIDE_ENABLED !== "false";

/**
 * Whether content authors are allowed to appeal moderation removals.
 *
 * Environment variable:
 * MODERATION_APPEALS_ENABLED
 *
 * @default true
 */
const APPEALS_ENABLED =
  process.env.MODERATION_APPEALS_ENABLED !== "false";

/**
 * Moderation report reasons.
 *
 * These values are API-facing identifiers. Avoid changing them without
 * considering API compatibility.
 */
export const CONTENT_REPORT_REASONS = [
  "HARASSMENT",
  "HATE_SPEECH",
  "SPAM",
  "MISINFORMATION",
  "INAPPROPRIATE_CONTENT",
  "THREATS",
  "COPYRIGHT",
  "OTHER",
] as const;

export type ContentReportReason =
  (typeof CONTENT_REPORT_REASONS)[number];

/**
 * Content types that can be reported.
 */
export const REPORTABLE_CONTENT_TYPES = [
  "COMMENT",
  "ANNOUNCEMENT",
] as const;

export type ReportableContentType =
  (typeof REPORTABLE_CONTENT_TYPES)[number];

/**
 * Moderator actions available when reviewing reported content.
 */
export const MODERATION_ACTIONS = [
  "REMOVE",
  "RESTORE",
  "WARN",
  "DISMISS",
] as const;

export type ModerationActionType =
  (typeof MODERATION_ACTIONS)[number];

/**
 * Appeal decision outcomes.
 */
export const APPEAL_DECISIONS = [
  "UPHOLD",
  "OVERTURN",
] as const;

export type AppealDecisionType =
  (typeof APPEAL_DECISIONS)[number];

/**
 * Moderation policy configuration.
 */
export const MODERATION_CONFIG = Object.freeze({
  reports: Object.freeze({
    /** Required number of unique reports to trigger auto-hide. */
    autoHideThreshold: AUTO_HIDE_THRESHOLD,

    /** Maximum reports per wallet within the configured window. */
    dailyLimit: REPORTS_PER_DAY_LIMIT,

    /** Report rate-limit window in milliseconds. */
    windowMs: REPORT_WINDOW_MS,

    /** Automatically hide reported content pending review. */
    autoHideEnabled: AUTO_HIDE_ENABLED,
  }),

  appeals: Object.freeze({
    /** Allow authors to appeal content removals. */
    enabled: APPEALS_ENABLED,

    /** Appeal deadline in days following the removal. */
    windowDays: APPEAL_WINDOW_DAYS,

    /** One appeal permitted per removal action. */
    maxAppealsPerRemoval: 1,

    /** Original removal reviewer cannot decide the appeal. */
    requireIndependentReviewer: true,
  }),

  content: Object.freeze({
    /** Content types supported by the reporting system. */
    reportableTypes: REPORTABLE_CONTENT_TYPES,

    /** Valid report reasons. */
    reportReasons: CONTENT_REPORT_REASONS,
  }),

  moderation: Object.freeze({
    /** Supported moderator actions. */
    actions: MODERATION_ACTIONS,

    /** Supported appeal outcomes. */
    appealDecisions: APPEAL_DECISIONS,

    /** Moderation decisions must include an audit record. */
    requireAuditLog: true,

    /** Moderator notes are required for decisions. */
    requireDecisionNote: true,
  }),
});

/**
 * Returns the auto-hide threshold.
 */
export function getAutoHideThreshold(): number {
  return MODERATION_CONFIG.reports.autoHideThreshold;
}

/**
 * Returns the maximum reports allowed within the rate-limit window.
 */
export function getReportLimit(): number {
  return MODERATION_CONFIG.reports.dailyLimit;
}

/**
 * Returns the report rate-limit window in milliseconds.
 */
export function getReportWindowMs(): number {
  return MODERATION_CONFIG.reports.windowMs;
}

/**
 * Returns the appeal window in milliseconds.
 */
export function getAppealWindowMs(): number {
  return MODERATION_CONFIG.appeals.windowDays * 24 * 60 * 60 * 1000;
}

/**
 * Checks whether a report reason is supported.
 */
export function isValidReportReason(
  reason: string,
): reason is ContentReportReason {
  return (CONTENT_REPORT_REASONS as readonly string[]).includes(reason);
}

/**
 * Checks whether a content type is reportable.
 */
export function isReportableContentType(
  contentType: string,
): contentType is ReportableContentType {
  return (REPORTABLE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * Checks whether a moderator action is supported.
 */
export function isValidModerationAction(
  action: string,
): action is ModerationActionType {
  return (MODERATION_ACTIONS as readonly string[]).includes(action);
}

/**
 * Checks whether an appeal decision is supported.
 */
export function isValidAppealDecision(
  decision: string,
): decision is AppealDecisionType {
  return (APPEAL_DECISIONS as readonly string[]).includes(decision);
}
