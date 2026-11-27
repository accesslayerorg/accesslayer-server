import {
   isTokenRescueEvent,
   parseTokenRescueThreshold,
   processTokenRescueEvents,
   setLargeTokenRescueAlertSender,
} from './token-rescue-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { tokenRescue: { create: jest.fn() } },
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

jest.mock('../../config', () => ({
   envConfig: { TOKEN_RESCUE_ALERT_THRESHOLD: undefined },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockCreate = (
   prisma as unknown as { tokenRescue: { create: jest.Mock } }
).tokenRescue.create;
const mockConfig = envConfig as unknown as {
   TOKEN_RESCUE_ALERT_THRESHOLD?: string;
};
const sender = jest.fn();

function rescueEvent(overrides: Record<string, unknown> = {}) {
   return {
      eventType: 'rescued',
      txHash: 'tx-1',
      eventIndex: 0,
      ledger: 500,
      token: 'CTOKEN',
      recipient: 'GRECIPIENT',
      admin: 'GADMIN',
      amount: '5000',
      ...overrides,
   };
}

describe('token rescue indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      sender.mockResolvedValue(undefined);
      setLargeTokenRescueAlertSender(sender);
      mockCreate.mockResolvedValue({});
      mockConfig.TOKEN_RESCUE_ALERT_THRESHOLD = '1000';
   });

   afterAll(() => {
      setLargeTokenRescueAlertSender(null);
   });

   it('stores each rescue with its fields and a bigint amount', async () => {
      await processTokenRescueEvents([rescueEvent()]);

      expect(mockCreate).toHaveBeenCalledWith({
         data: {
            token: 'CTOKEN',
            recipient: 'GRECIPIENT',
            amount: 5000n,
            admin: 'GADMIN',
            ledger: 500,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });
   });

   it('does not alert when the amount is at or below the threshold', async () => {
      await processTokenRescueEvents([rescueEvent({ amount: '1000' })]);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(sender).not.toHaveBeenCalled();
   });

   it('sends a single alert for a large rescue and none for a replayed event', async () => {
      await processTokenRescueEvents([rescueEvent()]);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender).toHaveBeenCalledWith(
         expect.objectContaining({
            event: 'token_rescue_above_threshold',
            token: 'CTOKEN',
            amount: '5000',
            threshold: '1000',
            txHash: 'tx-1',
         })
      );

      mockCreate.mockRejectedValueOnce(
         Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      );
      await processTokenRescueEvents([rescueEvent()]);

      expect(sender).toHaveBeenCalledTimes(1);
   });

   it('does not alert when no threshold is configured', async () => {
      mockConfig.TOKEN_RESCUE_ALERT_THRESHOLD = undefined;

      await processTokenRescueEvents([rescueEvent()]);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(sender).not.toHaveBeenCalled();
   });

   it('rejects an event whose amount is not an integer', async () => {
      await expect(
         processTokenRescueEvents([rescueEvent({ amount: '12.5' })])
      ).rejects.toThrow('invalid amount');
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('parses the threshold and treats invalid values as disabled', () => {
      expect(parseTokenRescueThreshold(undefined)).toBeNull();
      expect(parseTokenRescueThreshold('   ')).toBeNull();
      expect(parseTokenRescueThreshold('not-a-number')).toBeNull();
      expect(parseTokenRescueThreshold('100')).toBe(100n);
   });

   it('recognises the rescue event names', () => {
      expect(isTokenRescueEvent(rescueEvent({ eventType: 'TokenRescued' }) as never)).toBe(true);
      expect(isTokenRescueEvent(rescueEvent({ eventType: 'PAUSED' }) as never)).toBe(false);
   });
});
