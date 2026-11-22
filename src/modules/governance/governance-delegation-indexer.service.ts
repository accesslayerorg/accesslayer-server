// Delegation receipts, current state and audit activity commit atomically.
// A revoked tombstone and chain watermark prevent stale events restoring old weight.
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';
import { invalidateKeyVotingWeightCache } from './governance-voting-weight.service';
import { delegateCachePattern, delegatorsCachePattern, delegationHistoryCachePattern } from './governance-delegation.service';

export const DELEGATION_SET_EVENT_TYPES: ReadonlySet<string> = new Set([
   'DELEGATION_SET', 'VotingDelegated', 'VOTING_DELEGATED', 'voting_delegated',
]);
export const DELEGATION_REVOKED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'DELEGATION_REVOKED', 'DelegationRevoked', 'delegation_revoked',
]);
export const VOTING_DELEGATION_EVENT_TYPES: ReadonlySet<string> = new Set([
   ...DELEGATION_SET_EVENT_TYPES, ...DELEGATION_REVOKED_EVENT_TYPES,
]);

export interface DelegationSetEvent extends IndexerChainEvent {
   eventType: 'DELEGATION_SET';
   delegatorWallet: string;
   delegateeWallet: string;
   keyId: string;
   occurredAt: string;
}
export interface DelegationRevokedEvent extends IndexerChainEvent {
   eventType: 'DELEGATION_REVOKED';
   delegatorWallet: string;
   keyId: string;
   occurredAt: string;
}
interface ParsedDelegation {
   action: 'set' | 'revoked';
   delegatorWallet: string;
   delegateeWallet: string | null;
   keyId: string;
   ledger: number;
   transactionIndex: number | null;
   eventIndex: number;
   txHash: string;
   occurredAt: Date;
}
interface ChainPosition { ledger: number; transactionIndex: number | null; eventIndex: number; txHash: string }

function readString(value: unknown): string | null {
   return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
function positionNumber(value: unknown): number | null {
   if (typeof value !== 'number' && typeof value !== 'string') return null;
   if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null;
   const number = Number(value);
   return Number.isSafeInteger(number) && number >= 0 && number <= 2147483647 ? number : null;
}
function newer(incoming: ChainPosition, existing: ChainPosition): boolean {
   if (incoming.ledger !== existing.ledger) return incoming.ledger > existing.ledger;
   if (incoming.txHash === existing.txHash) return incoming.eventIndex > existing.eventIndex;
   if (incoming.transactionIndex !== null && existing.transactionIndex !== null) {
      return incoming.transactionIndex > existing.transactionIndex;
   }
   // Legacy events lack a transaction ordinal: the ordered source stream is
   // authoritative between distinct transactions, and receipts reject replays.
   return true;
}
function parseDelegation(event: IndexerChainEvent): ParsedDelegation | null {
   const envelope = event as Record<string, unknown>;
   const payload = envelope.payload;
   const raw = { ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}), ...envelope };
   const delegatorWallet = readString(raw.delegatorWallet ?? raw.delegator_wallet ?? raw.delegator ?? raw.wallet);
   const delegateeWallet = readString(raw.delegateeWallet ?? raw.delegatee_wallet ?? raw.delegatee ?? raw.delegate);
   const keyId = readString(raw.keyId ?? raw.key_id ?? raw.creatorId ?? raw.creator_id);
   const txHash = readString(raw.txHash);
   const ledger = positionNumber(raw.ledger);
   const eventIndex = positionNumber(raw.eventIndex);
   const rawTransactionIndex = raw.transactionIndex ?? raw.transaction_index;
   const transactionIndex = rawTransactionIndex === undefined || rawTransactionIndex === null ? null : positionNumber(rawTransactionIndex);
   const timestamp = raw.occurredAt ?? raw.timestamp ?? raw.ledgerClosedAt;
   const occurredAt = new Date(typeof timestamp === 'number' ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : String(timestamp));
   const action = DELEGATION_SET_EVENT_TYPES.has(event.eventType) ? 'set' : 'revoked';
   if (!delegatorWallet || !StrKey.isValidEd25519PublicKey(delegatorWallet) ||
       (action === 'set' && (!delegateeWallet || !StrKey.isValidEd25519PublicKey(delegateeWallet))) ||
       !keyId || keyId.length > 128 || !txHash || ledger === null ||
       eventIndex === null || (rawTransactionIndex !== undefined && rawTransactionIndex !== null && transactionIndex === null) || Number.isNaN(occurredAt.getTime())) return null;
   return { action, delegatorWallet, delegateeWallet: action === 'set' ? delegateeWallet : null, keyId, ledger, eventIndex, transactionIndex, txHash, occurredAt };
}

