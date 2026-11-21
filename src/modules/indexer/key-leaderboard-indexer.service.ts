import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { invalidateKeyLeaderboardCache } from '../keys/key-event-leaderboard.service';

export const LEADERBOARD_UPDATED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'LEADERBOARD_UPDATED',
   'LeaderboardUpdated',
]);

export const KEY_LEADERBOARD_INDEXER_DLQ_JOB_TYPE = 'LEADERBOARD_UPDATED';

export interface ParsedLeaderboardUpdate {
   creatorId: string;
   wallet: string;
   volume: bigint;
   pnl: bigint;
   holdingDays: bigint;
   ledger: number;
   eventIndex: number;
   txHash: string;
}

export type LeaderboardParseResult =
   | { ok: true; value: ParsedLeaderboardUpdate }
   | { ok: false; reason: string };

function firstPresent(
   event: Record<string, unknown>,
   names: readonly string[]
): unknown {
   for (const name of names) {
      if (event[name] !== undefined && event[name] !== null) {
         return event[name];
      }
   }
   return undefined;
}

function parseInteger(value: unknown): bigint | null {
   if (
      (typeof value !== 'string' &&
         typeof value !== 'number' &&
         typeof value !== 'bigint') ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))
   ) {
      return null;
   }
   try {
      return BigInt(value);
   } catch {
      return null;
   }
}

export function parseLeaderboardUpdatedEvent(
   event: IndexerChainEvent
): LeaderboardParseResult {
   const raw = event as Record<string, unknown>;
   const creatorValue = firstPresent(raw, ['creatorId', 'keyId', 'key_id']);
   const walletValue = firstPresent(raw, [
      'wallet',
      'walletAddress',
      'wallet_address',
   ]);
   const volume = parseInteger(firstPresent(raw, ['volume']));
   const pnl = parseInteger(firstPresent(raw, ['pnl']));
   const holdingDays = parseInteger(
      firstPresent(raw, ['holdingDays', 'holding_days'])
   );
   const ledger = Number(event.ledger);
   const eventIndex = Number(event.eventIndex);

   if (typeof creatorValue !== 'string' || creatorValue.trim() === '') {
      return { ok: false, reason: 'missing or invalid key ID' };
   }
   if (typeof walletValue !== 'string' || walletValue.trim() === '') {
      return { ok: false, reason: 'missing or invalid wallet' };
   }
   if (volume === null || volume < 0n) {
      return { ok: false, reason: 'missing or invalid volume' };
   }
   if (pnl === null) {
      return { ok: false, reason: 'missing or invalid pnl' };
   }
   if (holdingDays === null || holdingDays < 0n) {
      return { ok: false, reason: 'missing or invalid holding days' };
   }
   if (!Number.isInteger(ledger) || ledger < 0) {
      return { ok: false, reason: 'missing or invalid ledger' };
   }
   if (
      typeof event.txHash !== 'string' ||
      event.txHash === '' ||
      !Number.isInteger(eventIndex) ||
      eventIndex < 0
   ) {
      return { ok: false, reason: 'missing or invalid txHash/eventIndex' };
   }

   return {
      ok: true,
      value: {
         creatorId: creatorValue.trim(),
         wallet: walletValue.trim(),
         volume,
         pnl,
         holdingDays,
         ledger,
         eventIndex,
         txHash: event.txHash,
      },
   };
}

async function applyLeaderboardUpdate(
   update: ParsedLeaderboardUpdate
): Promise<boolean> {
   const identity = {
      creatorId: update.creatorId,
      wallet: update.wallet,
   };
   const newerThanStored = {
      ...identity,
      OR: [
         { ledger: { lt: update.ledger } },
         { ledger: update.ledger, eventIndex: { lt: update.eventIndex } },
      ],
   };
   const data = {
      volume: update.volume,
      pnl: update.pnl,
      holdingDays: update.holdingDays,
      ledger: update.ledger,
      eventIndex: update.eventIndex,
      txHash: update.txHash,
   };

   const updated = await prisma.keyLeaderboard.updateMany({
      where: newerThanStored,
      data,
   });
   if (updated.count > 0) return true;

   try {
      await prisma.keyLeaderboard.create({ data: { ...identity, ...data } });
      return true;
   } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
   }

   const retried = await prisma.keyLeaderboard.updateMany({
      where: newerThanStored,
      data,
   });
   return retried.count > 0;
}

export async function processLeaderboardUpdatedEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseLeaderboardUpdatedEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'leaderboard_event_rejected', eventId, reason: parsed.reason },
         'Malformed LeaderboardUpdated event moved to DLQ'
      );
      await moveToDLQ({
         jobType: KEY_LEADERBOARD_INDEXER_DLQ_JOB_TYPE,
         payload: JSON.parse(
            JSON.stringify(event, (_key, value) =>
               typeof value === 'bigint' ? value.toString() : value
            )
         ),
         retryCount: 0,
         failureReason: parsed.reason,
      });
      return false;
   }

   const update = parsed.value;
   const changed = await applyLeaderboardUpdate(update);
   await invalidateKeyLeaderboardCache(update.creatorId);

   logger.debug(
      {
         type: changed
            ? 'key_leaderboard_indexed'
            : 'key_leaderboard_stale_skipped',
         eventId,
         creator_id: update.creatorId,
         wallet: update.wallet,
         ledger: update.ledger,
      },
      changed
         ? 'Key leaderboard entry indexed'
         : 'Stale LeaderboardUpdated event skipped'
   );
   return changed;
}

export async function processLeaderboardUpdatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!LEADERBOARD_UPDATED_EVENT_TYPES.has(event.eventType)) return;
      await processLeaderboardUpdatedEvent(event);
   });
}
