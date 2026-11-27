import { Decimal } from '@prisma/client/runtime/library';
import {
   isProtocolEscapeEvent,
   processProtocolEscapeEvents,
} from './protocol-escape-indexer.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      protocolPauseEvent: { create: jest.fn() },
      escapeRedemption: { create: jest.fn() },
   },
}));

jest.mock('../../utils/indexer-event-processor.utils', () => ({
   processIndexerChainEvents: jest.fn(
      async (events: unknown[], handler: (event: unknown) => Promise<void>) => {
         for (const event of events) {
            await handler(event);
         }
      }
   ),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const db = prisma as unknown as {
   protocolPauseEvent: { create: jest.Mock };
   escapeRedemption: { create: jest.Mock };
};

const duplicate = () =>
   Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function event(overrides: Record<string, unknown>) {
   return {
      txHash: 'tx-1',
      eventIndex: 0,
      ledger: 1000,
      ...overrides,
   };
}

describe('protocol escape indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      db.protocolPauseEvent.create.mockResolvedValue({});
      db.escapeRedemption.create.mockResolvedValue({});
   });

   it('recognises pause, unpause and escape redemption event names', () => {
      expect(isProtocolEscapeEvent(event({ eventType: 'paused' }) as never)).toBe(true);
      expect(isProtocolEscapeEvent(event({ eventType: 'unpaused' }) as never)).toBe(true);
      expect(isProtocolEscapeEvent(event({ eventType: 'escape_redeemed' }) as never)).toBe(true);
      expect(isProtocolEscapeEvent(event({ eventType: 'KEY_BOUGHT' }) as never)).toBe(false);
   });

   it('stores pause and unpause events with their kind and ledger', async () => {
      await processProtocolEscapeEvents([
         event({ eventType: 'paused' }) as never,
         event({ eventType: 'unpaused', txHash: 'tx-2' }) as never,
      ]);

      expect(db.protocolPauseEvent.create).toHaveBeenNthCalledWith(1, {
         data: expect.objectContaining({ kind: 'paused', ledger: 1000, txHash: 'tx-1' }),
      });
      expect(db.protocolPauseEvent.create).toHaveBeenNthCalledWith(2, {
         data: expect.objectContaining({ kind: 'unpaused', txHash: 'tx-2' }),
      });
   });

   it('stores an escape redemption once, skipping replays', async () => {
      const redemption = event({
         eventType: 'escape_redeemed',
         keyId: 'key-1',
         wallet: 'GWALLET',
         amount: '12.5',
      });

      await processProtocolEscapeEvents([redemption as never]);
      expect(db.escapeRedemption.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            wallet: 'GWALLET',
            amount: new Decimal('12.5'),
            txHash: 'tx-1',
         }),
      });

      db.escapeRedemption.create.mockRejectedValueOnce(duplicate());
      await expect(
         processProtocolEscapeEvents([redemption as never])
      ).resolves.toBeUndefined();
   });
});
