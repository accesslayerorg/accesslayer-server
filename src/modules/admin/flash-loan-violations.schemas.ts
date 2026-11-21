// src/modules/admin/flash-loan-violations.schemas.ts
// Query schema for GET /admin/flash-loan-violations (#938).

import { z } from 'zod';
import { safeBooleanQueryParam, safeIntParam } from '../../utils/query.utils';

export const FLASH_LOAN_VIOLATIONS_DEFAULT_LIMIT = 50;
export const FLASH_LOAN_VIOLATIONS_MAX_LIMIT = 100;
export const FLASH_LOAN_VIOLATIONS_DEFAULT_RECENT_LIMIT = 5;
export const FLASH_LOAN_VIOLATIONS_MAX_RECENT_LIMIT = 25;

export const flashLoanViolationsQuerySchema = z.object({
   limit: safeIntParam({
      defaultValue: FLASH_LOAN_VIOLATIONS_DEFAULT_LIMIT,
      min: 1,
      max: FLASH_LOAN_VIOLATIONS_MAX_LIMIT,
      label: 'Limit',
   }),

   offset: safeIntParam({
      defaultValue: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Offset',
   }),

   /** Include violations already cleared by the cooldown window. */
   include_cleared: safeBooleanQueryParam({
      paramName: 'include_cleared',
      defaultValue: false,
   }),

   /** Number of most recent violations embedded per wallet. */
   recent_limit: safeIntParam({
      defaultValue: FLASH_LOAN_VIOLATIONS_DEFAULT_RECENT_LIMIT,
      min: 0,
      max: FLASH_LOAN_VIOLATIONS_MAX_RECENT_LIMIT,
      label: 'Recent limit',
   }),
});

export type FlashLoanViolationsQuery = z.infer<
   typeof flashLoanViolationsQuerySchema
>;
