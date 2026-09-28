// src/modules/staking/staking-indexer.service.ts
// Indexer event handlers for staking NFT contract events (#932).
//
// Two event types are handled:
//
//   STAKE_NFT_MINTED
//     Emitted when the staking contract mints a new stake receipt NFT.
//     Creates a StakingNft row, a StakingNftTransfer row (fromAddress=null),
//     and an Activity record for the audit trail.  Idempotent via mintTxHash.
//
//   STAKE_NFT_TRANSFERRED
//     Emitted when a stake receipt NFT is transferred from one wallet to
//     another (including secondary-market sales).  Updates ownerAddress on the
//     StakingNft row and appends a StakingNftTransfer row.  Idempotent via
//     the (txHash, eventIndex) unique constraint on StakingNftTransfer.
//
// Both handlers invalidate the affected wallets' NFT list caches so that the
// read endpoints reflect the change within the next request cycle.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   walletNftsCachePattern,
   nftMetaCachePattern,
   nftTransfersCachePattern,
} from './staking.service';

// ── Typed event interfaces ────────────────────────────────────

/**
 * Contract event emitted when a new staking NFT is minted.
 *
 * Required fields (all validated before any DB write):
 *   tokenId        — on-chain token identifier (string)
 *   ownerAddress   — wallet that receives the NFT on mint
 *   keyId          — creator key the staked tokens belong to
 *   stakedAmount   — number of locked keys (numeric string)
 *   mintTxHash     — transaction hash of the mint (dedup key)
 *   ledger         — ledger sequence of the mint
 *   mintedAt       — ISO-8601 timestamp of the mint
 *
 * Optional fields:
 *   lockExpiryLedger — ledger at which the lock expires (omit if no lock)
 *   lockExpiresAt    — ISO-8601 wall-clock equivalent of lockExpiryLedger
 */
export interface StakeNftMintedEvent extends IndexerChainEvent {
   eventType: 'STAKE_NFT_MINTED';
   tokenId: string;
   ownerAddress: string;
   keyId: string;
   stakedAmount: string;
   mintTxHash: string;
   mintedAt: string;
   lockExpiryLedger?: number;
   lockExpiresAt?: string;
}

/**
 * Contract event emitted when a staking NFT changes owner.
 *
 * Required fields:
 *   tokenId      — identifies which NFT was transferred
 *   fromAddress  — previous owner
 *   toAddress    — new owner
 *   ledger       — ledger sequence of the transfer
 *   txHash       — transaction hash
 *   eventIndex   — position within the transaction (dedup with txHash)
 *   occurredAt   — ISO-8601 timestamp of the transfer
 */
export interface StakeNftTransferredEvent extends IndexerChainEvent {
   eventType: 'STAKE_NFT_TRANSFERRED';
   tokenId: string;
   fromAddress: string;
   toAddress: string;
   occurredAt: string;
}

// ── STAKE_NFT_MINTED ──────────────────────────────────────────

const MINT_REQUIRED_FIELDS: (keyof StakeNftMintedEvent)[] = [
   'tokenId',
   'ownerAddress',
   'keyId',
   'stakedAmount',
   'mintTxHash',
   'mintedAt',
   'ledger',
];

/**
 * Process a batch of STAKE_NFT_MINTED events.
 *
 * Each event is written in a single Prisma transaction that creates:
 *   1. The StakingNft row
 *   2. An initial StakingNftTransfer row (fromAddress = null, representing
 *      the mint itself)
 *   3. An Activity record for the audit trail
 *
 * Already-minted NFTs (matched by mintTxHash) are skipped so replays are
 * safe.
 */
