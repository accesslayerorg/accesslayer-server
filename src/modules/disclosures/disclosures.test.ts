import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { requireDisclosure } from '../../middlewares/require-disclosure.middleware';
import {
   disclosuresAdminRouter,
   disclosuresRouter,
} from './disclosures.routes';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      disclosureVersion: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         updateMany: jest.fn(),
         create: jest.fn(),
      },
      disclosureAcceptance: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) =>
         cb({
            disclosureVersion: prisma.disclosureVersion,
         })
      ),
   },
}));

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: req.headers['x-test-wallet'] || 'GWALLET_TRADER' };
      next();
   },
}));

jest.mock('../../middlewares/admin-guard.middleware', () => ({
   adminGuard: (req: any, _res: any, next: any) => {
      req.adminId = 'admin-1';
      next();
   },
}));

const app = express();
app.use(express.json());
app.use('/v1/disclosures', disclosuresRouter);
app.use('/v1/admin/disclosures', disclosuresAdminRouter);
app.post(
   '/v1/trading/prepare',
   (req: any, _res, next) => {
      if (req.headers['x-test-wallet']) {
         req.user = { wallet: req.headers['x-test-wallet'] };
      }
      next();
   },
   requireDisclosure(),
   (_req, res) => {
      res.status(200).json({ success: true });
   }
);

describe('Risk Disclosure Acknowledgements & Enforcement (#1318)', () => {
   const v1 = {
      id: 'ver-1',
      version: '1.0.0',
      textHash: 'sha256-v1',
      contentUrl: 'https://accesslayer.org/disclosures/1.0.0',
      isActive: true,
      publishedAt: new Date('2026-11-20T00:00:00Z'),
   };

   const v2 = {
      id: 'ver-2',
      version: '2.0.0',
      textHash: 'sha256-v2',
      contentUrl: 'https://accesslayer.org/disclosures/2.0.0',
      isActive: true,
      publishedAt: new Date('2026-11-24T00:00:00Z'),
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns 428 with requiredVersion on protected endpoints for unaccepted wallets', async () => {
      (prisma.disclosureVersion.findFirst as jest.Mock).mockResolvedValueOnce(v1);
      (prisma.disclosureAcceptance.findUnique as jest.Mock).mockResolvedValueOnce(
         null
      );

      const res = await request(app)
         .post('/v1/trading/prepare')
         .set('x-test-wallet', 'GWALLET_NEW')
         .send({});

      expect(res.status).toBe(428);
      expect(res.body.requiredVersion).toMatchObject({
         id: 'ver-1',
         version: '1.0.0',
      });
   });

   it('hashes IP and user agent with rotating salt and removes 428 restriction after acceptance', async () => {
      (prisma.disclosureVersion.findFirst as jest.Mock).mockResolvedValue(v1);
      (prisma.disclosureAcceptance.upsert as jest.Mock).mockImplementationOnce(
         ({ create }) => Promise.resolve({ id: 'acc-1', ...create })
      );

      const rawIp = '203.0.113.42';
      const rawUa = 'AccessLayerClient/2.0';

      const acceptRes = await request(app)
         .post('/v1/disclosures/accept')
         .set('x-test-wallet', 'GWALLET_TRADER')
         .set('x-forwarded-for', rawIp)
         .set('user-agent', rawUa)
         .send({ versionId: 'ver-1' });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.data.ipHash).toBeDefined();
      expect(acceptRes.body.data.ipHash).not.toContain(rawIp);
      expect(acceptRes.body.data.userAgentHash).toBeDefined();
      expect(acceptRes.body.data.userAgentHash).not.toContain(rawUa);

      // Now protected endpoint succeeds
      (prisma.disclosureAcceptance.findUnique as jest.Mock).mockResolvedValueOnce(
         { id: 'acc-1', acceptedAt: new Date() }
      );
      const tradeRes = await request(app)
         .post('/v1/trading/prepare')
         .set('x-test-wallet', 'GWALLET_TRADER')
         .send({});
      expect(tradeRes.status).toBe(200);
   });

   it('returns 409 when accepting an outdated disclosure version', async () => {
      (prisma.disclosureVersion.findFirst as jest.Mock).mockResolvedValueOnce(v2);

      const res = await request(app)
         .post('/v1/disclosures/accept')
         .set('x-test-wallet', 'GWALLET_TRADER')
         .send({ versionId: 'ver-1' });

      expect(res.status).toBe(409);
      expect(prisma.disclosureAcceptance.upsert).not.toHaveBeenCalled();
   });

   it('publishing a new version requires acceptance again', async () => {
      (prisma.disclosureVersion.findUnique as jest.Mock).mockResolvedValueOnce(
         null
      );
      (prisma.disclosureVersion.updateMany as jest.Mock).mockResolvedValueOnce({
         count: 1,
      });
      (prisma.disclosureVersion.create as jest.Mock).mockResolvedValueOnce(v2);

      const pubRes = await request(app)
         .post('/v1/admin/disclosures/versions')
         .send({
            version: '2.0.0',
            textHash: 'sha256-v2',
            contentUrl: 'https://accesslayer.org/disclosures/2.0.0',
         });

      expect(pubRes.status).toBe(201);
      expect(prisma.disclosureVersion.updateMany).toHaveBeenCalledWith({
         where: { isActive: true },
         data: { isActive: false },
      });

      // Wallet that only accepted v1 now receives 428 for v2
      (prisma.disclosureVersion.findFirst as jest.Mock).mockResolvedValueOnce(v2);
      (prisma.disclosureAcceptance.findUnique as jest.Mock).mockResolvedValueOnce(
         null
      );

      const tradeRes = await request(app)
         .post('/v1/trading/prepare')
         .set('x-test-wallet', 'GWALLET_TRADER')
         .send({});

      expect(tradeRes.status).toBe(428);
      expect(tradeRes.body.requiredVersion.version).toBe('2.0.0');
   });
});
