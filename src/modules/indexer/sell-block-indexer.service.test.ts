import { prisma } from '../../utils/prisma.utils';
import { invalidateReputationCache } from '../../middleware/reputation/reputation.service';
import { processSellBlockEvents } from './sell-block-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      sellBlock: { create: jest.fn() },
   },
}));

jest.mock('../../middleware/reputation/reputation.service', () => ({
   invalidateReputationCache: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
   },
}));

const mockCreateSellBlock = prisma.sellBlock.create as jest.Mock;
const mockInvalidateReputationCache = invalidateReputationCache as jest.Mock;

function sellBlockEvent(
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent {
   return {
      eventType: 'same_ledger_sell_blocked',
      txHash: 'tx-sell-block',
      eventIndex: 2,
      ledger: 900,
      wallet: 'GSELLER',
      keyId: 'GKEY',
      amount: 4n,
      ...overrides,
   };
}

describe('processSellBlockEvents', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCreateSellBlock.mockResolvedValue({});
   });

   it('persists all event fields and invalidates the wallet score cache', async () => {
      await processSellBlockEvents([sellBlockEvent()]);

      expect(mockCreateSellBlock).toHaveBeenCalledWith({
         data: {
            wallet: 'GSELLER',
            keyId: 'GKEY',
            amount: '4',
            ledger: 900,
            txHash: 'tx-sell-block',
            eventIndex: 2,
         },
      });
      expect(mockInvalidateReputationCache).toHaveBeenCalledWith('GSELLER');
   });

   it('treats a replayed event as a no-op', async () => {
      mockCreateSellBlock.mockRejectedValueOnce(
         Object.assign(new Error('duplicate'), { code: 'P2002' })
      );

      await expect(
         processSellBlockEvents([sellBlockEvent()])
      ).resolves.toBeUndefined();

      expect(mockCreateSellBlock).toHaveBeenCalledTimes(1);
      expect(mockInvalidateReputationCache).not.toHaveBeenCalled();
   });

   it('skips events missing required data', async () => {
      await processSellBlockEvents([sellBlockEvent({ wallet: undefined })]);

      expect(mockCreateSellBlock).not.toHaveBeenCalled();
   });

   it('does not process unrelated events', async () => {
      await processSellBlockEvents([sellBlockEvent({ eventType: 'KEY_SOLD' })]);

      expect(mockCreateSellBlock).not.toHaveBeenCalled();
   });
});
