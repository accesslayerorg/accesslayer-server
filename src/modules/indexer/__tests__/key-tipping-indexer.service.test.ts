// src/modules/indexer/__tests__/key-tipping-indexer.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

const prismaMock = {
   keyTip: {
      create: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

const mockInvalidateCache = jest.fn();
jest.mock('../../keys/key-tipping.service', () => ({
   invalidateKeyTipsCache: mockInvalidateCache,
}));

import {
   processKeyTippingEvents,
   TipSentChainEvent,
} from '../key-tipping-indexer.service';

describe('key-tipping-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('handles TipSent event and stores tip with amounts and message hash', async () => {
      prismaMock.keyTip.create.mockResolvedValueOnce({});

      const timestamp = '2026-05-10T14:30:00Z';
      const event: TipSentChainEvent = {
         eventType: 'TipSent',
         keyId: 'key-creator-1',
         tipper: 'GTIPPER_ALICE',
         amount: '50.5',
         messageHash: '0xmsg_hash_1',
         messageCid: 'bafy_msg_1',
         messageText: 'Keep up the amazing work!',
         txHash: '0xtx1',
         ledger: 400,
         eventIndex: 0,
         timestamp,
      };

      await processKeyTippingEvents([event]);

      expect(prismaMock.keyTip.create).toHaveBeenCalledWith({
         data: {
            keyId: 'key-creator-1',
            tipper: 'GTIPPER_ALICE',
            amount: new Decimal('50.5'),
            messageHash: '0xmsg_hash_1',
            messageCid: 'bafy_msg_1',
            messageText: 'Keep up the amazing work!',
            ledger: 400,
            txHash: '0xtx1',
            createdAt: new Date(timestamp),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-creator-1');
   });

   it('ignores unrelated event types', async () => {
      const event: any = {
         eventType: 'NON_TIP_EVENT',
         keyId: 'key-creator-2',
      };

      await processKeyTippingEvents([event]);

      expect(prismaMock.keyTip.create).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });
});
