import request from "supertest";
import express from "express";
import dividendRouter from "./dividend.routes";
import { signWalletAccessToken } from "../../utils/jwt.utils";
import { prisma } from "../../utils/prisma.utils";
import { errorHandler } from "../../middlewares/error.middleware";

const app = express();
app.use(express.json());
app.use("/creator", dividendRouter);
app.use("/keys", dividendRouter);
app.use(errorHandler);

const CREATOR_WALLET = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27DD6W4KZYLMI";
const OTHER_WALLET = "GBTESTWALLETADDRESSFORACCESSLAYERTESTINGSTELLARCONTRACT123";

describe("POST /creator/:keyId/dividends (#832)", () => {
   let creatorToken: string;
   let nonCreatorToken: string;
   const testKeyId = "creator-div-test-101";

   beforeAll(() => {
      process.env.JWT_SECRET = "accesslayer_default_development_jwt_secret_key_32_bytes";
      creatorToken = signWalletAccessToken(CREATOR_WALLET);
      nonCreatorToken = signWalletAccessToken(OTHER_WALLET);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it("returns 422 when totalAmount is zero or negative", async () => {
      // Test totalAmount = 0
      const res1 = await request(app)
         .post(`/creator/${testKeyId}/dividends`)
         .set("Authorization", `Bearer ${creatorToken}`)
         .send({ totalAmount: 0 });

      expect(res1.status).toBe(422);

      // Test totalAmount = -50
      const res2 = await request(app)
         .post(`/creator/${testKeyId}/dividends`)
         .set("Authorization", `Bearer ${creatorToken}`)
         .send({ totalAmount: -50 });

      expect(res2.status).toBe(422);
   });

   it("returns 403 when JWT caller is not the creator of the key", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_alpha",
         user: {
            stellarWallet: {
               address: CREATOR_WALLET,
            },
         },
      } as any);

      const res = await request(app)
         .post(`/creator/${testKeyId}/dividends`)
         .set("Authorization", `Bearer ${nonCreatorToken}`)
         .send({ totalAmount: 100 });

      expect(res.status).toBe(403);
   });

   it("returns 400 when creator wallet balance is insufficient", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_alpha",
         user: {
            stellarWallet: {
               address: CREATOR_WALLET,
               balance: 50, // only 50 XLM
            },
         },
      } as any);

      jest.spyOn(prisma.creatorProfile, "findUnique").mockResolvedValue({
         id: testKeyId,
         handle: "creator_alpha",
         user: {
            stellarWallet: {
               address: CREATOR_WALLET,
               balance: 50, // only 50 XLM
            },
         },
      } as any);

      const res = await request(app)
         .post(`/creator/${testKeyId}/dividends`)
         .set("Authorization", `Bearer ${creatorToken}`)
         .send({ totalAmount: 1000 }); // requires 1000 XLM

      expect(res.status).toBe(400);
   });

   it("submits distribution, creates per-holder records and returns distributionId, holderCount, perKeyAmount", async () => {
      jest.spyOn(prisma.creatorProfile, "findFirst").mockResolvedValue({
         id: testKeyId,
         handle: "creator_alpha",
         displayName: "Alpha Creator",
         user: {
            stellarWallet: {
               address: CREATOR_WALLET,
               balance: 10000,
            },
         },
      } as any);

      jest.spyOn(prisma.creatorProfile, "findUnique").mockResolvedValue({
         id: testKeyId,
         handle: "creator_alpha",
         displayName: "Alpha Creator",
         user: {
            stellarWallet: {
               address: CREATOR_WALLET,
               balance: 10000,
            },
         },
      } as any);

      // Mock 2 key holders with 10 keys and 40 keys (total 50 keys)
      jest.spyOn(prisma.keyOwnership, "findMany").mockResolvedValue([
         { ownerAddress: "HOLDER_1", balance: 10 as any } as any,
         { ownerAddress: "HOLDER_2", balance: 40 as any } as any,
      ]);

      const distCreateSpy = jest.spyOn(prisma.dividendDistribution, "create").mockResolvedValue({
         id: "dist-generated-12345",
         creatorId: testKeyId,
         totalAmountXlm: 500 as any,
         holderCount: 2,
         perKeyAmountXlm: 10 as any,
         distributionDate: new Date(),
         ledger: 1,
         txHash: "tx-test-1",
      } as any);

      const claimsSpy = jest.spyOn(prisma.dividendClaim, "createMany").mockResolvedValue({
         count: 2,
      } as any);

      const activityLogSpy = jest.spyOn(prisma.activityLog, "createMany").mockResolvedValue({
         count: 2,
      } as any);

      jest.spyOn(prisma.activity, "create").mockResolvedValue({} as any);

      const res = await request(app)
         .post(`/creator/${testKeyId}/dividends`)
         .set("Authorization", `Bearer ${creatorToken}`)
         .send({ totalAmount: 500 });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
         distributionId: "dist-generated-12345",
         totalAmount: 500,
         holderCount: 2,
         perKeyAmount: 10, // 500 / 50 keys = 10 XLM per key
      });

      expect(distCreateSpy).toHaveBeenCalledTimes(1);
      expect(claimsSpy).toHaveBeenCalledTimes(1);
      expect(activityLogSpy).toHaveBeenCalledTimes(1);
   });
});
