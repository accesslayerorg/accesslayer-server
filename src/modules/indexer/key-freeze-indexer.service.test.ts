jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../freeze/freeze.service', () => ({
   indexFreezeEvent: jest.fn().mockResolvedValue(undefined),
}));

import { indexFreezeEvent } from '../freeze/freeze.service';
import { processKeyFreezeEvents } from './key-freeze-indexer.service';

const baseEvent = {
   txHash: 'tx-1',
   eventIndex: 0,
   ledger: 123,
};
const indexFreezeEventMock = indexFreezeEvent as jest.MockedFunction<
   typeof indexFreezeEvent
>;

beforeEach(() => jest.clearAllMocks());

describe('processKeyFreezeEvents', () => {
   it('indexes KeyFrozen with reason and expiry', async () => {
      await processKeyFreezeEvents([
         {
            ...baseEvent,
            eventType: 'KeyFrozen',
            keyId: 'key-1',
            reason: 'policy violation',
            expiryTimestamp: '2026-10-20T10:00:00.000Z',
         },
      ]);

      expect(indexFreezeEventMock).toHaveBeenCalledWith({
         keyId: 'key-1',
         eventType: 'FREEZE',
         ledger: 123,
         txHash: 'tx-1',
         eventIndex: 0,
         payload: {
            reason: 'policy violation',
            expiryTimestamp: '2026-10-20T10:00:00.000Z',
         },
      });
   });

   it('indexes KeyUnfrozen using creatorId when keyId is absent', async () => {
      await processKeyFreezeEvents([
         {
            ...baseEvent,
            eventType: 'KEY_UNFROZEN',
            creatorId: 'key-2',
         },
      ]);

      expect(indexFreezeEventMock).toHaveBeenCalledWith(
         expect.objectContaining({
            keyId: 'key-2',
            eventType: 'UNFREEZE',
            payload: {},
         })
      );
   });

   it('deduplicates repeats and ignores unrelated events', async () => {
      const freezeEvent = {
         ...baseEvent,
         eventType: 'KEY_FROZEN',
         keyId: 'key-1',
      };
      await processKeyFreezeEvents([
         freezeEvent,
         { ...freezeEvent },
         { ...baseEvent, eventType: 'KEY_BOUGHT', keyId: 'key-1' },
      ]);

      expect(indexFreezeEventMock).toHaveBeenCalledTimes(1);
   });

   it('skips a freeze event without a key identifier', async () => {
      await processKeyFreezeEvents([{ ...baseEvent, eventType: 'KEY_FROZEN' }]);
      expect(indexFreezeEventMock).not.toHaveBeenCalled();
   });
});
