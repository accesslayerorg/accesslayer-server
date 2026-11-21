import request from 'supertest';
import express from 'express';
import { signWalletAccessToken } from '../../../utils/jwt.utils';
import creatorRouter from '../../creators/creators.routes';
import { prisma } from '../../../utils/prisma.utils';
import { errorHandler } from '../../../middlewares/error.middleware';

const app = express();
app.use(express.json());
app.use('/creator', creatorRouter);
app.use('/creators', creatorRouter);
app.use(errorHandler);

const CREATOR_WALLET = 'GACREATORPROPOSALTESTWALLET111111111111111111111';
const NON_CREATOR_WALLET = 'GANONCREATORWALLET22222222222222222222222222222';
const KEY_ID = 'creator-prop-key-101';
const USER_ID = 'user-creator-101';
const OTHER_USER_ID = 'user-other-202';

describe('Proposal Creation Endpoint (Issue #836) - POST /creator/:keyId/proposals', () => {
   let creatorToken: string;
   let nonCreatorToken: string;

   beforeAll(() => {
      creatorToken = signWalletAccessToken(CREATOR_WALLET);
      nonCreatorToken = signWalletAccessToken(NON_CREATOR_WALLET);
   });

   beforeEach(() => {
      jest.restoreAllMocks();

      // Mock database lookups for requireKeyCreator middleware
      (
         jest.spyOn(prisma.creatorProfile, 'findFirst') as any
      ).mockImplementation((args: any) => {
         const where = args?.where;
         if (
            where?.OR?.some(
               (cond: any) => cond.id === KEY_ID || cond.handle === KEY_ID
            )
         ) {
            return Promise.resolve({
               id: KEY_ID,
               userId: USER_ID,
               handle: 'testcreator',
            });
         }
         return Promise.resolve(null);
      });

      (
         jest.spyOn(prisma.stellarWallet, 'findUnique') as any
      ).mockImplementation((args: any) => {
         if (args?.where?.address === CREATOR_WALLET) {
            return Promise.resolve({
               address: CREATOR_WALLET,
               userId: USER_ID,
            });
         }
         if (args?.where?.address === NON_CREATOR_WALLET) {
            return Promise.resolve({
               address: NON_CREATOR_WALLET,
               userId: OTHER_USER_ID,
            });
         }
         return Promise.resolve(null);
      });
   });

   it('returns 403 when non-creator JWT attempts to create a proposal', async () => {
      const res = await request(app)
         .post(`/creator/${KEY_ID}/proposals`)
         .set('Authorization', `Bearer ${nonCreatorToken}`)
         .send({
            title: 'Community Fund Proposal',
            options: ['Option A', 'Option B'],
            durationDays: 3,
         });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('returns 422 when fewer than 2 options are provided', async () => {
      const res = await request(app)
         .post(`/creator/${KEY_ID}/proposals`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({
            title: 'Only One Option',
            options: ['Single Option'],
            durationDays: 3,
         });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([expect.objectContaining({ field: 'options' })])
      );
   });

   it('returns 422 when more than 4 options are provided', async () => {
      const res = await request(app)
         .post(`/creator/${KEY_ID}/proposals`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({
            title: 'Too Many Options',
            options: ['One', 'Two', 'Three', 'Four', 'Five'],
            durationDays: 7,
         });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([expect.objectContaining({ field: 'options' })])
      );
   });

   it('returns 422 when invalid durationDays is provided', async () => {
      const res = await request(app)
         .post(`/creator/${KEY_ID}/proposals`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({
            title: 'Invalid Duration',
            options: ['Yes', 'No'],
            durationDays: 5, // Only 1, 3, 7, 14 are allowed
         });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'durationDays' }),
         ])
      );
   });

   it('creates and persists a valid proposal with correct fields and returns 201', async () => {
      const proposalCreateSpy = (
         jest.spyOn(prisma.governanceProposal, 'create') as any
      ).mockImplementation((args: any) => {
         return Promise.resolve({
            id: 'gov-db-123',
            keyId: args.data.keyId,
            proposalId: args.data.proposalId,
            title: args.data.title,
            options: args.data.options,
            totalVotingWeight: '0',
            results: args.data.results,
            snapshotLedger: 0,
            expiresAt: args.data.expiresAt,
            status: 'active',
            createdAt: new Date('2026-08-26T12:00:00.000Z'),
            updatedAt: new Date('2026-08-26T12:00:00.000Z'),
         });
      });

      const activitySpy = (
         jest.spyOn(prisma.activity, 'create') as any
      ).mockResolvedValue({});

      const res = await request(app)
         .post(`/creator/${KEY_ID}/proposals`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({
            title: 'Should We Host a Fan Meetup?',
            options: ['Yes in London', 'Yes in New York', 'Online Webinar'],
            durationDays: 7,
         });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.proposalId).toBeDefined();
      expect(res.body.data.keyId).toBe(KEY_ID);
      expect(res.body.data.title).toBe('Should We Host a Fan Meetup?');
      expect(res.body.data.options).toEqual([
         'Yes in London',
         'Yes in New York',
         'Online Webinar',
      ]);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.expiresAt).toBeDefined();

      expect(proposalCreateSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               keyId: KEY_ID,
               title: 'Should We Host a Fan Meetup?',
               options: ['Yes in London', 'Yes in New York', 'Online Webinar'],
               status: 'active',
            }),
         })
      );

      expect(activitySpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: 'GOVERNANCE_PROPOSAL_CREATED',
               actor: CREATOR_WALLET,
               creatorId: KEY_ID,
            }),
         })
      );
   });
});
