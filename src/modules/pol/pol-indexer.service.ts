import { prisma } from '../../utils/prisma.utils';
import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';
import { logger } from '../../utils/logger.utils';

const TYPES: Readonly<Record<string, 'funded' | 'applied' | 'repaid'>> = {
   pol_funded: 'funded', POL_FUNDED: 'funded', PolFunded: 'funded',
   backstop_applied: 'applied', BACKSTOP_APPLIED: 'applied', BackstopApplied: 'applied',
   backstop_repaid: 'repaid', BACKSTOP_REPAID: 'repaid', BackstopRepaid: 'repaid',
};
export const POL_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(TYPES));

export function parsePolEvent(event: IndexerChainEvent) {
   const raw = event as Record<string, unknown>;
   const type = TYPES[event.eventType];
   const amount = raw.amount;
   if (!type || (typeof amount === 'number' && !Number.isSafeInteger(amount)) ||
      !['string', 'number', 'bigint'].includes(typeof amount) ||
      !/^[1-9][0-9]*$/.test(String(amount)) ||
      BigInt(String(amount)) > (1n << 127n) - 1n) {
      throw new Error('Invalid POL event type or positive i128 amount');
   }
   if (!Number.isInteger(event.ledger) || Number(event.ledger) < 0 ||
      Number(event.ledger) > 2147483647 || !Number.isInteger(event.eventIndex) ||
      event.eventIndex < 0 || event.eventIndex > 2147483647 ||
      typeof event.txHash !== 'string' || !event.txHash.trim()) {
      throw new Error('Invalid POL chain position');
   }
   const identifier = raw.keyId ?? raw.key_id ?? raw.creatorId ?? raw.creator;
   const keyId = typeof identifier === 'string' ? identifier.trim() : null;
   if (type !== 'funded' && (!keyId || keyId.length > 128)) {
      throw new Error('Backstop event requires a key identifier');
   }
   const rawTime = raw.timestamp ?? raw.createdAt ?? raw.tradeAt;
   const timestamp = rawTime === undefined ? new Date() :
      new Date(typeof rawTime === 'number' ? rawTime * 1000 : String(rawTime));
   if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid POL timestamp');
   return { type, amount: String(amount), keyId: type === 'funded' ? null : keyId,
      ledger: Number(event.ledger), eventIndex: event.eventIndex, txHash: event.txHash, timestamp };
}

export async function processPolEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!POL_EVENT_TYPES.has(event.eventType)) return;
      let value: ReturnType<typeof parsePolEvent>;
      try {
         value = parsePolEvent(event);
      } catch (error) {
         const reason = error instanceof Error ? error.message : 'Invalid POL event';
         logger.warn({ reason, txHash: event.txHash }, 'POL event moved to DLQ');
         await moveToDLQ({ jobType: 'POL', retryCount: 0, failureReason: reason,
            payload: JSON.parse(JSON.stringify(event, (_key, item) =>
               typeof item === 'bigint' ? item.toString() : item)) });
         return;
      }
      const keyId = value.keyId ? (await resolveCreatorId(value.keyId)) ?? value.keyId : null;
      await prisma.$transaction(async tx => {
         const receipt = await tx.backstop.createMany({
            data: [{ ...value, keyId }], skipDuplicates: true,
         });
         if (receipt.count === 0) return;
         const update = value.type === 'funded'
            ? { balance: { increment: value.amount } }
            : value.type === 'applied'
              ? { balance: { decrement: value.amount }, deployedAmount: { increment: value.amount } }
              : { balance: { increment: value.amount }, repaidAmount: { increment: value.amount } };
         // Signed deltas converge even when repayments or deployments arrive
         // before funding. Never floor intermediate balances or lose a delta.
         await tx.polReserve.upsert({ where: { id: 'default' }, update,
            create: { id: 'default',
               balance: value.type === 'applied' ? '-' + value.amount : value.amount,
               deployedAmount: value.type === 'applied' ? value.amount : '0',
               repaidAmount: value.type === 'repaid' ? value.amount : '0' } });
      });
      await cacheInvalidate('protocol:pol');
   });
}
