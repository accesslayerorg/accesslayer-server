// src/modules/governance/governance-delegation-indexer.service.ts
// Indexer event handlers for governance delegation contract events (#933).
//
// Two event types are handled:
//
//   DELEGATION_SET
//     Emitted when a wallet sets (or updates) its vote delegate for a key.
//     Upserts VoteDelegation with isActive=true and appends a
//     VoteDelegationHistory row with action='set'.
//     Guard: if the stored ledger is higher than the incoming event, the
//     event is from a replay of an older batch — skip it to avoid clobbering
//     a newer revoke with an older set.
//
//   DELEGATION_REVOKED
//     Emitted when a wallet removes its active vote delegation.
//     Sets isActive=false on the VoteDelegation row and appends a
//     VoteDelegationHistory row with action='revoked'.
//     Skip gracefully if no active delegation exists (out-of-order delivery).
//
// Both handlers:
//   - Validate required fields and skip with a warn on missing data
//   - Are idempotent via unique(txHash, eventIndex) on VoteDelegationHistory
//   - Invalidate the delegation caches so reads reflect the change immediately
//   - Write an Activity audit record

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   delegateCachePattern,
   delegatorsCachePattern,
   delegationHistoryCachePattern,
} from './governance-delegation.service';

// ── Typed event interfaces ────────────────────────────────────

/**
 * Contract event emitted when a wallet sets or updates its vote delegate.
 *
 * Required fields:
 *   delegatorWallet  — wallet that is delegating
 *   delegateeWallet  — wallet receiving the delegation
 *   keyId            — creator key scope
 *   ledger           — ledger sequence
 *   txHash           — transaction hash
 *   eventIndex       — position within the transaction (dedup)
 *   occurredAt       — ISO-8601 timestamp
 */
export interface DelegationSetEvent extends IndexerChainEvent {
   eventType: 'DELEGATION_SET';
   delegatorWallet: string;
   delegateeWallet: string;
   keyId: string;
   occurredAt: string;
}

/**
 * Contract event emitted when a wallet revokes its active vote delegation.
 *
 * Required fields:
 *   delegatorWallet  — wallet revoking the delegation
 *   keyId            — creator key scope
 *   ledger           — ledger sequence
 *   txHash           — transaction hash
 *   eventIndex       — position within the transaction (dedup)
 *   occurredAt       — ISO-8601 timestamp
 */
export interface DelegationRevokedEvent extends IndexerChainEvent {
   eventType: 'DELEGATION_REVOKED';
   delegatorWallet: string;
   keyId: string;
   occurredAt: string;
}

// ── DELEGATION_SET ────────────────────────────────────────────

const DELEGATION_SET_REQUIRED_FIELDS: (keyof DelegationSetEvent)[] = [
   'delegatorWallet',
   'delegateeWallet',
   'keyId',
   'occurredAt',
   'ledger',
   'txHash',
   'eventIndex',
];

/**
 * Process a batch of DELEGATION_SET events.
 *
 * For each event:
 *   1. Validates required fields.
 *   2. Idempotency: skips if VoteDelegationHistory already has a row for
 *      this (txHash, eventIndex).
 *   3. Ledger guard: skips if the stored VoteDelegation.ledger is higher
 *      (event is a stale replay).
 *   4. Upserts VoteDelegation (delegateeWallet, isActive=true, ledger, txHash).
 *   5. Appends a VoteDelegationHistory row (action='set').
 *   6. Writes an Activity record.
 *   7. Invalidates caches for both wallets.
 */
