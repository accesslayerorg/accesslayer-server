import { BroadcastWorker } from './broadcast.worker';
import { broadcastService } from './broadcast.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      broadcast: {
         findMany: jest.fn(),
         update: jest.fn(),
      },
      broadcastDelivery: {
         findMany: jest.fn(),
         update: jest.fn(),
      },
      broadcastConsent: {
         findFirst: jest.fn(),
      },
   },
}));

describe('BroadcastWorker', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('checks suppression list before every send, handles bounces, and updates stats', async () => {
      ((prisma as any).broadcastDelivery.findMany as jest.Mock).mockResolvedValue([
         {
            id: 'd1',
            consentId: 'c1',
            recipientEmail: 'suppressed@example.com',
            wallet: 'W1',
         },
         {
            id: 'd2',
            consentId: 'c2',
            recipientEmail: 'ok@example.com',
            wallet: 'W2',
         },
         {
            id: 'd3',
            consentId: 'c3',
            recipientEmail: 'bounced@example.com',
            wallet: 'W3',
         },
      ]);

      ((prisma as any).broadcastConsent.findFirst as jest.Mock).mockResolvedValue({
         status: 'CONFIRMED',
      });

      jest
         .spyOn(broadcastService, 'isEmailSuppressed')
         .mockImplementation(async (email) => email === 'suppressed@example.com');
      const suppressSpy = jest
         .spyOn(broadcastService, 'suppressEmail')
         .mockResolvedValue();

      const mockSendMail = jest.fn(async ({ to }: { to: string }) => {
         if (to === 'bounced@example.com') {
            throw new Error('550 Hard bounce');
         }
         return true;
      });

      const worker = new BroadcastWorker(mockSendMail, 2, 3);
      const stats = await worker.processBroadcast({
         id: 'b1',
         creatorId: 'key-1',
         subject: 'Hello holders',
         bodyHtml: '<p>News</p>',
      });

      expect(stats).toEqual({
         sentCount: 1,
         failedCount: 0,
         bouncedCount: 1,
         suppressedCount: 1,
      });

      expect(mockSendMail).toHaveBeenCalledTimes(2);
      expect(suppressSpy).toHaveBeenCalledWith('bounced@example.com', 'BOUNCE');
      expect((prisma as any).broadcast.update).toHaveBeenLastCalledWith({
         where: { id: 'b1' },
         data: expect.objectContaining({
            status: 'COMPLETED',
            sentCount: 1,
            failedCount: 0,
            bouncedCount: 1,
            suppressedCount: 1,
         }),
      });
   });
});
