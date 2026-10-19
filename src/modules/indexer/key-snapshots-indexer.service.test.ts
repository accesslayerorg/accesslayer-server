import {
   processKeySnapshotEvents,
   isKeySnapshotEventType,
 } from './key-snapshots-indexer.service';
 import { prisma } from '../../utils/prisma.utils';
 import * as keySnapshotsService from '../keys/key-snapshots.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keySnapshot: {
         create: jest.fn(),
      },
   },
}));

jest.mock('../keys/key-snapshots.service', () => ({
   invalidateKeySnapshotsCache: jest.fn().mockResolvedValue(undefined),
}));

describe('key-snapshots-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('isKeySnapshotEventType', () => {
      it('correctly identifies SnapshotTaken events', () => {
         expect(isKeySnapshotEventType('SnapshotTaken')).toBe(true);
         expect(isKeySnapshotEventType('SNAPSHOT_TAKEN')).toBe(true);
         expect(isKeySnapshotEventType('KEY_SNAPSHOT_TAKEN')).toBe(true);
         expect(isKeySnapshotEventType('KEY_BOUGHT')).toBe(false);
         expect(isKeySnapshotEventType('OTHER_EVENT')).toBe(false);
      });
   });

   describe('processKeySnapshotEvents', () => {
      it('creates key_snapshots record with all metrics and invalidates cache', async () => {
         const date = new Date('2026-10-19T10:00:00Z');
         const event = {
            eventType: 'SnapshotTaken',
            keyId: 'creator-key-1',
            date: date.toISOString(),
            price: '12.5000000',
            volume: '1500.0000000',
            holderCount: 42,
            marketCap: '125000.0000000',
            txHash: '0xsnap1',
            ledger: 6001,
            eventIndex: 0,
         };

         (prisma as any).keySnapshot.create.mockResolvedValue({ id: 'snap-1' });

         await processKeySnapshotEvents([event as any]);

         expect((prisma as any).keySnapshot.create).toHaveBeenCalledWith({
            data: {
               keyId: 'creator-key-1',
               date,
               price: '12.5000000',
               volume: '1500.0000000',
               holderCount: 42,
               marketCap: '125000.0000000',
               txHash: '0xsnap1',
               blockNumber: BigInt(6001),
            },
         });

         expect(keySnapshotsService.invalidateKeySnapshotsCache).toHaveBeenCalledWith('creator-key-1');
      });

      it('handles snake_case metric names in event payload', async () => {
         const event = {
            eventType: 'SnapshotTaken',
            creatorId: 'creator-key-2',
            price: '5.0',
            volume: '300.0',
            holder_count: 10,
            market_cap: '50000.0',
            txHash: '0xsnap2',
            eventIndex: 1,
         };

         (prisma as any).keySnapshot.create.mockResolvedValue({ id: 'snap-2' });

         await processKeySnapshotEvents([event as any]);

         expect((prisma as any).keySnapshot.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               keyId: 'creator-key-2',
               price: '5.0',
               volume: '300.0',
               holderCount: 10,
               marketCap: '50000.0',
            }),
         });
         expect(keySnapshotsService.invalidateKeySnapshotsCache).toHaveBeenCalledWith('creator-key-2');
      });

      it('skips event with missing keyId', async () => {
         const malformed = {
            eventType: 'SnapshotTaken',
            price: '10',
            txHash: '0xbad',
            eventIndex: 2,
         };

         await processKeySnapshotEvents([malformed as any]);
         expect((prisma as any).keySnapshot.create).not.toHaveBeenCalled();
      });
   });
});
