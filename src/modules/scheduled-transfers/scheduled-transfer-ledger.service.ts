import { z } from 'zod';
import { horizonGet } from '../../clients/horizon.client';

const ledgerRecordSchema = z.object({
   sequence: z.number().int().nonnegative().safe(),
   closed_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
});
const ledgerPageSchema = z.object({
   _embedded: z.object({ records: z.array(ledgerRecordSchema).min(1).max(2) }),
});

export interface ScheduledTransferLedger {
   ledger: number;
   closedAt: Date;
   closeIntervalMs: number | null;
}

/** A fresh network sample, so claimable changes even if no transfer events arrive. */
export async function readScheduledTransferLedger(): Promise<ScheduledTransferLedger> {
   const response = await horizonGet('/ledgers?order=desc&limit=2');
   if (!response.ok) throw new Error('Current ledger is unavailable');
   const page = ledgerPageSchema.parse(await response.json());
   const [latest, previous] = page._embedded.records;
   const closedAt = new Date(latest.closed_at);
   const ledgerDifference = previous ? latest.sequence - previous.sequence : 0;
   const elapsedMs = previous ? closedAt.getTime() - Date.parse(previous.closed_at) : 0;
   if (previous && (ledgerDifference <= 0 || elapsedMs <= 0)) {
      throw new Error('Invalid ledger close-time sample');
   }
   return {
      ledger: latest.sequence,
      closedAt,
      closeIntervalMs: previous ? elapsedMs / ledgerDifference : null,
   };
}
