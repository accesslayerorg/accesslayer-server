jest.unmock('@prisma/client');
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $transaction: jest.fn(), $executeRaw: jest.fn().mockResolvedValue(1),
      campaignEvent: { findUnique: jest.fn(), create: jest.fn() },
      campaign: { findUnique: jest.fn(), upsert: jest.fn() },
      campaignEligibility: { findUnique: jest.fn(), upsert: jest.fn() },
   },
}));
jest.mock('../../utils/indexer-dlq.utils', () => ({ moveToDLQ: jest.fn() }));
jest.mock('../campaigns/campaign-read.service', () => ({ invalidateCampaignCache: jest.fn() }));
jest.mock('../../utils/logger.utils', () => ({
   logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { prisma } from '../../utils/prisma.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { invalidateCampaignCache } from '../campaigns/campaign-read.service';
import { isCampaignEvent, parseCampaignEvent, processCampaignEvent } from './campaign-indexer.service';

const wallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const event = {
   eventType: 'WalletQualified', txHash: 'campaign-tx', eventIndex: 1, ledger: 100,
   campaign_id: 1141n, wallet, score: 123n, total_score: 200n,
};

describe('seasonal-rewards event indexing', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (prisma.$transaction as jest.Mock).mockImplementation(
         (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
      );
      (prisma.campaignEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.campaignEligibility.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);
   });

   it('matches actual CampaignCreated criterion, u64 id and Unix timestamps', () => {
      expect(parseCampaignEvent({
         eventType: 'camp_new', txHash: 'created', eventIndex: 0, ledger: 100,
         campaign_id: 1141n, start_time: 1795132800n, end_time: 1795305600n,
         reward_pool: 500n, criterion: ['HoldDays'], threshold: 2n,
         key_id: 'CKEY',
      })).toMatchObject({ ok: true, value: {
         type: 'created', campaignId: '1141', criteriaType: 'HOLD_DAYS',
         rewardPool: '500', threshold: '2',
         startDate: new Date(1795132800 * 1000), endDate: new Date(1795305600 * 1000),
      } });
   });

   it('accepts qualification and claim aliases without routing unrelated short topics', () => {
      expect(parseCampaignEvent(event)).toMatchObject({ ok: true, value: { score: '123', totalScore: '200' } });
      expect(parseCampaignEvent({ ...event, eventType: 'claim', amount: 307n })).toMatchObject({
         ok: true, value: { type: 'claimed', amount: '307' },
      });
      expect(isCampaignEvent({ ...event, eventType: 'qual' })).toBe(true);
      expect(isCampaignEvent({ eventType: 'claim', txHash: 'other', eventIndex: 0 })).toBe(false);
   });

   it('rejects invalid wallet, overflowing id, fractional score and impossible total', () => {
      expect(parseCampaignEvent({ ...event, wallet: 'GBAD' }).ok).toBe(false);
      expect(parseCampaignEvent({ ...event, campaign_id: 1n << 64n }).ok).toBe(false);
      expect(parseCampaignEvent({ ...event, score: '123.5' }).ok).toBe(false);
      expect(parseCampaignEvent({ ...event, total_score: '122' }).ok).toBe(false);
      expect(parseCampaignEvent({ ...event, eventType: 'RewardClaimed', amount: '-1' }).ok).toBe(false);
   });

   it('stores qualification before campaign creation and authoritative total', async () => {
      expect(await processCampaignEvent(event)).toBe(true);
      expect(prisma.campaignEligibility.upsert).toHaveBeenCalledWith(expect.objectContaining({
         create: expect.objectContaining({ campaignId: '1141', wallet, eligible: true, score: '123' }),
      }));
      expect(prisma.campaignEvent.create).toHaveBeenCalledWith(expect.objectContaining({
         data: expect.objectContaining({ totalScore: '200' }),
      }));
      expect(invalidateCampaignCache).toHaveBeenCalledWith('1141');
   });

   it('skips replay totals and still retries cache invalidation', async () => {
      (prisma.campaignEvent.findUnique as jest.Mock).mockResolvedValue({ id: 'seen' });
      expect(await processCampaignEvent(event)).toBe(false);
      expect(prisma.campaignEligibility.upsert).not.toHaveBeenCalled();
      expect(invalidateCampaignCache).toHaveBeenCalledWith('1141');
   });

   it('does not overwrite a newer qualification', async () => {
      (prisma.campaignEligibility.findUnique as jest.Mock).mockResolvedValue({ ledger: 200, eventIndex: 1, txHash: 'newer' });
      await processCampaignEvent(event);
      expect(prisma.campaignEligibility.upsert).not.toHaveBeenCalled();
      expect(prisma.campaignEvent.create).toHaveBeenCalledTimes(1);
   });

   it('claims are terminal even when zero and remain final after a late qualification', async () => {
      await processCampaignEvent({ ...event, eventType: 'RewardClaimed', amount: '0' });
      expect(prisma.campaignEligibility.upsert).toHaveBeenCalledWith(expect.objectContaining({
         update: { claimed: true, claimedAmount: { increment: '0' } },
         create: expect.objectContaining({ claimed: true, claimedAmount: '0', eligible: false }),
      }));
      await processCampaignEvent(event);
      const second = (prisma.campaignEligibility.upsert as jest.Mock).mock.calls[1][0];
      expect(second.update).not.toHaveProperty('claimed');
      expect(second.update).not.toHaveProperty('claimedAmount');
   });

   it('quarantines malformed data and propagates database failure', async () => {
      expect(await processCampaignEvent({ ...event, wallet: 'bad' })).toBe(false);
      expect(moveToDLQ).toHaveBeenCalledTimes(1);
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('database unavailable'));
      await expect(processCampaignEvent(event)).rejects.toThrow('database unavailable');
   });
});
