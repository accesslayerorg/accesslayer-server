jest.unmock('@prisma/client');
jest.mock('../../utils/prisma.utils', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../utils/redis.utils', () => ({ cacheInvalidate: jest.fn() }));
jest.mock('../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn(async (keyId: string) => keyId),
}));

import { StrKey } from '@stellar/stellar-base';
import { resolveCreatorId } from '../whitelist/whitelist.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { processMarketplaceEvents } from './marketplace-indexer.service';
import { MARKETPLACE_CACHE_KEY } from '../marketplaces/marketplace.service';

const mockTx = {
   marketplaceRegistryEvent: { createMany: jest.fn() },
   approvedMarketplace: { upsert: jest.fn(), updateMany: jest.fn() },
   keyRoyaltyEnforcement: { upsert: jest.fn(), updateMany: jest.fn() },
};
const event = (eventType: string, extras: Record<string, unknown> = {}) => ({
   eventType, txHash: 'a'.repeat(64), eventIndex: 0, ledger: 100,
   address: StrKey.encodeContract(Buffer.alloc(32, 1)), occurredAt: '2026-11-21T12:00:00Z',
   ...extras,
});

describe('marketplace registry indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
      mockTx.marketplaceRegistryEvent.createMany.mockResolvedValue({ count: 1 });
      mockTx.approvedMarketplace.updateMany.mockResolvedValue({ count: 1 });
      mockTx.keyRoyaltyEnforcement.updateMany.mockResolvedValue({ count: 1 });
   });

   it('records approval then revocation and invalidates the registry cache', async () => {
      await processMarketplaceEvents([
         event('marketplace_approved'),
         event('marketplace_revoked', { eventIndex: 1 }),
      ]);
      expect(mockTx.approvedMarketplace.updateMany.mock.calls[0][0].data.approved).toBe(true);
      expect(mockTx.approvedMarketplace.updateMany.mock.calls[1][0].data.approved).toBe(false);
      expect(cacheInvalidate).toHaveBeenCalledWith(MARKETPLACE_CACHE_KEY);
   });

   it('does not modify state when an event is replayed', async () => {
      mockTx.marketplaceRegistryEvent.createMany.mockResolvedValue({ count: 0 });
      await processMarketplaceEvents([event('marketplace_approved')]);
      expect(mockTx.approvedMarketplace.upsert).not.toHaveBeenCalled();
      expect(mockTx.approvedMarketplace.updateMany).not.toHaveBeenCalled();
   });

   it('stores both royalty enforcement flags and gates updates on chain order', async () => {
      await processMarketplaceEvents([event('royalty_enforcement_set', {
         keyId: 'key-1', royaltyEnforced: true, locked: true, transactionIndex: 2,
      })]);
      const args = mockTx.keyRoyaltyEnforcement.updateMany.mock.calls[0][0];
      expect(args.data).toMatchObject({
         royaltyEnforced: true, locked: true, ledger: 100, transactionIndex: 2, eventIndex: 0,
      });
      expect(args.where).toMatchObject({ keyId: 'key-1', OR: expect.any(Array) });
   });

   it('normalizes a handle before writing enforcement state', async () => {
      (resolveCreatorId as jest.Mock).mockResolvedValueOnce('canonical-key');
      await processMarketplaceEvents([event('royalty_enforcement_set', {
         keyId: 'creator-handle', royaltyEnforced: true, locked: false,
      })]);
      expect(mockTx.keyRoyaltyEnforcement.updateMany.mock.calls[0][0].data.keyId).toBe('canonical-key');
   });

   it('accepts snake_case enforcement identifiers and rejects invalid address checksums', async () => {
      await processMarketplaceEvents([event('royalty_enforcement_set', {
         key_id: 'snake-key', royalty_enforced: true, is_locked: false,
      })]);
      expect(mockTx.keyRoyaltyEnforcement.updateMany.mock.calls[0][0].data.keyId).toBe('snake-key');
      await expect(processMarketplaceEvents([event('marketplace_approved', {
         address: 'C' + 'A'.repeat(55),
      })])).rejects.toThrow('Invalid Stellar account or contract address');
   });

   it('guards same-transaction state against lower event indexes without a transaction index', async () => {
      await processMarketplaceEvents([event('marketplace_revoked', { eventIndex: 1 })]);
      const args = mockTx.approvedMarketplace.updateMany.mock.calls[0][0];
      expect(args.where.OR).toContainEqual({
         ledger: 100, txHash: 'a'.repeat(64), eventIndex: { lt: 1 },
      });
      expect(args.where.OR).not.toContainEqual({ ledger: { lte: 100 } });
   });

   it('propagates database failures so the ledger checkpoint cannot advance', async () => {
      mockTx.marketplaceRegistryEvent.createMany.mockRejectedValue(new Error('database down'));
      await expect(processMarketplaceEvents([event('marketplace_approved')]))
         .rejects.toThrow('database down');
   });

   it('rejects malformed recognised events instead of recording an incomplete state', async () => {
      await expect(processMarketplaceEvents([event('royalty_enforcement_set', {
         keyId: 'key-1', royaltyEnforced: 'false', locked: true,
      })])).rejects.toThrow();
      expect(prisma.$transaction).not.toHaveBeenCalled();
   });
});