export async function processStakeNftMintedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'STAKE_NFT_MINTED') return;

      const e = event as StakeNftMintedEvent;

      for (const field of MINT_REQUIRED_FIELDS) {
         const value = e[field];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${e.txHash}:${e.eventIndex}`,
                  missingField: field,
               },
               'Skipping STAKE_NFT_MINTED event due to missing required field'
            );
            return;
         }
      }

      // Idempotency: skip if we already processed this mint transaction.
      const existing = await prisma.stakingNft.findUnique({
         where: { mintTxHash: e.mintTxHash },
         select: { id: true },
      });
      if (existing) {
         logger.info(
            {
               eventId: `${e.txHash}:${e.eventIndex}`,
               tokenId: e.tokenId,
               mintTxHash: e.mintTxHash,
            },
            'STAKE_NFT_MINTED already recorded; skipping duplicate event'
         );
         return;
      }

      const mintedAt = new Date(e.mintedAt);
      const lockExpiresAt =
         e.lockExpiresAt ? new Date(e.lockExpiresAt) : null;

      const nft = await prisma.$transaction(async tx => {
         // 1. Create the NFT record.
         const created = await tx.stakingNft.create({
            data: {
               tokenId: e.tokenId,
               ownerAddress: e.ownerAddress,
               keyId: e.keyId,
               stakedAmount: e.stakedAmount,
               lockExpiryLedger: e.lockExpiryLedger ?? null,
               lockExpiresAt,
               mintLedger: Number(e.ledger),
               mintTxHash: e.mintTxHash,
            },
         });

         // 2. Record the initial "mint" transfer (fromAddress = null).
         await tx.stakingNftTransfer.create({
            data: {
               nftId: created.id,
               fromAddress: null,
               toAddress: e.ownerAddress,
               ledger: Number(e.ledger),
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt: mintedAt,
            },
         });

         // 3. Audit trail.
         await tx.activity.create({
            data: {
               type: 'STAKE_NFT_MINTED' as any,
               actor: e.ownerAddress,
               creatorId: e.keyId,
               payload: {
                  tokenId: e.tokenId,
                  stakedAmount: e.stakedAmount,
                  lockExpiryLedger: e.lockExpiryLedger ?? null,
                  ledger_sequence: Number(e.ledger),
               },
               createdAt: mintedAt,
            },
         });

         return created;
      });

      // Invalidate wallet cache so the new NFT appears immediately.
      await cacheInvalidate(walletNftsCachePattern(e.ownerAddress));

      logger.info(
         {
            nftId: nft.id,
            tokenId: e.tokenId,
            ownerAddress: e.ownerAddress,
            keyId: e.keyId,
            ledger: e.ledger,
            txHash: e.txHash,
         },
         'STAKE_NFT_MINTED event processed'
      );
   });
}

// ── STAKE_NFT_TRANSFERRED ─────────────────────────────────────

const TRANSFER_REQUIRED_FIELDS: (keyof StakeNftTransferredEvent)[] = [
   'tokenId',
   'fromAddress',
   'toAddress',
   'occurredAt',
   'ledger',
   'txHash',
   'eventIndex',
];

/**
 * Process a batch of STAKE_NFT_TRANSFERRED events.
 *
 * For each event:
 *   1. Looks up the StakingNft by tokenId — skips with a warning if not found
 *      (out-of-order delivery; a replay from a full resync will fix it).
 *   2. Updates ownerAddress on the StakingNft row.
 *   3. Appends a StakingNftTransfer history row.
 *   4. Writes an Activity record.
 *
 * Idempotent via the unique(txHash, eventIndex) constraint on
 * StakingNftTransfer — a duplicate write attempt is silently skipped.
 */
export async function processStakeNftTransferredEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'STAKE_NFT_TRANSFERRED') return;

      const e = event as StakeNftTransferredEvent;

      for (const field of TRANSFER_REQUIRED_FIELDS) {
         const value = e[field];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${e.txHash}:${e.eventIndex}`,
                  missingField: field,
               },
               'Skipping STAKE_NFT_TRANSFERRED event due to missing required field'
            );
            return;
         }
      }

      // Idempotency: skip if this exact transfer is already recorded.
      const existingTransfer = await prisma.stakingNftTransfer.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
            },
         },
         select: { id: true },
      });
      if (existingTransfer) {
         logger.info(
            { eventId: `${e.txHash}:${e.eventIndex}`, tokenId: e.tokenId },
            'STAKE_NFT_TRANSFERRED already recorded; skipping duplicate event'
         );
         return;
      }

      // Resolve the NFT by on-chain tokenId.
      const nft = await prisma.stakingNft.findUnique({
         where: { tokenId: e.tokenId },
         select: { id: true, ownerAddress: true },
      });

      if (!nft) {
         logger.warn(
            {
               eventId: `${e.txHash}:${e.eventIndex}`,
               tokenId: e.tokenId,
            },
            'STAKE_NFT_TRANSFERRED references unknown tokenId; skipping (will retry on resync)'
         );
         return;
      }

      const occurredAt = new Date(e.occurredAt);
      const previousOwner = nft.ownerAddress;

      await prisma.$transaction([
         // Update the current owner.
         prisma.stakingNft.update({
            where: { id: nft.id },
            data: { ownerAddress: e.toAddress },
         }),
         // Append a transfer history row.
         prisma.stakingNftTransfer.create({
            data: {
               nftId: nft.id,
               fromAddress: e.fromAddress,
               toAddress: e.toAddress,
               ledger: Number(e.ledger),
               txHash: e.txHash,
               eventIndex: Number(e.eventIndex),
               occurredAt,
            },
         }),
         // Audit trail.
         prisma.activity.create({
            data: {
               type: 'STAKE_NFT_TRANSFERRED' as any,
               actor: e.fromAddress,
               target: e.toAddress,
               creatorId: null,
               payload: {
                  tokenId: e.tokenId,
                  nftId: nft.id,
                  ledger_sequence: Number(e.ledger),
               },
               createdAt: occurredAt,
            },
         }),
      ]);

      // Invalidate both wallets' NFT list caches and the per-NFT caches.
      await cacheInvalidate(
         walletNftsCachePattern(previousOwner),
         walletNftsCachePattern(e.toAddress),
         nftMetaCachePattern(nft.id),
         nftMetaCachePattern(e.tokenId),
         nftTransfersCachePattern(nft.id),
         nftTransfersCachePattern(e.tokenId)
      );

      logger.info(
         {
            nftId: nft.id,
            tokenId: e.tokenId,
            fromAddress: e.fromAddress,
            toAddress: e.toAddress,
            ledger: e.ledger,
            txHash: e.txHash,
         },
         'STAKE_NFT_TRANSFERRED event processed'
      );
   });
}
