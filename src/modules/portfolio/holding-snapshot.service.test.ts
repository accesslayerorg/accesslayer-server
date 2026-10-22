// Unit tests: holdings snapshots taken on each trade event (#1008).
// - the writer records the post-trade balance and never throws
// - the ownership trade paths (buy/sell) write a snapshot after updating the
//   balance, which is what GET /portfolio/history replays

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
      },
      walletHoldingSnapshot: { create: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { recordHoldingSnapshot } from './holding-snapshot.service';
import {
   recordKeyPurchase,
   recordKeySale,
} from '../ownership/ownership.service';

const snapshotCreate = prisma.walletHoldingSnapshot.create as jest.Mock;
const ownershipFindUnique = prisma.keyOwnership.findUnique as jest.Mock;
const ownershipUpsert = prisma.keyOwnership.upsert as jest.Mock;
const ownershipUpdate = prisma.keyOwnership.update as jest.Mock;

const WALLET = `G${'A'.repeat(55)}`;
const BOUGHT_AT = new Date('2026-10-16T09:30:00.000Z');
const SOLD_AT = new Date('2026-10-16T10:30:00.000Z');

beforeEach(() => {
   jest.clearAllMocks();
   snapshotCreate.mockResolvedValue({});
});

describe('recordHoldingSnapshot', () => {
   it('records the post-trade balance for the wallet and key', async () => {
      await recordHoldingSnapshot({
         ownerAddress: WALLET,
         creatorId: 'key-a',
         balance: 12.5,
         recordedAt: BOUGHT_AT,
      });

      expect(snapshotCreate).toHaveBeenCalledWith({
         data: {
            ownerAddress: WALLET,
            creatorId: 'key-a',
            balance: 12.5,
            recordedAt: BOUGHT_AT,
         },
      });
   });

   it('defaults recordedAt to now when the caller has no trade timestamp', async () => {
      const before = Date.now();
      await recordHoldingSnapshot({
         ownerAddress: WALLET,
         creatorId: 'key-a',
         balance: 1,
      });
      const after = Date.now();

      const { recordedAt } = snapshotCreate.mock.calls[0][0].data;
      expect(recordedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(recordedAt.getTime()).toBeLessThanOrEqual(after);
   });

   it('writes through the caller transaction when one is supplied', async () => {
      const tx = { walletHoldingSnapshot: { create: jest.fn() } };
      await recordHoldingSnapshot({
         ownerAddress: WALLET,
         creatorId: 'key-a',
         balance: 3,
         recordedAt: SOLD_AT,
         db: tx,
      });

      expect(tx.walletHoldingSnapshot.create).toHaveBeenCalledWith({
         data: {
            ownerAddress: WALLET,
            creatorId: 'key-a',
            balance: 3,
            recordedAt: SOLD_AT,
         },
      });
      expect(snapshotCreate).not.toHaveBeenCalled();
   });

   it('never throws when the snapshot write fails', async () => {
      snapshotCreate.mockRejectedValue(new Error('db down'));

      await expect(
         recordHoldingSnapshot({
            ownerAddress: WALLET,
            creatorId: 'key-a',
            balance: 1,
         })
      ).resolves.toBeUndefined();
   });

   it('skips invalid input instead of writing a broken row', async () => {
      await recordHoldingSnapshot({
         ownerAddress: WALLET,
         creatorId: 'key-a',
         balance: Number.NaN,
      });

      expect(snapshotCreate).not.toHaveBeenCalled();
   });
});

describe('trade paths write a holdings snapshot', () => {
   it('snapshots the balance after a buy', async () => {
      ownershipFindUnique.mockResolvedValue({ balance: 5, costBasis: 1 });
      ownershipUpsert.mockResolvedValue({ balance: 15 });

      const updated = await recordKeyPurchase(
         WALLET,
         'key-a',
         10,
         2,
         BOUGHT_AT
      );

      expect(updated.balance).toBe(15);
      expect(snapshotCreate).toHaveBeenCalledWith({
         data: {
            ownerAddress: WALLET,
            creatorId: 'key-a',
            balance: 15,
            recordedAt: BOUGHT_AT,
         },
      });
   });

   it('snapshots the balance after a sell', async () => {
      ownershipFindUnique.mockResolvedValue({
         balance: 10,
         costBasis: 1,
         realisedPnl: 0,
      });
      ownershipUpdate.mockResolvedValue({ balance: 4 });

      const updated = await recordKeySale(
         WALLET,
         'key-a',
         6,
         2,
         SOLD_AT
      );

      expect(updated.balance).toBe(4);
      expect(snapshotCreate).toHaveBeenCalledWith({
         data: {
            ownerAddress: WALLET,
            creatorId: 'key-a',
            balance: 4,
            recordedAt: SOLD_AT,
         },
      });
   });

   it('keeps the trade successful when the snapshot write fails', async () => {
      ownershipFindUnique.mockResolvedValue({ balance: 5, costBasis: 1 });
      ownershipUpsert.mockResolvedValue({ balance: 15 });
      snapshotCreate.mockRejectedValue(new Error('db down'));

      const updated = await recordKeyPurchase(
         WALLET,
         'key-a',
         10,
         2,
         BOUGHT_AT
      );

      expect(updated.balance).toBe(15);
   });
});
