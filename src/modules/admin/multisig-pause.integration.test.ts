import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminRouter from "./admin.routes";
import { prisma } from "../../utils/prisma.utils";
import { errorHandler } from "../../middlewares/error.middleware";

const app = express();
app.use(express.json());
app.use("/admin", adminRouter);
app.use(errorHandler);

const ADMIN_1 = "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789";
const ADMIN_2 = "GAADMIN2WALLETADDRESSFORACCESSLAYERTESTING987654321";
const NON_ADMIN = "GANONADMINUSERWALLETADDRESSFORACCESSLAYERTESTING555";

describe("Multi-sig Pause Coordination (#826)", () => {
   let admin1Token: string;
   let admin2Token: string;
   let nonAdminToken: string;
   const testKeyId = "creator-pause-test-101";

   beforeAll(() => {
      const secret = process.env.JWT_SECRET || "accesslayer_default_development_jwt_secret_key_32_bytes";
      admin1Token = jwt.sign({ sub: ADMIN_1, role: "admin" }, secret);
      admin2Token = jwt.sign({ sub: ADMIN_2, role: "admin" }, secret);
      nonAdminToken = jwt.sign({ sub: NON_ADMIN, role: "user" }, secret);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it("non-admin callers return 403 on both propose and approve endpoints", async () => {
      // Propose by non-admin
      const res1 = await request(app)
         .post(`/admin/keys/${testKeyId}/pause/propose`)
         .set("Authorization", `Bearer ${nonAdminToken}`);

      expect(res1.status).toBe(403);

      // Approve by non-admin
      const res2 = await request(app)
         .post(`/admin/keys/${testKeyId}/pause/approve`)
         .set("Authorization", `Bearer ${nonAdminToken}`);

      expect(res2.status).toBe(403);
   });

   it("propose endpoint creates a database record and emits pause_proposal_created notification", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_test",
         tradingPaused: false,
      } as any);

      const createProposalSpy = jest.spyOn(prisma.pauseProposal, "create").mockResolvedValue({
         id: "proposal-db-1",
         proposalId: "pause-creator-pause-test-101-1000",
         keyId: testKeyId,
         proposerWallet: ADMIN_1,
         status: "pending",
         createdAt: new Date(),
         executedAt: null,
         approverWallet: null,
         txHash: null,
      } as any);

      const activitySpy = jest.spyOn(prisma.activity, "create").mockResolvedValue({} as any);

      const res = await request(app)
         .post(`/admin/keys/${testKeyId}/pause/propose`)
         .set("Authorization", `Bearer ${admin1Token}`);

      expect(res.status).toBe(201);
      expect(res.body.data.proposalId).toBe("pause-creator-pause-test-101-1000");
      expect(res.body.data.status).toBe("pending");
      expect(res.body.data.notification).toBe("pause_proposal_created");

      expect(createProposalSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               keyId: testKeyId,
               proposerWallet: ADMIN_1,
               status: "pending",
            }),
         })
      );

      expect(activitySpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: "TRADING_PAUSE_PROPOSED",
               actor: ADMIN_1,
            }),
         })
      );
   });

   it("approve endpoint rejects the proposing wallet with 403", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_test",
         tradingPaused: false,
      } as any);

      // Proposal was proposed by ADMIN_1
      jest.spyOn(prisma.pauseProposal, "findFirst").mockResolvedValue({
         id: "proposal-db-1",
         proposalId: "pause-creator-pause-test-101-1000",
         keyId: testKeyId,
         proposerWallet: ADMIN_1,
         status: "pending",
      } as any);

      // ADMIN_1 tries to approve their own proposal
      const res = await request(app)
         .post(`/admin/keys/${testKeyId}/pause/approve`)
         .set("Authorization", `Bearer ${admin1Token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/cannot approve your own pause proposal/i);
   });

   it("approve from a different admin marks proposal executed and emits trading_paused notification", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_test",
         tradingPaused: false,
      } as any);

      jest.spyOn(prisma.pauseProposal, "findFirst").mockResolvedValue({
         id: "proposal-db-1",
         proposalId: "pause-creator-pause-test-101-1000",
         keyId: testKeyId,
         proposerWallet: ADMIN_1,
         status: "pending",
      } as any);

      const updateProposalSpy = jest.spyOn(prisma.pauseProposal, "update").mockResolvedValue({
         id: "proposal-db-1",
         status: "executed",
         approverWallet: ADMIN_2,
      } as any);

      const updateCreatorSpy = jest.spyOn(prisma.creatorProfile, "update").mockResolvedValue({
         id: testKeyId,
         tradingPaused: true,
      } as any);

      const activitySpy = jest.spyOn(prisma.activity, "create").mockResolvedValue({} as any);

      // ADMIN_2 (different admin) approves
      const res = await request(app)
         .post(`/admin/keys/${testKeyId}/pause/approve`)
         .set("Authorization", `Bearer ${admin2Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("executed");
      expect(res.body.data.isTradingPaused).toBe(true);
      expect(res.body.data.notification).toBe("trading_paused");

      expect(updateProposalSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               status: "executed",
               approverWallet: ADMIN_2,
            }),
         })
      );

      expect(updateCreatorSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               tradingPaused: true,
            }),
         })
      );

      expect(activitySpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: "TRADING_PAUSE_APPROVED",
               actor: ADMIN_2,
            }),
         })
      );
   });
});
