jest.unmock('@prisma/client');
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
import express from 'express';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import campaignsRouter from './campaigns.routes';
import { processCampaignEvent } from '../indexer/campaign-indexer.service';

const describeDatabase = process.env.RUN_CAMPAIGN_INTEGRATION === '1' ? describe : describe.skip;
const campaignId = '114101';
const wallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const secondWallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const app = express();
app.use('/campaigns', campaignsRouter);

describeDatabase('campaign events to REST against PostgreSQL', () => {
   beforeAll(async () => {
      await prisma.campaignEligibility.deleteMany({ where: { campaignId } });
      await prisma.campaignEvent.deleteMany({ where: { campaignId } });
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
      await processCampaignEvent({
         eventType: 'camp_new', txHash: 'campaign-created-http', eventIndex: 0, ledger: 100,
         campaign_id: campaignId, name: 'HTTP campaign', criterion: 'Trades',
         threshold: '3', reward_pool: '100', start_time: 1767225600,
         end_time: 1790812800,
      });
      await processCampaignEvent({
         eventType: 'qual', txHash: 'campaign-qualified-http', eventIndex: 0, ledger: 101,
         campaign_id: campaignId, wallet, score: '4', total_score: '4',
      });
      await processCampaignEvent({
         eventType: 'qual', txHash: 'campaign-qualified-http-second', eventIndex: 0, ledger: 102,
         campaign_id: campaignId, wallet: secondWallet, score: '6', total_score: '10',
      });
      const claim = {
         eventType: 'claim', txHash: 'campaign-claimed-http', eventIndex: 0, ledger: 103,
         campaign_id: campaignId, wallet, amount: '40',
      };
      await processCampaignEvent(claim);
      await processCampaignEvent(claim);
   });

   afterAll(async () => {
      await prisma.campaignEligibility.deleteMany({ where: { campaignId } });
      await prisma.campaignEvent.deleteMany({ where: { campaignId } });
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
   });

   it('serves criteria, temporal status and raw token reward pool', async () => {
      const response = await request(app).get('/campaigns?limit=100');
      expect(response.status).toBe(200);
      expect(response.body.data.items).toContainEqual(expect.objectContaining({
         campaign_id: campaignId, reward_pool: '100', status: 'ended',
         criteria: expect.objectContaining({ type: 'TRADE_COUNT', threshold: '3' }),
      }));
   });

   it('returns progress, eligibility and one-time claim state without replay double counting', async () => {
      const response = await request(app).get('/campaigns/' + campaignId + '/eligibility/' + wallet);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
         eligible: true, claimed: true, claimed_amount: '40', claimable_amount: '0',
         criteria_progress: { score: '4', threshold: '3', total_score: '10' },
      });
      const second = await request(app).get('/campaigns/' + campaignId + '/eligibility/' + secondWallet);
      expect(second.body.data).toMatchObject({ claimed: false, claimable_amount: '60' });
   });

   it('ranks wallets and rejects invalid wallet/checksum and pagination', async () => {
      const response = await request(app).get('/campaigns/' + campaignId + '/leaderboard');
      expect(response.status).toBe(200);
      expect(response.body.data.items).toMatchObject([
         { rank: 1, wallet: secondWallet, score: '6' }, { rank: 2, wallet, score: '4' },
      ]);
      expect((await request(app).get('/campaigns/' + campaignId + '/eligibility/bad')).status).toBe(400);
      expect((await request(app).get('/campaigns?limit=0')).status).toBe(400);
      expect((await request(app).get('/campaigns/missing/eligibility/' + wallet)).status).toBe(404);
   });
});
