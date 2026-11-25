import { z } from 'zod';

export const SCREENER_METRICS = [
   'price',
   'change',
   'volume',
   'holders',
   'top10_share',
] as const;

export type ScreenerMetric = (typeof SCREENER_METRICS)[number];

export const SCREENER_OPERATORS = [
   'eq',
   'neq',
   'gt',
   'gte',
   'lt',
   'lte',
   'between',
] as const;

export type ScreenerOperator = (typeof SCREENER_OPERATORS)[number];

export const MAX_SCREENER_RULES = 10;
export const MAX_SAVED_SCREENS_PER_USER = 20;
export const SCREENER_DEFAULT_LIMIT = 20;
export const SCREENER_MAX_LIMIT = 100;

const finiteNumberSchema = z.number().finite();

export const screenerRuleSchema = z
   .object({
      metric: z.enum(SCREENER_METRICS),
      operator: z.enum(SCREENER_OPERATORS),
      value: z.union([
         finiteNumberSchema,
         z.tuple([finiteNumberSchema, finiteNumberSchema]),
      ]),
   })
   .strict()
   .superRefine((rule, ctx) => {
      if (rule.operator === 'between') {
         if (!Array.isArray(rule.value)) {
            ctx.addIssue({
               code: z.ZodIssueCode.custom,
               path: ['value'],
               message: 'between operator requires a [min, max] tuple',
            });
            return;
         }
         if (rule.value[0] > rule.value[1]) {
            ctx.addIssue({
               code: z.ZodIssueCode.custom,
               path: ['value'],
               message: 'between range minimum must not exceed maximum',
            });
         }
      } else if (Array.isArray(rule.value)) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: `${rule.operator} operator requires a single numeric value`,
         });
      }
   });

export type ScreenerRule = z.infer<typeof screenerRuleSchema>;

export const screenerSortSchema = z
   .object({
      metric: z.enum(SCREENER_METRICS).default('volume'),
      direction: z.enum(['asc', 'desc']).default('desc'),
   })
   .strict();

export type ScreenerSort = z.infer<typeof screenerSortSchema>;

export const screenerRunSchema = z
   .object({
      rules: z
         .array(screenerRuleSchema)
         .max(MAX_SCREENER_RULES, `At most ${MAX_SCREENER_RULES} rules are allowed per request`)
         .default([]),
      sort: screenerSortSchema.default({ metric: 'volume', direction: 'desc' }),
      cursor: z.string().min(1).optional(),
      limit: z
         .number()
         .int()
         .min(1)
         .max(SCREENER_MAX_LIMIT)
         .default(SCREENER_DEFAULT_LIMIT),
   })
   .strict();

export type ScreenerRunInput = z.infer<typeof screenerRunSchema>;

export const createSavedScreenSchema = z
   .object({
      name: z.string().trim().min(1).max(80),
      rules: z
         .array(screenerRuleSchema)
         .max(MAX_SCREENER_RULES, `At most ${MAX_SCREENER_RULES} rules are allowed per screen`),
      sort: screenerSortSchema.optional(),
   })
   .strict();

export type CreateSavedScreenInput = z.infer<typeof createSavedScreenSchema>;

export class ContradictoryRulesError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'ContradictoryRulesError';
   }
}

interface MetricBounds {
   lower?: { value: number; inclusive: boolean };
   upper?: { value: number; inclusive: boolean };
   equals: Set<number>;
   notEquals: Set<number>;
}

function tightenLower(
   bounds: MetricBounds,
   value: number,
   inclusive: boolean
): void {
   if (
      !bounds.lower ||
      value > bounds.lower.value ||
      (value === bounds.lower.value && !inclusive)
   ) {
      bounds.lower = { value, inclusive };
   }
}

function tightenUpper(
   bounds: MetricBounds,
   value: number,
   inclusive: boolean
): void {
   if (
      !bounds.upper ||
      value < bounds.upper.value ||
      (value === bounds.upper.value && !inclusive)
   ) {
      bounds.upper = { value, inclusive };
   }
}

/**
 * Validates that no two rules on the same metric contradict each other.
 * Throws {@link ContradictoryRulesError} with a descriptive message.
 */
export function validateRuleConsistency(rules: ScreenerRule[]): void {
   const byMetric = new Map<ScreenerMetric, MetricBounds>();

   for (const rule of rules) {
      let bounds = byMetric.get(rule.metric);
      if (!bounds) {
         bounds = { equals: new Set(), notEquals: new Set() };
         byMetric.set(rule.metric, bounds);
      }

      switch (rule.operator) {
         case 'eq':
            bounds.equals.add(rule.value as number);
            break;
         case 'neq':
            bounds.notEquals.add(rule.value as number);
            break;
         case 'gt':
            tightenLower(bounds, rule.value as number, false);
            break;
         case 'gte':
            tightenLower(bounds, rule.value as number, true);
            break;
         case 'lt':
            tightenUpper(bounds, rule.value as number, false);
            break;
         case 'lte':
            tightenUpper(bounds, rule.value as number, true);
            break;
         case 'between': {
            const [min, max] = rule.value as [number, number];
            tightenLower(bounds, min, true);
            tightenUpper(bounds, max, true);
            break;
         }
      }
   }

   for (const [metric, bounds] of byMetric.entries()) {
      if (bounds.equals.size > 1) {
         const vals = Array.from(bounds.equals).join(' and ');
         throw new ContradictoryRulesError(
            `Contradictory rules for "${metric}": cannot equal both ${vals}`
         );
      }

      if (bounds.lower && bounds.upper) {
         const { value: lo, inclusive: loInc } = bounds.lower;
         const { value: hi, inclusive: hiInc } = bounds.upper;
         if (lo > hi || (lo === hi && (!loInc || !hiInc))) {
            throw new ContradictoryRulesError(
               `Contradictory rules for "${metric}": lower bound (${loInc ? '>=' : '>'} ${lo}) conflicts with upper bound (${hiInc ? '<=' : '<'} ${hi})`
            );
         }
      }

      for (const eqVal of bounds.equals) {
         if (bounds.notEquals.has(eqVal)) {
            throw new ContradictoryRulesError(
               `Contradictory rules for "${metric}": cannot be both eq ${eqVal} and neq ${eqVal}`
            );
         }
         if (bounds.lower) {
            const { value: lo, inclusive } = bounds.lower;
            if (eqVal < lo || (eqVal === lo && !inclusive)) {
               throw new ContradictoryRulesError(
                  `Contradictory rules for "${metric}": eq ${eqVal} conflicts with ${inclusive ? '>=' : '>'} ${lo}`
               );
            }
         }
         if (bounds.upper) {
            const { value: hi, inclusive } = bounds.upper;
            if (eqVal > hi || (eqVal === hi && !inclusive)) {
               throw new ContradictoryRulesError(
                  `Contradictory rules for "${metric}": eq ${eqVal} conflicts with ${inclusive ? '<=' : '<'} ${hi}`
               );
            }
         }
      }
   }
}
