// src/middlewares/region-guard.middleware.test.ts

jest.mock('../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../modules/regions/regions.service', () => {
   const actual = jest.requireActual('../modules/regions/regions.service');
   return {
      ...actual,
      getActiveRegionRules: jest.fn(),
      resolveRegionContext: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import { logger } from '../utils/logger.utils';
import {
   getActiveRegionRules,
   hashIp,
   parseDeclaredCountry,
   resolveRegionContext,
} from '../modules/regions/regions.service';
import { regionGuard, REGION_RESTRICTED_MESSAGE } from './region-guard.middleware';

const CLIENT_IP = '81.2.69.160';

const app = express();
app.get('/trade', regionGuard('key_trading'), (_req, res) => {
   res.status(200).json({ ok: true });
});

function rule(feature: string, countryCode: string, reason: string) {
   return { id: `${feature}-${countryCode}`, feature, countryCode, action: 'BLOCK', reason };
}

function context(detectedCountry: string | null, declaredCountry: string | null = null) {
   return { detectedCountry, declaredCountry, ipHash: hashIp(CLIENT_IP) };
}

describe('regionGuard', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (getActiveRegionRules as jest.Mock).mockResolvedValue([
         rule('key_trading', 'US', 'SECURITIES_RESTRICTION'),
         rule('lending', 'GB', 'LENDING_UNAVAILABLE'),
      ]);
   });

   it('returns 451 with the neutral reason code in a blocked country', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('US'));
      const res = await request(app).get('/trade');
      expect(res.status).toBe(451);
      expect(res.body).toEqual({
         success: false,
         error: {
            code: 'REGION_RESTRICTED',
            message: REGION_RESTRICTED_MESSAGE,
            details: [{ field: 'reason', message: 'SECURITIES_RESTRICTION' }],
         },
      });
   });

   it('blocks on the declared country when the detected one is allowed', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('SE', 'US'));
      expect((await request(app).get('/trade')).status).toBe(451);
   });

   it('lets the request through when no rule applies to this feature', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('GB'));
      const res = await request(app).get('/trade');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
   });

   it('rejects an invalid X-Declared-Country with 400', async () => {
      (resolveRegionContext as jest.Mock).mockImplementation(async () => parseDeclaredCountry('USA'));
      const res = await request(app).get('/trade');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });

   it('fails closed with 503 when rules cannot be loaded', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('US'));
      (getActiveRegionRules as jest.Mock).mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/trade');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
   });

   it('logs every decision with a hashed IP and never the raw address', async () => {
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('US'));
      await request(app).get('/trade');
      (resolveRegionContext as jest.Mock).mockResolvedValue(context('SE'));
      await request(app).get('/trade');

      const calls = (logger.info as jest.Mock).mock.calls;
      expect(calls.map(([fields]) => fields.decision)).toEqual(['blocked', 'allowed']);
      expect(calls[0][0]).toMatchObject({
         type: 'region_guard_decision',
         feature: 'key_trading',
         reason: 'SECURITIES_RESTRICTION',
         ipHash: hashIp(CLIENT_IP),
      });
      expect(JSON.stringify(calls)).not.toContain(CLIENT_IP);
   });
});
