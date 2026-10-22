import { processKeyPollEvents } from './key-poll-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyPoll: {
         create: jest.fn(),
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      keyPollVote: { create: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   keyPoll: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
   };
   keyPollVote: { create: jest.Mock };
};

describe('community poll indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.keyPoll.create.mockResolvedValue({});
      mockPrisma.keyPoll.findUnique.mockImplementation(({ select }) =>
         select?.status
            ? { status: 'active' }
            : { options: ['First', 'Second'] }
      );
      mockPrisma.keyPollVote.create.mockResolvedValue({});
      mockPrisma.keyPoll.update.mockResolvedValue({});
   });

   it('indexes poll creation, votes, and closure and invalidates that key cache', async () => {
      const events: IndexerChainEvent[] = [
         {
            eventType: 'PollCreated',
            txHash: 'create-tx',
            eventIndex: 0,
            keyId: 'key-1',
            pollId: 'poll-1',
            question: 'Choose',
            options: ['First', 'Second'],
            expiresAt: '2026-10-30T00:00:00.000Z',
         },
         {
            eventType: 'PollVoteCast',
            txHash: 'vote-tx',
            eventIndex: 1,
            keyId: 'key-1',
            pollId: 'poll-1',
            voter: 'G123',
            optionIndex: 1,
            weight: '12.5',
         },
         {
            eventType: 'PollClosed',
            txHash: 'close-tx',
            eventIndex: 2,
            keyId: 'key-1',
            pollId: 'poll-1',
            closedAt: '2026-10-25T00:00:00.000Z',
         },
      ];

      await processKeyPollEvents(events);

      expect(mockPrisma.keyPoll.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            pollId: 'poll-1',
            question: 'Choose',
            options: ['First', 'Second'],
         }),
      });
      expect(mockPrisma.keyPollVote.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            pollId: 'poll-1',
            wallet: 'G123',
            optionIndex: 1,
            txHash: 'vote-tx',
            eventIndex: 1,
         }),
      });
      expect(mockPrisma.keyPoll.update).toHaveBeenCalledWith({
         where: { keyId_pollId: { keyId: 'key-1', pollId: 'poll-1' } },
         data: {
            status: 'closed',
            closedAt: new Date('2026-10-25T00:00:00.000Z'),
         },
      });
      expect(cacheInvalidate).toHaveBeenCalledTimes(3);
      expect(cacheInvalidate).toHaveBeenCalledWith('key:poll*:key-1:*');
   });

   it('does not advance past a vote whose poll has not been indexed', async () => {
      mockPrisma.keyPoll.findUnique.mockResolvedValue(null);
      await expect(
         processKeyPollEvents([
            {
               eventType: 'PollVoteCast',
               txHash: 'vote-tx',
               eventIndex: 0,
               keyId: 'key-1',
               pollId: 'missing',
               wallet: 'G123',
               optionIndex: 0,
               weight: '1',
            },
         ])
      ).rejects.toThrow('PollVoteCast references unknown poll');

      expect(cacheInvalidate).not.toHaveBeenCalled();
   });
});
