// src/modules/keys/key-swap-fee.routes.test.ts

import { KeyNotFoundError } from './key-fees.service';

jest.mock('./key-swap-fee.service', () => ({
   getSwapFeeTier: jest.fn(),
   getKeyFeeHistory: jest.fn(),
   KeyNotFoundError: jest.requireActual('./key-fees.service').KeyNotFoundError,
}));

import express from 'express';
import request from 'supertest';
import keysRouter from './keys.routes';
import { getSwapFeeTier, getKeyFeeHistory } from './key-swap-fee.service';

const mockGetSwapFeeTier = getSwapFeeTier as jest.Mock;
const mockGetKeyFeeHistory = getKeyFeeHistory as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);
app.use('/keys', keysRouter);

describe('Key Swap Fee Routes', () => {
   const KEY_ID = 'key-uuid-1';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /keys/:keyId/fee and /api/v1/keys/:keyId/fee', () => {
      it('returns correct fee bps, volume bracket, and 24h volume', async () => {
         const mockData = {
            current_fee_bps: 400,
            volume_bracket: 'TIER_2',
            rolling_24h_volume: '1500000000',
         };
         mockGetSwapFeeTier.mockResolvedValue(mockData);

         // Test /api/v1/keys/:keyId/fee
         const res1 = await request(app).get(`/api/v1/keys/${KEY_ID}/fee`);
         expect(res1.status).toBe(200);
         expect(res1.body.success).toBe(true);
         expect(res1.body.data).toEqual(mockData);

         // Test /keys/:keyId/fee
         const res2 = await request(app).get(`/keys/${KEY_ID}/fee`);
         expect(res2.status).toBe(200);
         expect(res2.body.success).toBe(true);
         expect(res2.body.data).toEqual(mockData);

         expect(mockGetSwapFeeTier).toHaveBeenCalledWith(KEY_ID);
      });

      it('returns 404 for unknown key IDs', async () => {
         mockGetSwapFeeTier.mockRejectedValue(
            new KeyNotFoundError('unknown-key')
         );

         const res = await request(app).get('/api/v1/keys/unknown-key/fee');
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
      });
   });

   describe('GET /keys/:keyId/fee/history and /api/v1/keys/:keyId/fee/history', () => {
      it('returns fee tier change history with timestamps', async () => {
         const mockHistory = [
            {
               id: 'hist-1',
               key_id: KEY_ID,
               keyId: KEY_ID,
               fee_bps: 400,
               feeBps: 400,
               current_fee_bps: 400,
               previous_fee_bps: 500,
               previousFeeBps: 500,
               volume_bracket: 'TIER_2',
               volumeBracket: 'TIER_2',
               rolling_24h_volume: '1500000000',
               rolling24hVolume: '1500000000',
               ledger: 100,
               tx_hash: '0x123',
               txHash: '0x123',
               event_index: 0,
               eventIndex: 0,
               timestamp: '2026-10-17T12:00:00.000Z',
               created_at: '2026-10-17T12:00:00.000Z',
            },
         ];
         mockGetKeyFeeHistory.mockResolvedValue(mockHistory);

         // Test /api/v1/keys/:keyId/fee/history
         const res1 = await request(app).get(
            `/api/v1/keys/${KEY_ID}/fee/history`
         );
         expect(res1.status).toBe(200);
         expect(res1.body.success).toBe(true);
         expect(res1.body.data).toEqual(mockHistory);

         // Test /keys/:keyId/fee/history
         const res2 = await request(app).get(`/keys/${KEY_ID}/fee/history`);
         expect(res2.status).toBe(200);
         expect(res2.body.success).toBe(true);
         expect(res2.body.data).toEqual(mockHistory);

         expect(mockGetKeyFeeHistory).toHaveBeenCalledWith(KEY_ID, {
            limit: 50,
            offset: 0,
         });
      });

      it('supports custom limit and offset query parameters', async () => {
         mockGetKeyFeeHistory.mockResolvedValue([]);

         await request(app).get(
            `/api/v1/keys/${KEY_ID}/fee/history?limit=10&offset=5`
         );

         expect(mockGetKeyFeeHistory).toHaveBeenCalledWith(KEY_ID, {
            limit: 10,
            offset: 5,
         });
      });

      it('returns 404 for unknown key IDs in fee history', async () => {
         mockGetKeyFeeHistory.mockRejectedValue(
            new KeyNotFoundError('unknown-key')
         );

         const res = await request(app).get(
            '/api/v1/keys/unknown-key/fee/history'
         );
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
      });
   });
});
