import request from 'supertest';
import app from '../../app';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { disconnectRedis } from '../../utils/redis.utils';
import * as governanceProposalsService from './governance-proposals.service';

jest.mock('../../utils/redis.utils', () => {
   const actual = jest.requireActual('../../utils/redis.utils');
   return {
      ...actual,
      cacheGetJson: jest.fn().mockResolvedValue(null),
      cacheSetJson: jest.fn().mockResolvedValue(undefined),
      cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   };
});

const WALLET = 'GGOVERNANCEPROPOSALTESTWALLET1111111111111111111';
const KEY_ID = 'key-1';
const PROPOSAL_ID = 'prop-key-1-123';

describe('Governance proposal endpoints (#878)', () => {
   let token: string;

   beforeAll(() => {
      token = signWalletAccessToken(WALLET);
   });

   afterAll(async () => {
      await disconnectRedis();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('POST /governance/proposals', () => {
      it('creates a proposal and returns 201 with the snapshot block', async () => {
         jest
            .spyOn(governanceProposalsService, 'createGovernanceProposal')
            .mockResolvedValueOnce({
               id: 'gov-db-1',
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
               title: 'Treasury',
               options: ['Yes', 'No'],
               snapshotLedger: 4242,
               snapshotTotalWeight: '15',
               quorumBps: 3000,
               totalVotingWeight: '0',
               results: { Yes: '0', No: '0' },
               expiresAt: new Date('2026-10-23T00:00:00.000Z'),
               status: 'active',
               createdAt: new Date('2026-10-16T00:00:00.000Z'),
            });

         const res = await request(app)
            .post('/api/v1/governance/proposals')
            .set('Authorization', `Bearer ${token}`)
            .send({
               keyId: KEY_ID,
               title: 'Treasury',
               options: ['Yes', 'No'],
               durationDays: 7,
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            proposalId: PROPOSAL_ID,
            keyId: KEY_ID,
            snapshotLedger: 4242,
            snapshotTotalWeight: '15',
            status: 'active',
         });
         expect(res.body.data.expiresAt).toBe('2026-10-23T00:00:00.000Z');
      });

      it('returns 401 without a JWT', async () => {
         const res = await request(app)
            .post('/api/v1/governance/proposals')
            .send({
               keyId: KEY_ID,
               title: 'Treasury',
               options: ['Yes', 'No'],
               durationDays: 7,
            });

         expect(res.status).toBe(401);
      });

      it('returns 422 for an invalid body', async () => {
         const res = await request(app)
            .post('/api/v1/governance/proposals')
            .set('Authorization', `Bearer ${token}`)
            .send({
               keyId: KEY_ID,
               title: 'Treasury',
               options: ['Only one'],
               durationDays: 0,
            });

         expect(res.status).toBe(422);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('returns 403 when the caller is not the key creator', async () => {
         jest
            .spyOn(governanceProposalsService, 'createGovernanceProposal')
            .mockRejectedValueOnce(
               new governanceProposalsService.NotKeyCreatorError()
            );

         const res = await request(app)
            .post('/api/v1/governance/proposals')
            .set('Authorization', `Bearer ${token}`)
            .send({
               keyId: KEY_ID,
               title: 'Treasury',
               options: ['Yes', 'No'],
               durationDays: 7,
            });

         expect(res.status).toBe(403);
         expect(res.body.error.code).toBe('FORBIDDEN');
      });
   });

   describe('POST /governance/proposals/:id/vote', () => {
      const voteBody = { optionIndex: 0 };

      it('casts a snapshot-weighted vote', async () => {
         jest
            .spyOn(governanceProposalsService, 'castGovernanceVote')
            .mockResolvedValueOnce({
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
               optionIndex: 0,
               option: 'Yes',
               weight: '10',
               totalVotingWeight: '10',
               results: { Yes: '10', No: '0' },
            });

         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send(voteBody);

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            proposalId: PROPOSAL_ID,
            option: 'Yes',
            weight: '10',
         });
      });

      it('returns 409 for a duplicate vote', async () => {
         jest
            .spyOn(governanceProposalsService, 'castGovernanceVote')
            .mockRejectedValueOnce(
               new governanceProposalsService.DuplicateGovernanceVoteError()
            );

         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send(voteBody);

         expect(res.status).toBe(409);
         expect(res.body.error.code).toBe('CONFLICT');
      });

      it('returns 409 for a vote after the deadline', async () => {
         jest
            .spyOn(governanceProposalsService, 'castGovernanceVote')
            .mockRejectedValueOnce(
               new governanceProposalsService.VotingPeriodEndedError(
                  PROPOSAL_ID
               )
            );

         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send(voteBody);

         expect(res.status).toBe(409);
      });

      it('returns 403 when the wallet had no snapshot voting power', async () => {
         jest
            .spyOn(governanceProposalsService, 'castGovernanceVote')
            .mockRejectedValueOnce(
               new governanceProposalsService.NoSnapshotVotingPowerError(WALLET)
            );

         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send(voteBody);

         expect(res.status).toBe(403);
      });

      it('returns 422 for an out-of-range option index', async () => {
         jest
            .spyOn(governanceProposalsService, 'castGovernanceVote')
            .mockRejectedValueOnce(
               new governanceProposalsService.InvalidVoteOptionError(9, 2)
            );

         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send({ optionIndex: 9 });

         expect(res.status).toBe(422);
         expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
      });

      it('returns 401 without a JWT', async () => {
         const res = await request(app)
            .post(`/api/v1/governance/proposals/${PROPOSAL_ID}/vote`)
            .send(voteBody);

         expect(res.status).toBe(401);
      });
   });

   describe('GET /governance/proposals', () => {
      it('lists proposals with tallies and status', async () => {
         jest
            .spyOn(governanceProposalsService, 'listGovernanceProposals')
            .mockResolvedValueOnce({
               items: [
                  {
                     id: 'gov-db-1',
                     keyId: KEY_ID,
                     proposalId: PROPOSAL_ID,
                     title: 'Treasury',
                     options: ['Yes', 'No'],
                      status: 'passed',
                      snapshotLedger: 4242,
                      snapshotTotalWeight: '100',
                      quorumBps: 3000,
                      quorumPercent: 30,
                      quorumRequired: '30',
                      quorumMet: true,
                      winningOption: 'Yes',
                      totalVotingWeight: '60',
                      results: { Yes: '60', No: '0' },
                      participationRate: 0.6,
                      timeRemaining: 0,
                      timeRemainingSeconds: 0,
                      expiresAt: '2026-10-23T00:00:00.000Z',
                      closedAt: '2026-10-23T00:00:00.000Z',
                      executedAt: null,
                      createdAt: '2026-10-16T00:00:00.000Z',
                  },
               ],
               next_cursor: null,
               has_more: false,
            });

         const res = await request(app).get('/api/v1/governance/proposals');

         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0]).toMatchObject({
            proposalId: PROPOSAL_ID,
            status: 'passed',
            quorumMet: true,
            totalVotingWeight: '60',
         });
      });

      it('returns 400 for unknown query parameters', async () => {
         const res = await request(app).get(
            '/api/v1/governance/proposals?bogus=1'
         );

         expect(res.status).toBe(400);
      });
   });

   describe('GET /governance/proposals/:proposal_id', () => {
      it('returns the single proposal with its full vote breakdown', async () => {
         jest
            .spyOn(governanceProposalsService, 'getGovernanceProposal')
            .mockResolvedValueOnce({
               id: 'gov-db-1',
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
               title: 'Treasury',
               options: ['Yes', 'No'],
               status: 'passed',
               snapshotLedger: 4242,
               snapshotTotalWeight: '100',
               quorumBps: 3000,
               quorumPercent: 30,
               quorumRequired: '30',
               quorumMet: true,
               winningOption: 'Yes',
               totalVotingWeight: '60',
               results: { Yes: '60', No: '0' },
               participationRate: 0.6,
               timeRemaining: 0,
               timeRemainingSeconds: 0,
               expiresAt: '2026-10-23T00:00:00.000Z',
               closedAt: '2026-10-23T00:00:00.000Z',
               executedAt: null,
               createdAt: '2026-10-16T00:00:00.000Z',
               votes: [
                  {
                     voter: WALLET,
                     optionIndex: 0,
                     option: 'Yes',
                     weight: '60',
                     votedAt: '2026-10-17T00:00:00.000Z',
                  },
               ],
               voteBreakdown: [
                  {
                     optionIndex: 0,
                     option: 'Yes',
                     weight: '60',
                     voteCount: 1,
                     percentage: 60 / 60,
                  },
                  {
                     optionIndex: 1,
                     option: 'No',
                     weight: '0',
                     voteCount: 0,
                     percentage: null,
                  },
               ],
            });

         const res = await request(app).get(
            `/api/v1/governance/proposals/${PROPOSAL_ID}`
         );

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            proposalId: PROPOSAL_ID,
            status: 'passed',
         });
         expect(res.body.data.voteBreakdown).toHaveLength(2);
         expect(res.body.data.votes).toHaveLength(1);
      });

      it('returns 404 when the proposal does not exist', async () => {
         jest
            .spyOn(governanceProposalsService, 'getGovernanceProposal')
            .mockRejectedValueOnce(
               new governanceProposalsService.GovernanceProposalNotFoundError(
                  PROPOSAL_ID
               )
            );

         const res = await request(app).get(
            `/api/v1/governance/proposals/${PROPOSAL_ID}`
         );

         expect(res.status).toBe(404);
      });
   });

   describe('GET /governance/proposals/:proposal_id/votes/:wallet', () => {
      it('returns the wallet vote and weight', async () => {
         jest
            .spyOn(governanceProposalsService, 'getGovernanceWalletVote')
            .mockResolvedValueOnce({
               keyId: KEY_ID,
               proposalId: PROPOSAL_ID,
               wallet: WALLET,
               hasVoted: true,
               vote: {
                  optionIndex: 1,
                  option: 'No',
                  weight: '10',
                  votedAt: '2026-10-17T00:00:00.000Z',
               },
               weight: '10',
               snapshotLedger: 4242,
               snapshotTotalWeight: '100',
            });

         const res = await request(app).get(
            `/api/v1/governance/proposals/${PROPOSAL_ID}/votes/${WALLET}`
         );

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            proposalId: PROPOSAL_ID,
            wallet: WALLET,
            hasVoted: true,
            weight: '10',
         });
         expect(res.body.data.vote).toMatchObject({
            optionIndex: 1,
            option: 'No',
            weight: '10',
         });
      });

      it('returns 404 when the proposal does not exist', async () => {
         jest
            .spyOn(governanceProposalsService, 'getGovernanceWalletVote')
            .mockRejectedValueOnce(
               new governanceProposalsService.GovernanceProposalNotFoundError(
                  PROPOSAL_ID
               )
            );

         const res = await request(app).get(
            `/api/v1/governance/proposals/${PROPOSAL_ID}/votes/${WALLET}`
         );

         expect(res.status).toBe(404);
      });
   });
});
