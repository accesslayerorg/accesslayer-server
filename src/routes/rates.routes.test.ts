// src/routes/rates.routes.test.ts

jest.mock('../services/fiat-rate.service', () => {
   const actual = jest.requireActual('../services/fiat-rate.service');
   return {
      ...actual,
      fiatRateService: { getRates: jest.fn() },
   };
});

import express from 'express';
import request from 'supertest';
import ratesRouter, { createXlmRatesRateLimit } from './rates.routes';
import {
   FiatRateUpstreamError,
   fiatRateService,
} from '../services/fiat-rate.service';

const FETCHED_AT = '2026-11-20T10:00:00.000Z';

const getRatesMock = fiatRateService.getRates as unknown as jest.Mock;

const app = express();
app.use('/rates', ratesRouter);

beforeEach(() => {
   getRatesMock.mockReset();
   getRatesMock.mockResolvedValue({
      base: 'XLM',
      rates: { usd: 0.42, eur: 0.39, ngn: 650.5 },
      fetchedAt: FETCHED_AT,
      stale: false,
   });
});

describe('GET /rates/xlm', () => {
   it('returns normalized quotes for every requested currency', async () => {
      const res = await request(app).get('/rates/xlm?currencies=usd,eur,ngn');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
         base: 'XLM',
         rates: { usd: 0.42, eur: 0.39, ngn: 650.5 },
         fetchedAt: FETCHED_AT,
         stale: false,
      });
      expect(getRatesMock).toHaveBeenCalledWith(['usd', 'eur', 'ngn']);
   });

   it('defaults to all supported currencies when none are requested', async () => {
      const res = await request(app).get('/rates/xlm');

      expect(res.status).toBe(200);
      expect(getRatesMock).toHaveBeenCalledWith(['usd', 'eur', 'ngn']);
   });

   it('normalizes case and de-duplicates currency codes', async () => {
      const res = await request(app).get('/rates/xlm?currencies=USD,usd,EUR');

      expect(res.status).toBe(200);
      expect(getRatesMock).toHaveBeenCalledWith(['usd', 'eur']);
   });

   it('returns 400 with a descriptive error for an unsupported currency', async () => {
      const res = await request(app).get('/rates/xlm?currencies=usd,gbp');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Unsupported currency "gbp"');
      expect(res.body.error.message).toContain('usd, eur, ngn');
      expect(res.body.error.details[0].message).toContain(
         'Unsupported currency "gbp"'
      );
      expect(getRatesMock).not.toHaveBeenCalled();
   });

   it('returns 503 when upstream fails and no cached snapshot exists', async () => {
      getRatesMock.mockRejectedValueOnce(
         new FiatRateUpstreamError('upstream unavailable')
      );

      const res = await request(app).get('/rates/xlm?currencies=usd');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
   });
});

describe('GET /rates/xlm rate limiting', () => {
   it('allows 60 requests per minute per IP and rejects the 61st', async () => {
      const limitedApp = express();
      limitedApp.use('/rates', createXlmRatesRateLimit());
      limitedApp.get('/rates/xlm', (_req, res) => {
         res.json({ ok: true });
      });

      for (let index = 0; index < 60; index += 1) {
         const allowed = await request(limitedApp).get('/rates/xlm');
         expect(allowed.status).toBe(200);
      }

      const blocked = await request(limitedApp).get('/rates/xlm');

      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.body.type).toBe('RATE_LIMIT_EXCEEDED');
   });
});
