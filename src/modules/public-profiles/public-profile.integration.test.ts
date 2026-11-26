jest.unmock('@prisma/client');

// Real database and real JWT verification for the public portfolio profile API
// (#1355). Run with RUN_PUBLIC_PROFILE_INTEGRATION=1 against a disposable
// database prepared with `pnpm exec prisma db push`.

import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { publicProfileMeRouter, publicProfilesRouter } from './public-profile.routes';

const describeDatabase =
   process.env.RUN_PUBLIC_PROFILE_INTEGRATION === '1' ? describe : describe.skip;

const run = randomUUID().slice(0, 8);
const owner = `GPROFILEOWNER${run.toUpperCase()}`;
const rival = `GPROFILERIVAL${run.toUpperCase()}`;
const userId = `pp-user-${run}`;
const keyId = `pp-key-${run}`;
const handle = `owner_${run}`;

const app = express();
app.use(express.json());
app.use('/v1/me', publicProfileMeRouter);
app.use('/v1/public', publicProfilesRouter);

function bearer(wallet: string) {
   return { Authorization: `Bearer ${signWalletAccessToken(wallet)}` };
}

describeDatabase('public portfolio profiles against a real database', () => {
   beforeAll(async () => {
      await prisma.user.create({
         data: {
            id: userId,
            email: `${userId}@example.test`,
            passwordHash: 'integration-fixture',
            firstName: 'Profile',
            lastName: 'Owner',
         },
      });
      await prisma.stellarWallet.create({
         data: { address: owner, userId, createdAt: new Date('2026-02-03T10:00:00Z') },
      });
      await prisma.creatorProfile.create({
         data: {
            id: keyId,
            userId,
            handle: `creator_${run}`,
            displayName: 'Profile fixture key',
            circulatingSupply: 40,
         },
      });
      await prisma.keyOwnership.create({
         data: { ownerAddress: owner, creatorId: keyId, balance: 5, costBasis: 1, realisedPnl: 2 },
      });
   });

   afterAll(async () => {
      await prisma.publicProfile.deleteMany({ where: { wallet: { in: [owner, rival] } } });
      await prisma.keyOwnership.deleteMany({ where: { creatorId: keyId } });
      await prisma.creatorProfile.deleteMany({ where: { id: keyId } });
      await prisma.stellarWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
   });

   it('registers a profile that stays private until fields are enabled', async () => {
      const created = await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(owner))
         .send({ handle: handle.toUpperCase(), enabled: true });

      expect(created.status).toBe(200);
      expect(created.body.data.profile.handle).toBe(handle);

      const stored = await prisma.publicProfile.findUnique({ where: { wallet: owner } });
      expect(stored).toMatchObject({
         handle,
         enabled: true,
         showHoldings: false,
         showWallet: false,
         showExactAmounts: false,
      });

      const view = await request(app).get(`/v1/public/profiles/${handle}`);
      expect(view.status).toBe(200);
      expect(view.body.data.profile).toEqual({ handle });
      expect(view.text).not.toContain(owner);
   });

   it('publishes ranges, then exact values, from the real portfolio', async () => {
      await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(owner))
         .send({ handle, showHoldings: true, showPnl: true, showKeyCount: true, showJoined: true })
         .expect(200);

      const ranged = (await request(app).get(`/v1/public/profiles/${handle}`)).body.data.profile;
      expect(ranged.keyCount).toEqual({ min: 1, max: 5 });
      expect(ranged.holdings).toHaveProperty('totalValueRangeXlm');
      expect(ranged.holdings).not.toHaveProperty('positions');
      expect(ranged.pnl).toHaveProperty('totalPnlRangeXlm');
      expect(ranged.joinedAt).toBe('2026-02-03');
      expect(ranged).not.toHaveProperty('wallet');

      await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(owner))
         .send({ handle, showExactAmounts: true, showWallet: true })
         .expect(200);

      const exact = (await request(app).get(`/v1/public/profiles/${handle}`)).body.data.profile;
      expect(exact.keyCount).toBe(1);
      expect(exact.wallet).toBe(owner);
      expect(exact.holdings.positions).toEqual([
         expect.objectContaining({ keyId, quantity: 5 }),
      ]);
      expect(exact.pnl.realisedPnlXlm).toBe(2);
   });

   it('rejects the handle for another wallet in any casing, at the API and the database', async () => {
      const taken = await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(rival))
         .send({ handle: handle.toUpperCase() });
      expect(taken.status).toBe(409);

      await expect(
         prisma.publicProfile.create({ data: { wallet: rival, handle } })
      ).rejects.toMatchObject({ code: 'P2002' });
   });

   it('rejects reserved handles', async () => {
      const reserved = await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(rival))
         .send({ handle: 'Admin' });
      expect(reserved.status).toBe(400);
      expect(await prisma.publicProfile.count({ where: { wallet: rival } })).toBe(0);
   });

   it('serves a disabled profile exactly like an unknown handle', async () => {
      await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(owner))
         .send({ handle, enabled: false })
         .expect(200);

      const disabled = await request(app).get(`/v1/public/profiles/${handle}`);
      const unknown = await request(app).get(`/v1/public/profiles/unknown_${run}`);

      expect(disabled.status).toBe(404);
      expect(disabled.text).toBe(unknown.text);
      expect(disabled.text).not.toContain(owner);
   });

   it('frees the old handle on rename', async () => {
      const renamed = `renamed_${run}`;
      await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(owner))
         .send({ handle: renamed, enabled: true })
         .expect(200);

      expect((await request(app).get(`/v1/public/profiles/${renamed}`)).status).toBe(200);
      expect((await request(app).get(`/v1/public/profiles/${handle}`)).status).toBe(404);

      const claimed = await request(app)
         .put('/v1/me/public-profile')
         .set(bearer(rival))
         .send({ handle });
      expect(claimed.status).toBe(200);
   });
});
