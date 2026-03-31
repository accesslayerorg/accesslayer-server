export type PageGuardOptions = {
   min?: number;
   max?: number;
   default?: number;
};

/**
 * Normalize page query values into a safe integer within configured bounds.
 * Always normalizes — never rejects or performs side effects.
 */
export const normalizeCreatorListPage = (
   page: unknown,
   options: PageGuardOptions = {}
): number => {
   const min = options.min ?? 1;
   const max = options.max ?? 100;
   const fallback = options.default ?? 1;

   const parsed = Number(page);

   if (!Number.isInteger(parsed)) return fallback;
   if (parsed < min) return min;
   if (parsed > max) return max;

   return parsed;
};
