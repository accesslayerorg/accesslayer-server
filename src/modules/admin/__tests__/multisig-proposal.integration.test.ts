import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRouter from '../admin.routes';
import { errorHandler } from '../../../middlewares/error.middleware';
import { prisma } from '../../../utils/prisma.utils';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorHandler);

const ADMIN_1 = 'GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789';
const ADMIN_2 = 'GAADMIN2WALLETADDRESSFORACCESSLAYERTESTING987654321';
const ADMIN_3 = 'GAADMIN3WALLETADDRESSFORACCESSLAYERTESTING555555555';
const NON_ADMIN = 'GANONADMINUSERWALLETADDRESSFORACCESSLAYERTESTING555';
const INVALID_ADDRESS = 'INVALID';

describe('Multisig Proposal Queue API (#961)', () => {
  let admin1Token: string;
  let nonAdminToken: string;

  beforeAll(() => {
    const secret = process.env.JWT_SECRET || 'accesslayer_default_development_jwt_secret_key_32_bytes';
    admin1Token = jwt.sign({ sub: ADMIN_1, role: 'admin' }, secret);
    nonAdminToken = jwt.sign({ sub: NON_ADMIN, role: 'user' }, secret);
  });

  afterEach(async () => {
    await prisma.multisigSignature.deleteMany();
    await prisma.multisigProposal.deleteMany();
    jest.restoreAllMocks();
  });

  describe('POST /admin/proposals - Create proposal', () => {
    it('should reject non-admin callers with 403', async () => {
      const res = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({
          changeType: 'update_fee',
          payload: { feeBps: 500 },
        });

      expect(res.status).toBe(403);
    });

    it('should reject invalid request body with 400', async () => {
      const res = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should create a new proposal with default threshold', async () => {
      const res = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({
          changeType: 'update_fee',
          payload: { feeBps: 500, treasuryAddress: 'GATREASURYADDRESSFORACCESSLAYERTESTING123456789' },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.proposalId).toMatch(/^msig-\d+-[a-z0-9]+$/);
      expect(res.body.data.changeType).toBe('update_fee');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.threshold).toBe(2);
      expect(res.body.data.totalSigners).toBe(3);
      expect(res.body.data.proposedBy).toBe(ADMIN_1);
      expect(res.body.data.approvalCount).toBe(0);
      expect(res.body.data.signatures).toEqual([]);
    });

    it('should create a proposal with custom threshold', async () => {
      const res = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({
          changeType: 'update_config',
          payload: { key: 'value' },
          threshold: 3,
          totalSigners: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.threshold).toBe(3);
      expect(res.body.data.totalSigners).toBe(5);
    });

    it('should reject invalid threshold values', async () => {
      const res = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({
          changeType: 'test',
          payload: {},
          threshold: 5,
          totalSigners: 3,
        });

      expect(res.status).toBe(500); // Will throw error in service
    });
  });

  describe('GET /admin/proposals - List proposals', () => {
    beforeEach(async () => {
      // Create test proposals
      await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'type_a', payload: { a: 1 } });

      await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'type_b', payload: { b: 2 } });

      // Sign one to make it executed
      const listRes = await request(app)
        .get('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`);

      const pendingProposal = listRes.body.data.items.find((p: any) => p.status === 'pending');
      if (pendingProposal) {
        await request(app)
          .post(`/admin/proposals/${pendingProposal.proposalId}/sign`)
          .set('Authorization', `Bearer ${admin1Token}`)
          .send({ signer: ADMIN_1 });

        await request(app)
          .post(`/admin/proposals/${pendingProposal.proposalId}/sign`)
          .set('Authorization', `Bearer ${admin1Token}`)
          .send({ signer: ADMIN_2 });
      }
    });

    it('should reject non-admin callers with 403', async () => {
      const res = await request(app)
        .get('/admin/proposals')
        .set('Authorization', `Bearer ${nonAdminToken}`);

      expect(res.status).toBe(403);
    });

    it('should return paginated proposals with correct structure', async () => {
      const res = await request(app)
        .get('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeInstanceOf(Array);
      expect(res.body.data.meta).toMatchObject({
        page: 1,
        limit: 20,
        totalCount: expect.any(Number),
        totalPages: expect.any(Number),
        hasNextPage: expect.any(Boolean),
        hasPrevPage: expect.any(Boolean),
      });
    });

    it('should filter by status', async () => {
      const res = await request(app)
        .get('/admin/proposals?status=pending')
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items.every((p: any) => p.status === 'pending')).toBe(true);
    });

    it('should return correct signature counts', async () => {
      const res = await request(app)
        .get('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(200);
      for (const proposal of res.body.data.items) {
        expect(proposal.approvalCount).toBe(proposal.signatures.length);
        expect(proposal.threshold).toBeGreaterThanOrEqual(proposal.approvalCount);
      }
    });
  });

  describe('GET /admin/proposals/:id - Get proposal detail', () => {
    let proposalId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'detail_test', payload: { test: true } });
      proposalId = createRes.body.data.proposalId;
    });

    it('should reject non-admin callers with 403', async () => {
      const res = await request(app)
        .get(`/admin/proposals/${proposalId}`)
        .set('Authorization', `Bearer ${nonAdminToken}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 for non-existent proposal', async () => {
      const res = await request(app)
        .get('/admin/proposals/msig-nonexistent-123')
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(404);
    });

    it('should return detailed proposal with all signatures', async () => {
      // Add signatures
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      const res = await request(app)
        .get(`/admin/proposals/${proposalId}`)
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.proposalId).toBe(proposalId);
      expect(res.body.data.signatures).toHaveLength(1);
      expect(res.body.data.signatures[0].signer).toBe(ADMIN_1);
      expect(res.body.data.approvalCount).toBe(1);
      expect(res.body.data.threshold).toBe(2);
    });

    it('should include rejection info when rejected', async () => {
      await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1, reason: 'Testing rejection' });

      const res = await request(app)
        .get(`/admin/proposals/${proposalId}`)
        .set('Authorization', `Bearer ${admin1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.rejectedBy).toBe(ADMIN_1);
      expect(res.body.data.rejectionReason).toBe('Testing rejection');
      expect(res.body.data.rejectedAt).toBeDefined();
    });
  });

  describe('POST /admin/proposals/:id/sign - Sign proposal', () => {
    let proposalId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'sign_test', payload: { test: true } });
      proposalId = createRes.body.data.proposalId;
    });

    it('should reject non-admin callers with 403', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({ signer: ADMIN_1 });

      expect(res.status).toBe(403);
    });

    it('should reject invalid signer address with 400', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: INVALID_ADDRESS });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject unauthorized signer with 403', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: NON_ADMIN });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not an authorized multisig admin/i);
    });

    it('should allow authorized signer to sign', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      expect(res.status).toBe(200);
      expect(res.body.data.proposalId).toBe(proposalId);
      expect(res.body.data.signature.signer).toBe(ADMIN_1);
      expect(res.body.data.approvalCount).toBe(1);
      expect(res.body.data.executed).toBe(false);
    });

    it('should reject duplicate signature from same signer with 409', async () => {
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already signed/i);
    });

    it('should execute proposal when threshold reached', async () => {
      // First signature
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      // Second signature - should execute (threshold = 2)
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      expect(res.status).toBe(200);
      expect(res.body.data.executed).toBe(true);
      expect(res.body.data.status).toBe('executed');
      expect(res.body.data.approvalCount).toBe(2);
    });

    it('should reject signing executed proposal with 400', async () => {
      // Execute the proposal
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      // Try to sign again
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_3 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/invalid state executed/i);
    });

    it('should reject signing rejected proposal with 400', async () => {
      await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/invalid state rejected/i);
    });
  });

  describe('POST /admin/proposals/:id/reject - Reject proposal', () => {
    let proposalId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'reject_test', payload: { test: true } });
      proposalId = createRes.body.data.proposalId;
    });

    it('should reject non-admin callers with 403', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({ rejector: ADMIN_1 });

      expect(res.status).toBe(403);
    });

    it('should reject invalid rejector address with 400', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: INVALID_ADDRESS });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject unauthorized rejector with 403', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: NON_ADMIN });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not an authorized multisig admin/i);
    });

    it('should allow authorized signer to reject', async () => {
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1, reason: 'Test rejection' });

      expect(res.status).toBe(200);
      expect(res.body.data.proposalId).toBe(proposalId);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.rejectedBy).toBe(ADMIN_1);
      expect(res.body.data.rejectionReason).toBe('Test rejection');
      expect(res.body.data.rejectedAt).toBeDefined();
    });

    it('should reject rejecting executed proposal with 400', async () => {
      // Execute the proposal
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      // Try to reject
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_3 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/invalid state executed/i);
    });

    it('should reject rejecting already rejected proposal with 400', async () => {
      await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_2 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/invalid state rejected/i);
    });
  });

  describe('Threshold and concurrency', () => {
    it('should handle 3-of-5 threshold correctly', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({
          changeType: 'threshold_test',
          payload: {},
          threshold: 3,
          totalSigners: 5,
        });

      const proposalId = createRes.body.data.proposalId;
      expect(createRes.body.data.threshold).toBe(3);

      // First signature
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      // Second signature
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      // Third signature - should execute
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_3 });

      expect(res.status).toBe(200);
      expect(res.body.data.executed).toBe(true);
      expect(res.body.data.approvalCount).toBe(3);
    });

    it('should not count duplicate signatures toward threshold', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'dup_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      // Sign with ADMIN_1
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      // Try to sign again with ADMIN_1 (should fail)
      const dupRes = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      expect(dupRes.status).toBe(409);

      // Sign with ADMIN_2 - should execute (2 distinct signers)
      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      expect(res.status).toBe(200);
      expect(res.body.data.executed).toBe(true);
      expect(res.body.data.approvalCount).toBe(2); // Only 2 distinct signers
    });

    it('should prevent double execution on concurrent threshold reaching', async () => {
      // This test simulates the race condition where two signers submit
      // signatures simultaneously when threshold is about to be reached
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'race_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      // First signer signs
      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      // Second and third signers attempt to sign concurrently
      // In a real concurrent scenario, both would see count=1 and both try to execute
      // But due to DB transaction, only one should succeed in marking executed
      const [res2, res3] = await Promise.all([
        request(app)
          .post(`/admin/proposals/${proposalId}/sign`)
          .set('Authorization', `Bearer ${admin1Token}`)
          .send({ signer: ADMIN_2 }),
        request(app)
          .post(`/admin/proposals/${proposalId}/sign`)
          .set('Authorization', `Bearer ${admin1Token}`)
          .send({ signer: ADMIN_3 }),
      ]);

      // Both should succeed (200) but only one should have executed=true
      const executedCount = [res2, res3].filter(r => r.body.data?.executed === true).length;
      expect(executedCount).toBe(1);
      expect([res2, res3].every(r => r.status === 200 || r.status === 409)).toBe(true);
    });
  });

  describe('Proposal lifecycle', () => {
    it('should enforce valid state transitions: pending -> executed', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'lifecycle_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      expect(res.body.data.status).toBe('executed');
    });

    it('should enforce valid state transitions: pending -> rejected', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'lifecycle_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1 });

      expect(res.body.data.status).toBe('rejected');
    });

    it('should not allow signing after rejection', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'lifecycle_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_1 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      expect(res.status).toBe(400);
    });

    it('should not allow rejection after execution', async () => {
      const createRes = await request(app)
        .post('/admin/proposals')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ changeType: 'lifecycle_test', payload: {} });

      const proposalId = createRes.body.data.proposalId;

      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_1 });

      await request(app)
        .post(`/admin/proposals/${proposalId}/sign`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ signer: ADMIN_2 });

      const res = await request(app)
        .post(`/admin/proposals/${proposalId}/reject`)
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ rejector: ADMIN_3 });

      expect(res.status).toBe(400);
    });
  });
});