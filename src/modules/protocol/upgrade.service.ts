import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { IndexerChainEvent, processIndexerChainEvents } from '../../utils/indexer-event-processor.utils';

export const CONTRACT_UPGRADE_EVENT_TYPES = new Set([
   'upgrade_scheduled', 'upgrade_executed', 'upgrade_cancelled',
]);
export const PROTOCOL_VERSION_CACHE_KEY = 'protocol:version';

function eventDate(value: unknown, fallback = new Date()): Date {
   if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      const number = Number(value);
      const date = new Date(number < 1e12 ? number * 1000 : number);
      if (!Number.isNaN(date.getTime())) return date;
   }
   const date = value ? new Date(String(value)) : fallback;
   return Number.isNaN(date.getTime()) ? fallback : date;
}

export async function processContractUpgradeEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!CONTRACT_UPGRADE_EVENT_TYPES.has(event.eventType)) return;
      if (!event.txHash || !Number.isInteger(event.eventIndex)) throw new Error('Upgrade event requires txHash and eventIndex');
      if (event.eventType === 'upgrade_scheduled') {
         const id = String(event.upgradeId ?? event.id ?? `${event.txHash}:${event.eventIndex}`);
         const fromVersion = String(event.fromVersion ?? '');
         const toVersion = String(event.toVersion ?? '');
         if (!fromVersion || !toVersion) throw new Error('Scheduled upgrade requires fromVersion and toVersion');
         await prisma.contractUpgrade.upsert({
            where: { id },
            create: { id, fromVersion, toVersion,
               scheduledAt: eventDate(event.scheduledAt ?? event.timestamp),
               executableAt: eventDate(event.executableAt ?? event.executeAfter),
               scheduleTxHash: event.txHash, scheduleEventIndex: event.eventIndex },
            update: {},
         });
      } else {
         const upgradeId = event.upgradeId ?? event.id;
         const upgrade = upgradeId
            ? await prisma.contractUpgrade.findUnique({ where: { id: String(upgradeId) } })
            : await prisma.contractUpgrade.findFirst({ where: { status: 'PENDING' }, orderBy: { scheduledAt: 'desc' } });
         if (upgrade) {
            const executed = event.eventType === 'upgrade_executed';
            const duplicate = executed
               ? upgrade.executedTxHash === event.txHash && upgrade.executedEventIndex === event.eventIndex
               : upgrade.cancelledTxHash === event.txHash && upgrade.cancelledEventIndex === event.eventIndex;
            if (!duplicate) await prisma.contractUpgrade.update({ where: { id: upgrade.id }, data: executed
               ? { status: 'EXECUTED', executedAt: eventDate(event.executedAt ?? event.timestamp), executedTxHash: event.txHash, executedEventIndex: event.eventIndex }
               : { status: 'CANCELLED', cancelledTxHash: event.txHash, cancelledEventIndex: event.eventIndex } });
         }
      }
      await cacheInvalidate(PROTOCOL_VERSION_CACHE_KEY);
   });
}

export interface ProtocolVersionState {
   current: string;
   pending: null | { fromVersion: string; toVersion: string; scheduledAt: string; executableAt: string };
}

export async function getState(): Promise<ProtocolVersionState> {
   const [executed, latest, pending] = await Promise.all([
      prisma.contractUpgrade.findFirst({ where: { status: 'EXECUTED' }, orderBy: { executedAt: 'desc' } }),
      prisma.contractUpgrade.findFirst({ orderBy: { scheduledAt: 'desc' } }),
      prisma.contractUpgrade.findFirst({ where: { status: 'PENDING' }, orderBy: { scheduledAt: 'desc' } }),
   ]);
   return {
      current: executed?.toVersion ?? latest?.fromVersion ?? '1.0.0',
      pending: pending ? { fromVersion: pending.fromVersion, toVersion: pending.toVersion,
         scheduledAt: pending.scheduledAt.toISOString(), executableAt: pending.executableAt.toISOString() } : null,
   };
}
