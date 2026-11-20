// HTTP-level tests for the realized gains endpoints (#1218).
// Prisma is mocked, so no database is required; the full Express stack
// (routing, validation, serialization, CSV streaming) is exercised.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      activityLog: { findMany: jest.fn() },
   },
}));

import request from 'supertest';
import { StrKey } from '@stellar/stellar-base';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const VALID_ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const XLM = 10_000_000n;

const tradeFindMany = prisma.trade.findMany as unknown as jest.Mock;
const logFindMany = prisma.activityLog.findMany as unknown as jest.Mock;

function seedOneSell(): void {
   tradeFindMany.mockResolvedValue([
      {
         id: 't1',
         creatorId: 'key-1',
         quantity: '10',
         price: String(2n * XLM),
         timestamp: new Date('2026-01-10T00:00:00Z'),
      },
   ]);
   logFindMany.mockResolvedValue([
      {
         id: 's1',
         keyId: 'key-1',
         amount: 12,
         payload: { quantity: 4 },
         timestamp: new Date('2026-02-01T12:00:00Z'),
      },
   ]);
}

describe('GET /api/v1/wallets/:address/gains', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns rows and totals as JSON', async () => {
      seedOneSell();
      const res = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains`)
         .query({ year: '2026' })
         .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.year).toBe(2026);
      expect(res.body.data.rows).toEqual([
         {
            date: '2026-02-01T12:00:00.000Z',
            keyId: 'key-1',
            quantity: '4',
            proceeds: '12.0000000',
            costBasis: '8.0000000',
            gain: '4.0000000',
            unmatchedQuantity: '0',
         },
      ]);
      expect(res.body.data.totals).toEqual({
         proceeds: '12.0000000',
         costBasis: '8.0000000',
         gain: '4.0000000',
         sellCount: 1,
      });
   });

   it('returns an empty rows array and zero totals when there are no sells', async () => {
      tradeFindMany.mockResolvedValue([]);
      logFindMany.mockResolvedValue([]);
      const res = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains`)
         .query({ year: '2026' })
         .expect(200);

      expect(res.body.data.rows).toEqual([]);
      expect(res.body.data.totals).toEqual({
         proceeds: '0.0000000',
         costBasis: '0.0000000',
         gain: '0.0000000',
         sellCount: 0,
      });
   });

   it.each([
      [
         'wrong prefix',
         'XBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      ],
      ['too short', 'GASHORT'],
      ['not an address', 'not-a-stellar-address'],
      [
         'bad checksum',
         VALID_ADDRESS.slice(0, -1) + (VALID_ADDRESS.endsWith('A') ? 'B' : 'A'),
      ],
   ])('returns 400 for an invalid address (%s)', async (_label, address) => {
      const res = await request(app)
         .get(`/api/v1/wallets/${address}/gains`)
         .query({ year: '2026' })
         .expect(400);
      expect(res.body.success).toBe(false);
      expect(
         res.body.error.details.some(
            (d: { field?: string }) => d.field === 'address'
         )
      ).toBe(true);
      expect(tradeFindMany).not.toHaveBeenCalled();
   });

   it.each([
      ['missing', undefined],
      ['empty', ''],
      ['non-numeric', 'abc'],
      ['too short', '202'],
      ['too long', '20266'],
      ['decimal', '2026.5'],
      ['negative', '-202'],
   ])('returns 400 for an invalid year (%s)', async (_label, year) => {
      const req = request(app).get(`/api/v1/wallets/${VALID_ADDRESS}/gains`);
      const res = await (year === undefined ? req : req.query({ year })).expect(
         400
      );
      expect(
         res.body.error.details.some(
            (d: { field?: string }) => d.field === 'year'
         )
      ).toBe(true);
      expect(tradeFindMany).not.toHaveBeenCalled();
   });

   it('returns 400 for a repeated year parameter', async () => {
      await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains?year=2025&year=2026`)
         .expect(400);
   });
});

describe('GET /api/v1/wallets/:address/gains.csv', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('streams CSV with a text/csv content type and a filename header', async () => {
      seedOneSell();
      const res = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains.csv`)
         .query({ year: '2026' })
         .buffer(true)
         .parse((r, cb) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', chunk => (data += chunk));
            r.on('end', () => cb(null, data));
         })
         .expect(200);

      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(
         `attachment; filename="gains-${VALID_ADDRESS}-2026.csv"`
      );
      expect(res.body).toBe(
         'date,key,quantity,proceeds,cost_basis,gain\r\n' +
            '2026-02-01T12:00:00.000Z,key-1,4,12.0000000,8.0000000,4.0000000\r\n'
      );
   });

   it('emits only the header row when there are no sells', async () => {
      tradeFindMany.mockResolvedValue([]);
      logFindMany.mockResolvedValue([]);
      const res = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains.csv`)
         .query({ year: '2026' })
         .buffer(true)
         .parse((r, cb) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', chunk => (data += chunk));
            r.on('end', () => cb(null, data));
         })
         .expect(200);
      expect(res.body).toBe('date,key,quantity,proceeds,cost_basis,gain\r\n');
   });

   it('neutralises spreadsheet formulas in the key column', async () => {
      tradeFindMany.mockResolvedValue([
         {
            id: 't1',
            creatorId: '=HYPERLINK("x")',
            quantity: '1',
            price: String(XLM),
            timestamp: new Date('2026-01-01T00:00:00Z'),
         },
      ]);
      logFindMany.mockResolvedValue([
         {
            id: 's1',
            keyId: '=HYPERLINK("x")',
            amount: 1,
            payload: { quantity: 1 },
            timestamp: new Date('2026-02-01T00:00:00Z'),
         },
      ]);
      const res = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains.csv`)
         .query({ year: '2026' })
         .buffer(true)
         .parse((r, cb) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', chunk => (data += chunk));
            r.on('end', () => cb(null, data));
         })
         .expect(200);
      expect(res.body).toContain('"\'=HYPERLINK(""x"")"');
   });

   it('returns 400 JSON (not CSV) for an invalid address or year', async () => {
      const badAddress = await request(app)
         .get('/api/v1/wallets/not-an-address/gains.csv')
         .query({ year: '2026' })
         .expect(400);
      expect(badAddress.headers['content-type']).toMatch(/json/);

      const badYear = await request(app)
         .get(`/api/v1/wallets/${VALID_ADDRESS}/gains.csv`)
         .query({ year: '26' })
         .expect(400);
      expect(badYear.headers['content-type']).toMatch(/json/);
      expect(badYear.headers['content-disposition']).toBeUndefined();
   });
});