async function persistDelegation(value: ParsedDelegation): Promise<string | null> {
   return prisma.$transaction(async tx => {
      const scope = 'delegation:' + value.keyId + ':' + value.delegatorWallet;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
      const existing = await tx.voteDelegation.findUnique({
         where: { delegatorWallet_keyId: { delegatorWallet: value.delegatorWallet, keyId: value.keyId } },
      });
      const receipt = await tx.voteDelegationHistory.findUnique({
         where: { txHash_eventIndex: { txHash: value.txHash, eventIndex: value.eventIndex } },
      });
      const previous = existing?.isActive ? existing.delegateeWallet : null;
      if (receipt) return previous;

      await tx.voteDelegationHistory.create({ data: {
         delegatorWallet: value.delegatorWallet, keyId: value.keyId,
         delegateeWallet: value.action === 'set' ? value.delegateeWallet : null,
         action: value.action, ledger: value.ledger, transactionIndex: value.transactionIndex,
         eventIndex: value.eventIndex, txHash: value.txHash, occurredAt: value.occurredAt,
      } });
      if (existing && !newer(value, existing)) return previous;

      // An unknown revoke gets an inactive self-address tombstone; active reads
      // exclude it, while its watermark blocks any older set from reviving weight.
      const state = {
         delegatorWallet: value.delegatorWallet, keyId: value.keyId,
         delegateeWallet: value.action === 'set' ? value.delegateeWallet! : existing?.delegateeWallet ?? value.delegatorWallet,
         isActive: value.action === 'set', ledger: value.ledger,
         transactionIndex: value.transactionIndex, eventIndex: value.eventIndex,
         txHash: value.txHash, occurredAt: value.occurredAt,
      };
      await tx.voteDelegation.upsert({
         where: { delegatorWallet_keyId: { delegatorWallet: value.delegatorWallet, keyId: value.keyId } },
         create: state, update: state,
      });
      await tx.activity.create({ data: {
         type: value.action === 'set' ? 'GOVERNANCE_DELEGATION_SET' : 'GOVERNANCE_DELEGATION_REVOKED',
         actor: value.delegatorWallet, target: value.delegateeWallet ?? previous,
         creatorId: value.keyId, createdAt: value.occurredAt,
         payload: { delegatorWallet: value.delegatorWallet, delegateeWallet: value.delegateeWallet,
            previousDelegatee: previous, keyId: value.keyId, ledger_sequence: value.ledger },
      } });
      return previous;
   });
}

async function processDelegationEvent(event: IndexerChainEvent): Promise<void> {
   const parsed = parseDelegation(event);
   if (!parsed) {
      logger.warn({ txHash: event.txHash, eventIndex: event.eventIndex }, 'Malformed delegation moved to DLQ');
      await moveToDLQ({
         jobType: 'GOVERNANCE_DELEGATION', retryCount: 0, failureReason: 'Invalid delegation fields or chain position',
         payload: JSON.parse(JSON.stringify(event, (_key, value) => typeof value === 'bigint' ? value.toString() : value)),
      });
      return;
   }
   const value = { ...parsed, keyId: (await resolveCreatorId(parsed.keyId)) ?? parsed.keyId };
   const previous = await persistDelegation(value);
   const wallets = [...new Set([value.delegatorWallet, value.delegateeWallet, previous].filter((wallet): wallet is string => wallet !== null))];
   await cacheInvalidate(...wallets.flatMap(wallet => [
      delegateCachePattern(wallet), delegatorsCachePattern(wallet), delegationHistoryCachePattern(wallet),
   ]));
   await invalidateKeyVotingWeightCache(value.keyId);
}

/** Mixed delegation events are processed in input chain order before checkpointing. */
export async function processVotingDelegationEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (VOTING_DELEGATION_EVENT_TYPES.has(event.eventType)) await processDelegationEvent(event);
   });
}
export async function processDelegationSetEvents(events: IndexerChainEvent[]): Promise<void> {
   await processVotingDelegationEvents(events.filter(event => DELEGATION_SET_EVENT_TYPES.has(event.eventType)));
}
export async function processDelegationRevokedEvents(events: IndexerChainEvent[]): Promise<void> {
   await processVotingDelegationEvents(events.filter(event => DELEGATION_REVOKED_EVENT_TYPES.has(event.eventType)));
}
