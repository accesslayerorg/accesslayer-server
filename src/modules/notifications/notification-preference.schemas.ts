// src/modules/notifications/notification-preference.schemas.ts
// Validation schemas for notification preferences (#1217).

import { z } from 'zod';
import type { ActivityType } from '@prisma/client';

export const REAL_ACTIVITY_TYPES: readonly [ActivityType, ...ActivityType[]] = [
   'CREATOR_REGISTERED',
   'KEY_BOUGHT',
   'KEY_SOLD',
   'PROFILE_UPDATED',
   'DIVIDEND_DISTRIBUTED',
   'DIVIDEND_CLAIMED',
   'KEYS_CLAIMED',
   'KEY_BURNED',
   'KEY_TRANSFERRED',
   'KEY_TRANSFERRED_IN',
   'KEY_TRANSFERRED_OUT',
   'SUPPLY_CAP_SET',
   'TRADING_PAUSE_PROPOSED',
   'TRADING_PAUSE_APPROVED',
   'GOVERNANCE_PROPOSAL_CREATED',
   'GOVERNANCE_VOTE_CAST',
   'GOVERNANCE_DELEGATION_SET',
   'GOVERNANCE_DELEGATION_REVOKED',
   'TIMELOCK_LOCKUP_PROPOSED',
   'CIRCUIT_BREAKER_THRESHOLD_UPDATED',
   'GRADUATED_CURVE_CONFIGURED',
   'KEY_DEPRECATED',
   'SUPPLY_FULLY_FUNDED',
   'MILESTONE_CROSSED',
] as const;

export type RealActivityType = (typeof REAL_ACTIVITY_TYPES)[number];

export const NotificationFrequencySchema = z.enum(['daily', 'weekly']);

export const UpdateNotificationPreferencesSchema = z.object({
   email: z.string().trim().email('Invalid email address format'),
   frequency: NotificationFrequencySchema,
   events: z
      .array(z.enum(REAL_ACTIVITY_TYPES))
      .min(1, 'At least one event type must be selected'),
});

export type UpdateNotificationPreferencesInput = z.infer<
   typeof UpdateNotificationPreferencesSchema
>;
