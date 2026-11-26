import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { StrKey } from '@stellar/stellar-base';
import { adminGuard } from '../../middlewares/admin-guard.middleware';
import {
   allowlistCsvUpload,
   httpImportKeyAllowlist,
} from './key-allowlist.controller';
import { errorHandler } from '../../middlewares/error.middleware';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyAllowlistEntry: { findMany: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn(),
   },
}));

const { prisma } = require('../../utils/prisma.utils') as {
   prisma: {
      creatorProfile: { findFirst: jest.Mock };
      keyAllowlistEntry: { findMany: jest.Mock; upsert: jest.Mock };
      $transaction: jest.Mock;
   };
};

const app = express();
app.post(
   '/admin/keys/:keyId/allowlist/import',
   adminGuard,
   allowlistCsvUpload,
   httpImportKeyAllowlist
);
app.use(errorHandler);

const KEY_ID = 'key-1';

function address(seed: number): string {
   const bytes = Buffer.alloc(32, 0);
   bytes.writeUInt32BE(seed, 28);
   return StrKey.encodeEd25519PublicKey(bytes);
}

const adminToken = jwt.sign(
   { role: 'admin', sub: 'admin-1' },
   process.env.JWT_SECRET as string
);

function postCsv(csv: Buffer | string, query = '') {
   return request(app)
      .post(`/admin/keys/${KEY_ID}/allowlist/import${query}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv), 'allowlist.csv');
}

describe('POST /admin/keys/:keyId/allowlist/import', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      prisma.creatorProfile.findFirst.mockResolvedValue({ id: KEY_ID });
      prisma.keyAllowlistEntry.findMany.mockResolvedValue([]);
      prisma.keyAllowlistEntry.upsert.mockImplementation(async (args: any) => ({
         id: 'entry',
         ...args.create,
      }));
      prisma.$transaction.mockImplementation(async (ops: any) =>
         Promise.all(ops)
      );
   });

   it('requires an admin token', async () => {
      const res = await request(app)
         .post(`/admin/keys/${KEY_ID}/allowlist/import`)
         .attach('file', Buffer.from('address\n'), 'allowlist.csv');

      expect(res.status).toBe(401);
      expect(prisma.keyAllowlistEntry.upsert).not.toHaveBeenCalled();
   });

   it('imports valid rows and returns the report', async () => {
      const csv = `address,cap\n${address(1)},5\n${address(2)},\n`;

      const res = await postCsv(csv);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
         dryRun: false,
         totalRows: 2,
         created: 2,
         updated: 0,
         skipped: 0,
         errors: [],
      });
      expect(prisma.keyAllowlistEntry.upsert).toHaveBeenCalledTimes(2);
   });

   it('writes nothing when dryRun=true', async () => {
      const csv = `address\n${address(1)}\n`;

      const res = await postCsv(csv, '?dryRun=true');

      expect(res.status).toBe(200);
      expect(res.body.data.dryRun).toBe(true);
      expect(prisma.$transaction).not.toHaveBeenCalled();
   });

   it('rejects files over 2 MB with 413', async () => {
      const big = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');

      const res = await postCsv(big);

      expect(res.status).toBe(413);
      expect(prisma.keyAllowlistEntry.upsert).not.toHaveBeenCalled();
   });

   it('rejects files with more than 5000 rows with 400', async () => {
      const csv = 'address\n' + `${address(1)}\n`.repeat(5001);

      const res = await postCsv(csv);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/5000/);
      expect(prisma.keyAllowlistEntry.upsert).not.toHaveBeenCalled();
   });

   it('returns 404 when the key does not exist', async () => {
      prisma.creatorProfile.findFirst.mockResolvedValue(null);

      const res = await postCsv(`address\n${address(1)}\n`);

      expect(res.status).toBe(404);
   });
});
