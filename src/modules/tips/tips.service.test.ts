import { prisma } from '../../utils/prisma.utils';
import { getTipMessageContent } from './tips.service';
import { Decimal } from '@prisma/client/runtime/library';

const mockKeyTip = prisma.keyTip as jest.Mocked<typeof prisma.keyTip>;

describe('getTipMessageContent', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      jest.useRealTimers();
      jest.spyOn(global, 'fetch');
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns null when tip does not exist', async () => {
      mockKeyTip.findFirst.mockResolvedValue(null);

      const result = await getTipMessageContent('key-1', 'tip-1');

      expect(result).toBeNull();
   });

   it('returns null when tip has no message hash', async () => {
      mockKeyTip.findFirst.mockResolvedValue({
         id: 'tip-1',
         keyId: 'key-1',
         tipper: 'tipper-1',
         amount: new Decimal(10),
         messageHash: null,
         tippedAt: new Date(),
         txHash: 'tx-1',
         createdAt: new Date(),
         ledger: null,
         eventIndex: null,
      });

      const result = await getTipMessageContent('key-1', 'tip-1');

      expect(result).toBeNull();
   });

   it('returns null when message hash is not a valid IPFS CID', async () => {
      mockKeyTip.findFirst.mockResolvedValue({
         id: 'tip-1',
         keyId: 'key-1',
         tipper: 'tipper-1',
         amount: new Decimal(10),
         messageHash: 'invalid-cid',
         tippedAt: new Date(),
         txHash: 'tx-1',
         createdAt: new Date(),
         ledger: null,
         eventIndex: null,
      });

      const result = await getTipMessageContent('key-1', 'tip-1');

      expect(result).toBeNull();
   });
});
