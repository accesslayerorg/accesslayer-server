import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { processVotingDelegationEvents } from './governance-delegation-indexer.service';

jest.mock('../../utils/prisma.utils', () => {
   const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      voteDelegation: { findUnique: jest.fn(), upsert: jest.fn() },
      voteDelegationHistory: { findUnique: jest.fn(), create: jest.fn() },
      activity: { create: jest.fn().mockResolvedValue({}) },
   };
   return { prisma: { ...tx, $transaction: jest.fn(async (callback: (db: typeof tx) => unknown) => callback(tx)) } };
});
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/indexer-dlq.utils', () => ({ moveToDLQ: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../whitelist/whitelist.service', () => ({ resolveCreatorId: jest.fn().mockResolvedValue('key-1') }));

const delegator = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 71));
const delegatee = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 72));
const event = (eventType: string, ledger: number, eventIndex = 0, transactionIndex = 0) => ({
   keyId: 'alias', delegatorWallet: delegator, delegateeWallet: delegatee,
   ledger, txHash: 'delegation-' + ledger + '-' + transactionIndex,
   eventIndex, transactionIndex, eventType, occurredAt: '2026-11-21T00:00:00Z',
});
let state: Record<string, unknown> | null;
let receipts: Set<string>;
const current = prisma.voteDelegation as unknown as { findUnique: jest.Mock; upsert: jest.Mock };
const history = prisma.voteDelegationHistory as unknown as { findUnique: jest.Mock; create: jest.Mock };

describe('atomic delegation projection and voting cache', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      state = null;
      receipts = new Set();
      current.findUnique.mockImplementation(async () => state);
      current.upsert.mockImplementation(async args => {
         state = { id: 'delegation-1', ...(state ? args.update : args.create) };
         return state;
      });
      history.findUnique.mockImplementation(async args => receipts.has(
         args.where.txHash_eventIndex.txHash + ':' + args.where.txHash_eventIndex.eventIndex
      ) ? { id: 'existing' } : null);
      history.create.mockImplementation(async args => {
         receipts.add(args.data.txHash + ':' + args.data.eventIndex);
         return { id: 'receipt', ...args.data };
      });
   });

   it('canonicalizes alias events and invalidates the same key used by reads', async () => {
      await processVotingDelegationEvents([event('VotingDelegated', 10)]);
      expect(state).toMatchObject({ keyId: 'key-1', delegateeWallet: delegatee, isActive: true });
      expect(cacheInvalidate).toHaveBeenCalledWith('governance:voting-weight:key-1:*');
   });

   it('normalizes snake-case nested fields', async () => {
      await processVotingDelegationEvents([{
         eventType: 'voting_delegated', ledger: 10, txHash: 'tx', eventIndex: 0,
         timestamp: '2026-11-21T00:00:00Z',
         payload: { key_id: 'alias', delegator_wallet: delegator, delegatee_wallet: delegatee },
      }]);
      expect(state).toMatchObject({ keyId: 'key-1', delegatorWallet: delegator });
   });

   it('does not let a stale revoke remove a newer delegation', async () => {
      await processVotingDelegationEvents([event('VotingDelegated', 20), event('DelegationRevoked', 10)]);
      expect(state).toMatchObject({ ledger: 20, isActive: true });
      expect(receipts.size).toBe(2);
   });

   it('retains an unknown-delegation revoke as a tombstone against older sets', async () => {
      await processVotingDelegationEvents([event('DelegationRevoked', 20), event('VotingDelegated', 10)]);
      expect(state).toMatchObject({ ledger: 20, isActive: false });
      expect(receipts.size).toBe(2);
   });

   it('orders same-ledger updates by transaction then event index', async () => {
      await processVotingDelegationEvents([
         { ...event('VotingDelegated', 20, 2, 1), txHash: 'ledger20-tx1' },
         { ...event('DelegationRevoked', 20, 9, 0), txHash: 'ledger20-tx0' },
         { ...event('DelegationRevoked', 20, 3, 1), txHash: 'ledger20-tx1' },
         { ...event('VotingDelegated', 20, 1, 1), txHash: 'ledger20-tx1' },
      ]);
      expect(state).toMatchObject({ ledger: 20, transactionIndex: 1, eventIndex: 3, isActive: false });
   });

   it('applies distinct same-ledger transactions in stream order when transaction indices are absent', async () => {
      const { transactionIndex: _setIndex, ...set } = event('VotingDelegated', 20);
      const { transactionIndex: _revokeIndex, ...revoke } = event('DelegationRevoked', 20);
      await processVotingDelegationEvents([set, { ...revoke, txHash: 'same-ledger-second-tx' }]);
      await processVotingDelegationEvents([set]);
      expect(state).toMatchObject({ ledger: 20, transactionIndex: null, isActive: false });
      expect(current.upsert).toHaveBeenCalledTimes(2);
      expect(receipts.size).toBe(2);
   });

   it('uses event index within one transaction even without a transaction index', async () => {
      const { transactionIndex: _index, ...set } = event('VotingDelegated', 20, 2);
      const revoke = { ...set, eventType: 'DelegationRevoked', eventIndex: 1 };
      await processVotingDelegationEvents([set, revoke]);
      expect(state).toMatchObject({ isActive: true, eventIndex: 2 });
   });

   it('quarantines malformed event metadata without changing voting state', async () => {
      await processVotingDelegationEvents([{ ...event('VotingDelegated', 10), delegatorWallet: 'invalid' }]);
      expect(moveToDLQ).toHaveBeenCalled();
      expect(state).toBeNull();
      expect(receipts.size).toBe(0);
   });

   it('propagates persistence failures without caching a result', async () => {
      (prisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));
      await expect(processVotingDelegationEvents([event('VotingDelegated', 10)])).rejects.toThrow('database unavailable');
      expect(cacheInvalidate).not.toHaveBeenCalled();
   });

   it('handles replays without creating additional state changes or receipts', async () => {
      const set = event('VotingDelegated', 10);
      await processVotingDelegationEvents([set, event('DelegationRevoked', 11)]);
      await processVotingDelegationEvents([set]);
      expect(state).toMatchObject({ ledger: 11, isActive: false });
      expect(current.upsert).toHaveBeenCalledTimes(2);
      expect(receipts.size).toBe(2);
      expect(cacheInvalidate).toHaveBeenCalledWith('governance:voting-weight:key-1:*');
   });
});
