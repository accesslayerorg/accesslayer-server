// src/modules/keys/key-milestones.service.ts

export interface Milestone {
   tier: number;
   threshold: number;
}

const DEFAULT_MILESTONES: Milestone[] = [
   { tier: 1, threshold: 10 },
   { tier: 2, threshold: 100 },
   { tier: 3, threshold: 1000 },
   { tier: 4, threshold: 10000 },
];

function normalizeMilestones(raw: unknown): Milestone[] {
   if (!Array.isArray(raw)) {
      return DEFAULT_MILESTONES;
   }

   const milestones: Milestone[] = [];

   for (const entry of raw) {
      if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) {
         milestones.push({ tier: 0, threshold: entry });
         continue;
      }

      if (
         entry &&
         typeof entry === 'object' &&
         'threshold' in entry &&
         typeof (entry as { threshold?: unknown }).threshold === 'number' &&
         Number.isFinite((entry as { threshold: number }).threshold) &&
         (entry as { threshold: number }).threshold >= 0
      ) {
         milestones.push({
            tier:
               'tier' in entry &&
               typeof (entry as { tier?: unknown }).tier === 'number'
                  ? Number((entry as { tier: number }).tier)
                  : 0,
            threshold: (entry as { threshold: number }).threshold,
         });
      }
   }

   if (milestones.length === 0) {
      return DEFAULT_MILESTONES;
   }

   return milestones
      .map((milestone, index) => ({
         threshold: milestone.threshold,
         tier: milestone.tier > 0 ? milestone.tier : index + 1,
      }))
      .sort((a, b) => a.threshold - b.threshold);
}

function readConfiguredMilestones(): Milestone[] {
   const candidateSources = [
      (globalThis as { __ACCESSLAYER_CONTRACT_METADATA__?: unknown })
         .__ACCESSLAYER_CONTRACT_METADATA__,
      (globalThis as { contractMetadata?: unknown }).contractMetadata,
      process.env.KEY_SUPPLY_MILESTONES,
      process.env.CONTRACT_MILESTONE_THRESHOLDS,
      process.env.MILESTONE_THRESHOLDS,
   ];

   for (const source of candidateSources) {
      if (source === undefined || source === null || source === '') {
         continue;
      }

      const parsed =
         typeof source === 'string'
            ? (() => {
                 try {
                    return JSON.parse(source);
                 } catch {
                    return source
                       .split(',')
                       .map(part => Number(part.trim()))
                       .filter(value => Number.isFinite(value));
                 }
              })()
            : source;

      const entries =
         typeof parsed === 'object' && parsed !== null
            ? 'supplyMilestones' in parsed
               ? (parsed as { supplyMilestones?: unknown }).supplyMilestones
               : 'milestones' in parsed
                 ? (parsed as { milestones?: unknown }).milestones
                 : 'thresholds' in parsed
                   ? (parsed as { thresholds?: unknown }).thresholds
                   : 'milestoneThresholds' in parsed
                     ? (parsed as { milestoneThresholds?: unknown })
                          .milestoneThresholds
                     : null
            : null;

      const normalized = normalizeMilestones(entries ?? parsed);
      if (
         normalized.length > 0 &&
         normalized.some(item => item.threshold >= 0)
      ) {
         return normalized;
      }
   }

   return DEFAULT_MILESTONES;
}

export const MILESTONES: Milestone[] = readConfiguredMilestones();

export function getTierForSupply(
   supply: number,
   milestones: Milestone[] = readConfiguredMilestones()
): number {
   let tier = 0;
   for (const milestone of milestones) {
      if (supply >= milestone.threshold) {
         tier = milestone.tier > 0 ? milestone.tier : tier;
      } else {
         break;
      }
   }
   return tier;
}
