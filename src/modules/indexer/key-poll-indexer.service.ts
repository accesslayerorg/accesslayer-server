import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

export const POLL_CREATED_EVENT_TYPES = new Set([
   'PollCreated',
   'POLL_CREATED',
]);
export const POLL_VOTE_CAST_EVENT_TYPES = new Set([
   'PollVoteCast',
   'POLL_VOTE_CAST',
]);
export const POLL_CLOSED_EVENT_TYPES = new Set(['PollClosed', 'POLL_CLOSED']);

export const KEY_POLL_EVENT_TYPES = new Set([
   ...POLL_CREATED_EVENT_TYPES,
   ...POLL_VOTE_CAST_EVENT_TYPES,
   ...POLL_CLOSED_EVENT_TYPES,
]);

function eventId(event: IndexerChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

function stringValue(value: unknown): string | null {
   if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
   }
   if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
   }
   return null;
}

function eventDate(...values: unknown[]): Date | null {
   for (const value of values) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
         return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
         const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
         const date = new Date(milliseconds);
         if (!Number.isNaN(date.getTime())) return date;
      }
      if (typeof value === 'string' && value.trim() !== '') {
         const numeric = Number(value);
         if (Number.isFinite(numeric)) {
            const milliseconds =
               numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
            const date = new Date(milliseconds);
            if (!Number.isNaN(date.getTime())) return date;
         }
         const date = new Date(value);
         if (!Number.isNaN(date.getTime())) return date;
      }
   }
   return null;
}

function normalizeOptions(value: unknown): string[] {
   let options: unknown = value;
   if (typeof value === 'string') {
      try {
         options = JSON.parse(value);
      } catch {
         options = value.split(',');
      }
   }
   if (!Array.isArray(options)) return [];
   return options
      .map(option => stringValue(option))
      .filter((option): option is string => option !== null);
}

function requiredEventValue(
   event: IndexerChainEvent,
   name: string,
   ...values: unknown[]
): string {
   const value = values.map(stringValue).find(candidate => candidate !== null);
   if (value) return value;
   logger.error(
      { eventId: eventId(event), missingField: name },
      'Cannot index community poll event with missing required data'
   );
   throw new Error(`Poll event is missing required ${name}`);
}

function isUniqueConstraintError(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
   );
}

async function invalidatePollCache(keyId: string): Promise<void> {
   await cacheInvalidate(`key:poll*:${keyId}:*`);
}

async function applyPollCreated(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredEventValue(event, 'keyId', event.keyId, event.key_id);
   const pollId = requiredEventValue(
      event,
      'pollId',
      event.pollId,
      event.poll_id
   );
   const options = normalizeOptions(event.options);
   const expiresAt = eventDate(
      event.expiresAt,
      event.expires_at,
      event.expiry,
      event.deadline,
      event.endTime,
      event.end_time
   );
   if (options.length === 0 || !expiresAt) {
      logger.error(
         {
            eventId: eventId(event),
            keyId,
            pollId,
            optionsCount: options.length,
            hasExpiry: expiresAt !== null,
         },
         'Cannot index PollCreated event with invalid options or expiry'
      );
      throw new Error('PollCreated event requires options and expiry');
   }

   try {
      await prisma.keyPoll.create({
         data: {
            keyId,
            pollId,
            question:
               stringValue(event.question) ?? stringValue(event.title) ?? '',
            options,
            expiresAt,
         },
      });
   } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      logger.info(
         { eventId: eventId(event), keyId, pollId },
         'PollCreated already indexed; skipping duplicate event'
      );
   }
   await invalidatePollCache(keyId);
}

async function applyPollVoteCast(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredEventValue(event, 'keyId', event.keyId, event.key_id);
   const pollId = requiredEventValue(
      event,
      'pollId',
      event.pollId,
      event.poll_id
   );
   const wallet = requiredEventValue(
      event,
      'wallet',
      event.wallet,
      event.voter,
      event.voterAddress,
      event.voter_address
   );
   const optionIndex = Number(event.optionIndex ?? event.option_index);
   const rawWeight = stringValue(
      event.weight ?? event.voteWeight ?? event.vote_weight
   );
   if (
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      rawWeight === null ||
      !/^\d+(?:\.\d{1,7})?$/.test(rawWeight)
   ) {
      logger.error(
         { eventId: eventId(event), keyId, pollId, optionIndex, rawWeight },
         'Cannot index PollVoteCast event with invalid option or weight'
      );
      throw new Error('PollVoteCast event has invalid option or weight');
   }

   const poll = await prisma.keyPoll.findUnique({
      where: { keyId_pollId: { keyId, pollId } },
      select: { options: true },
   });
   if (!poll) {
      throw new Error(
         `PollVoteCast references unknown poll ${keyId}/${pollId}`
      );
   }
   const options = normalizeOptions(poll.options);
   if (optionIndex >= options.length) {
      throw new Error(
         `PollVoteCast option index is out of range for ${pollId}`
      );
   }

   try {
      await prisma.keyPollVote.create({
         data: {
            keyId,
            pollId,
            wallet,
            optionIndex,
            weight: new Decimal(rawWeight),
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            castAt:
               eventDate(event.occurredAt, event.createdAt, event.timestamp) ??
               new Date(),
         },
      });
   } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      logger.info(
         { eventId: eventId(event), keyId, pollId, wallet },
         'PollVoteCast already indexed; skipping duplicate event'
      );
   }
   await invalidatePollCache(keyId);
}

async function applyPollClosed(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredEventValue(event, 'keyId', event.keyId, event.key_id);
   const pollId = requiredEventValue(
      event,
      'pollId',
      event.pollId,
      event.poll_id
   );
   const poll = await prisma.keyPoll.findUnique({
      where: { keyId_pollId: { keyId, pollId } },
      select: { status: true },
   });
   if (!poll) {
      throw new Error(`PollClosed references unknown poll ${keyId}/${pollId}`);
   }
   if (poll.status !== 'closed') {
      await prisma.keyPoll.update({
         where: { keyId_pollId: { keyId, pollId } },
         data: {
            status: 'closed',
            closedAt:
               eventDate(event.closedAt, event.closed_at, event.occurredAt) ??
               new Date(),
         },
      });
   }
   await invalidatePollCache(keyId);
}

export async function processKeyPollEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (POLL_CREATED_EVENT_TYPES.has(event.eventType)) {
         await applyPollCreated(event);
      } else if (POLL_VOTE_CAST_EVENT_TYPES.has(event.eventType)) {
         await applyPollVoteCast(event);
      } else if (POLL_CLOSED_EVENT_TYPES.has(event.eventType)) {
         await applyPollClosed(event);
      }
   });
}
