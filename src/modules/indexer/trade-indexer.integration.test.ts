import { processTradeEvent, SorobanBuyEvent } from './trade-indexer.service';
import { logger } from '../../utils/logger.utils';

function makeMockDb() {
   const store = new Map<string, any>();

   return {
      store,
      trade: {
         findUnique: jest.fn(
            async ({
               where,
            }: {
               where: { ledger_txHash: { ledger: number; txHash: string } };
            }) => {
               const key = `${where.ledger_txHash.ledger}:${where.ledger_txHash.txHash}`;
               return store.has(key) ? store.get(key) : null;
            }
         ),
         create: jest.fn(async ({ data }: { data: any }) => {
            const key = `${data.ledger}:${data.txHash}`;
            const record = {
               id: `trade-${store.size + 1}`,
               ...data,
            };
            store.set(key, record);
            return record;
         }),
         findMany: jest.fn(async () => Array.from(store.values())),
      },
   };
}

describe('#619 Trade indexer — persisting Soroban buy events', () => {
   let mockDb: ReturnType<typeof makeMockDb>;
   let loggerWarnSpy: jest.SpyInstance;

   beforeEach(() => {
      mockDb = makeMockDb();
      loggerWarnSpy = jest
         .spyOn(logger, 'warn')
         .mockImplementation(() => logger as any);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   const validBuyEvent: SorobanBuyEvent = {
      buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
      creator_id: 'creator-xyz',
      quantity: '10',
      price: '5000',
      ledger: 1001,
      tx_hash: '0xabc123hash',
      timestamp: '2026-07-25T12:00:00.000Z',
   };

   it('creates a trade record with all six fields correct', async () => {
      const processed = await processTradeEvent(validBuyEvent, mockDb as any);

      expect(processed).toBe(true);
      expect(mockDb.trade.create).toHaveBeenCalledTimes(1);

      const records = await mockDb.trade.findMany();
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.buyer).toBe(
         'GBUYER11111111111111111111111111111111111111111111111111'
      );
      expect(record.creatorId).toBe('creator-xyz');
      expect(record.quantity).toBe('10');
      expect(record.price).toBe('5000');
      expect(record.ledger).toBe(1001);
      expect(record.timestamp).toEqual(new Date('2026-07-25T12:00:00.000Z'));
   });

   it('is idempotent — duplicate event does not create a second record', async () => {
      const firstRun = await processTradeEvent(validBuyEvent, mockDb as any);
      expect(firstRun).toBe(true);

      const secondRun = await processTradeEvent(validBuyEvent, mockDb as any);
      expect(secondRun).toBe(false);

      expect(mockDb.trade.create).toHaveBeenCalledTimes(1);
      const records = await mockDb.trade.findMany();
      expect(records).toHaveLength(1);
   });

   it('skips a malformed event missing a required field without crashing', async () => {
      const malformedEvent: Partial<SorobanBuyEvent> = {
         buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
         // creator_id missing!
         quantity: '10',
         price: '5000',
         ledger: 1002,
         tx_hash: '0xdef456hash',
         timestamp: '2026-07-25T12:00:00.000Z',
      };

      const result = await processTradeEvent(malformedEvent, mockDb as any);

      expect(result).toBe(false);
      expect(mockDb.trade.create).not.toHaveBeenCalled();

      const records = await mockDb.trade.findMany();
      expect(records).toHaveLength(0);
   });

   it('produces a warn-level log when an event is skipped', async () => {
      const malformedEvent: Partial<SorobanBuyEvent> = {
         buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
         creator_id: 'creator-xyz',
         // price missing!
         quantity: '10',
         ledger: 1003,
         tx_hash: '0x789hash',
         timestamp: '2026-07-25T12:00:00.000Z',
      };

      await processTradeEvent(malformedEvent, mockDb as any);

      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            type: 'trade_event_skipped',
            missing_fields: ['price'],
         }),
         'Skipping trade event with missing required fields'
      );
   });
});