export async function processDelegationSetEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'DELEGATION_SET') return;

      const e = event as DelegationSetEvent;

      for (const field of DELEGATION_SET_REQUIRED_FIELDS) {
         const value = e[field];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${e.txHash}:${e.eventIndex}`,
                  missingField: field,
               },
               'Skipping DELEGATION_SET event due to missing required field'
            );
            return;
         }
      }

      // Idempotency: skip if this exact event is already recorded.
      const existingHistory = await prisma.voteDelegationHistory.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
            },
         },
         select: { id: true },
      });
      if (existingHistory) {
         logger.info(
            { eventId: `${e.txHash}:${e.eventIndex}`, delegatorWallet: e.delegatorWallet },
            'DELEGATION_SET already recorded; skipping duplicate event'
         );
         return;
      }

      const occurredAt = new Date(e.occurredAt);
      const incomingLedger = Number(e.ledger);

      // Ledger guard: if the current state was set by a later ledger, this
      // is a stale replay of an earlier event — skip to avoid regression.
      const existing = await prisma.voteDelegation.findUnique({
         where: {
            delegatorWallet_keyId: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
            },
         },
         select: { ledger: true, delegateeWallet: true },
      });

      if (existing && existing.ledger > incomingLedger) {
         logger.info(
            {
               eventId: `${e.txHash}:${e.eventIndex}`,
               delegatorWallet: e.delegatorWallet,
               storedLedger: existing.ledger,
               incomingLedger,
            },
            'DELEGATION_SET skipped: stored state is from a later ledger'
         );
         // Still append history so the audit trail is complete.
         await prisma.voteDelegationHistory.create({
            data: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
               delegateeWallet: e.delegateeWallet,
               action: 'set',
               ledger: incomingLedger,
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt,
            },
         });
         return;
      }

      const previousDelegatee = existing?.delegateeWallet ?? null;

      await prisma.$transaction([
         // Upsert the current-state delegation row.
         prisma.voteDelegation.upsert({
            where: {
               delegatorWallet_keyId: {
                  delegatorWallet: e.delegatorWallet,
                  keyId: e.keyId,
               },
            },
            update: {
               delegateeWallet: e.delegateeWallet,
               isActive: true,
               ledger: incomingLedger,
               txHash: e.txHash,
               occurredAt,
            },
            create: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
               delegateeWallet: e.delegateeWallet,
               isActive: true,
               ledger: incomingLedger,
               txHash: e.txHash,
               occurredAt,
            },
         }),
         // Append history row.
         prisma.voteDelegationHistory.create({
            data: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
               delegateeWallet: e.delegateeWallet,
               action: 'set',
               ledger: incomingLedger,
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt,
            },
         }),
         // Audit trail activity record.
         prisma.activity.create({
            data: {
               type: 'GOVERNANCE_DELEGATION_SET' as any,
               actor: e.delegatorWallet,
               target: e.delegateeWallet,
               creatorId: e.keyId,
               payload: {
                  delegatorWallet: e.delegatorWallet,
                  delegateeWallet: e.delegateeWallet,
                  previousDelegatee,
                  keyId: e.keyId,
                  ledger_sequence: incomingLedger,
               },
               createdAt: occurredAt,
            },
         }),
      ]);

      // Invalidate caches for both wallets (delegator's "who I delegated to"
      // and delegatee's "who delegated to me", plus any previous delegatee).
      const patternsToInvalidate = [
         delegateCachePattern(e.delegatorWallet),
         delegatorsCachePattern(e.delegateeWallet),
         delegationHistoryCachePattern(e.delegatorWallet),
         delegationHistoryCachePattern(e.delegateeWallet),
      ];
      if (previousDelegatee && previousDelegatee !== e.delegateeWallet) {
         patternsToInvalidate.push(delegatorsCachePattern(previousDelegatee));
         patternsToInvalidate.push(delegationHistoryCachePattern(previousDelegatee));
      }
      await cacheInvalidate(...patternsToInvalidate);

      logger.info(
         {
            delegatorWallet: e.delegatorWallet,
            delegateeWallet: e.delegateeWallet,
            keyId: e.keyId,
            ledger: incomingLedger,
            txHash: e.txHash,
         },
         'DELEGATION_SET event processed'
      );
   });
}

// ── DELEGATION_REVOKED ────────────────────────────────────────

const DELEGATION_REVOKED_REQUIRED_FIELDS: (keyof DelegationRevokedEvent)[] = [
   'delegatorWallet',
   'keyId',
   'occurredAt',
   'ledger',
   'txHash',
   'eventIndex',
];

/**
 * Process a batch of DELEGATION_REVOKED events.
 *
 * For each event:
 *   1. Validates required fields.
 *   2. Idempotency: skips if this (txHash, eventIndex) is already recorded.
 *   3. Resolves the current delegation row; skips if none exists or already
 *      revoked (out-of-order delivery handled gracefully).
 *   4. Sets VoteDelegation.isActive=false.
 *   5. Appends a VoteDelegationHistory row (action='revoked').
 *   6. Writes an Activity record.
 *   7. Invalidates caches for both wallets.
 */
export async function processDelegationRevokedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'DELEGATION_REVOKED') return;

      const e = event as DelegationRevokedEvent;

      for (const field of DELEGATION_REVOKED_REQUIRED_FIELDS) {
         const value = e[field];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${e.txHash}:${e.eventIndex}`,
                  missingField: field,
               },
               'Skipping DELEGATION_REVOKED event due to missing required field'
            );
            return;
         }
      }

      // Idempotency check.
      const existingHistory = await prisma.voteDelegationHistory.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
            },
         },
         select: { id: true },
      });
      if (existingHistory) {
         logger.info(
            { eventId: `${e.txHash}:${e.eventIndex}`, delegatorWallet: e.delegatorWallet },
            'DELEGATION_REVOKED already recorded; skipping duplicate event'
         );
         return;
      }

      // Resolve the current delegation.
      const delegation = await prisma.voteDelegation.findUnique({
         where: {
            delegatorWallet_keyId: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
            },
         },
         select: { id: true, delegateeWallet: true, isActive: true },
      });

      const occurredAt = new Date(e.occurredAt);
      const incomingLedger = Number(e.ledger);

      if (!delegation) {
         // No delegation exists — still record history for auditability.
         logger.warn(
            {
               eventId: `${e.txHash}:${e.eventIndex}`,
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
            },
            'DELEGATION_REVOKED references unknown delegation; recording history only'
         );
         await prisma.voteDelegationHistory.create({
            data: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
               delegateeWallet: null,
               action: 'revoked',
               ledger: incomingLedger,
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt,
            },
         });
         return;
      }

      const previousDelegatee = delegation.delegateeWallet;

      await prisma.$transaction([
         // Mark the delegation inactive.
         prisma.voteDelegation.update({
            where: { id: delegation.id },
            data: {
               isActive: false,
               ledger: incomingLedger,
               txHash: e.txHash,
               occurredAt,
            },
         }),
         // Append history row.
         prisma.voteDelegationHistory.create({
            data: {
               delegatorWallet: e.delegatorWallet,
               keyId: e.keyId,
               delegateeWallet: null,
               action: 'revoked',
               ledger: incomingLedger,
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt,
            },
         }),
         // Audit trail.
         prisma.activity.create({
            data: {
               type: 'GOVERNANCE_DELEGATION_REVOKED' as any,
               actor: e.delegatorWallet,
               target: previousDelegatee,
               creatorId: e.keyId,
               payload: {
                  delegatorWallet: e.delegatorWallet,
                  revokedDelegatee: previousDelegatee,
                  keyId: e.keyId,
                  ledger_sequence: incomingLedger,
               },
               createdAt: occurredAt,
            },
         }),
      ]);

      await cacheInvalidate(
         delegateCachePattern(e.delegatorWallet),
         delegatorsCachePattern(previousDelegatee),
         delegationHistoryCachePattern(e.delegatorWallet),
         delegationHistoryCachePattern(previousDelegatee)
      );

      logger.info(
         {
            delegatorWallet: e.delegatorWallet,
            revokedDelegatee: previousDelegatee,
            keyId: e.keyId,
            ledger: incomingLedger,
            txHash: e.txHash,
         },
         'DELEGATION_REVOKED event processed'
      );
   });
}
