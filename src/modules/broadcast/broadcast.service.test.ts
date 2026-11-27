import {
   BroadcastMonthlyLimitError,
   BroadcastRecipientLimitError,
   BroadcastService,
   MAX_BROADCASTS_PER_MONTH,
   MAX_RECIPIENTS_PER_BROADCAST,
   signUnsubscribeToken,
   verifyUnsubscribeToken,
} from './broadcast.service';
import { prisma } from '../../utils/prisma.utils';
import { SendMail } from '../../utils/mail.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      broadcastConsent: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
      emailSuppression: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
      keyOwnership: {
         findMany: jest.fn(),
      },
      broadcast: {
         count: jest.fn(),
         create: jest.fn(),
         findMany: jest.fn(),
      },
      broadcastDelivery: {
         createMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/mail.utils', () => ({
   SendMail: jest.fn().mockResolvedValue(true),
}));

describe('BroadcastService', () => {
   const service = new BroadcastService();

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('requires double opt-in before a holder is eligible for broadcasts', async () => {
      ((prisma as any).broadcastConsent.upsert as jest.Mock).mockResolvedValue({
         status: 'PENDING',
      });

      const res = await service.setConsentPreference({
         userId: 'u1',
         wallet: 'GWALLET1',
         keyId: 'key-1',
         email: 'holder@example.com',
         optIn: true,
      });

      expect(res.status).toBe('PENDING');
      expect(res.confirmationRequired).toBe(true);
      expect(SendMail).toHaveBeenCalledTimes(1);

      // Only CONFIRMED consents are queried by getEligibleAudience
      ((prisma as any).broadcastConsent.findMany as jest.Mock).mockResolvedValue([]);
      const audience = await service.getEligibleAudience('key-1', 0);
      expect((prisma as any).broadcastConsent.findMany).toHaveBeenCalledWith({
         where: { keyId: 'key-1', status: 'CONFIRMED' },
      });
      expect(audience.count).toBe(0);
   });

   it('enforces 4 broadcasts per key per calendar month', async () => {
      ((prisma as any).broadcast.count as jest.Mock).mockResolvedValue(
         MAX_BROADCASTS_PER_MONTH
      );

      await expect(
         service.createBroadcast({
            creatorId: 'key-1',
            subject: 'Update #5',
            bodyHtml: '<p>Hello</p>',
         })
      ).rejects.toThrow(BroadcastMonthlyLimitError);
   });

   it('enforces 100,000 recipient limit per broadcast', async () => {
      ((prisma as any).broadcast.count as jest.Mock).mockResolvedValue(0);
      jest.spyOn(service, 'getEligibleAudience').mockResolvedValueOnce({
         count: MAX_RECIPIENTS_PER_BROADCAST + 1,
         recipients: [],
      });

      await expect(
         service.createBroadcast({
            creatorId: 'key-1',
            subject: 'Huge send',
            bodyHtml: '<p>Hello</p>',
         })
      ).rejects.toThrow(BroadcastRecipientLimitError);
   });

   it('handles signed one-click unsubscribe immediately and suppresses later sends', async () => {
      const token = signUnsubscribeToken({
         email: 'fan@example.com',
         keyId: 'key-1',
      });
      const verified = verifyUnsubscribeToken(token);
      expect(verified).toEqual({ email: 'fan@example.com', keyId: 'key-1' });

      await service.unsubscribeByToken(token);

      expect((prisma as any).emailSuppression.upsert).toHaveBeenCalledWith({
         where: { email: 'fan@example.com' },
         create: { email: 'fan@example.com', reason: 'UNSUBSCRIBE' },
         update: { reason: 'UNSUBSCRIBE' },
      });
      expect((prisma as any).broadcastConsent.updateMany).toHaveBeenCalled();
   });
});
