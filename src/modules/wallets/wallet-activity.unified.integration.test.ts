import request from "supertest";
import express from "express";
import walletsRouter from "./wallets.routes";
import * as walletActivityService from "./wallet-activity.service";
import { signWalletAccessToken } from "../../utils/jwt.utils";
import { errorHandler } from "../../middlewares/error.middleware";

const app = express();
app.use(express.json());
app.use("/wallets", walletsRouter);
app.use(errorHandler);

const TEST_WALLET_1 = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27DD6W4KZYLMI";
const TEST_WALLET_2 = "GBTESTWALLETADDRESSFORACCESSLAYERTESTINGSTELLARCONTRACT123";

describe("GET /wallets/:address/activity Unified Feed (#811)", () => {
   let validToken: string;

   beforeAll(() => {
      process.env.JWT_SECRET = "accesslayer_default_development_jwt_secret_key_32_bytes";
      validToken = signWalletAccessToken(TEST_WALLET_1);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it("returns 401 when Authorization header is missing", async () => {
      const res = await request(app).get(`/wallets/${TEST_WALLET_1}/activity`);
      expect(res.status).toBe(401);
   });

   it("returns 401 when JWT does not match the address param", async () => {
      const res = await request(app)
         .get(`/wallets/${TEST_WALLET_2}/activity`)
         .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(401);
   });

   it("returns 200 with empty array when wallet has no activity", async () => {
      jest.spyOn(walletActivityService, "fetchWalletActivity").mockResolvedValue([
         [],
         0,
         null,
      ]);

      const res = await request(app)
         .get(`/wallets/${TEST_WALLET_1}/activity`)
         .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.meta.total).toBe(0);
   });

   it("returns all 6 event types correctly labelled and sorted by timestamp descending", async () => {
      const mockEvents = [
         {
            id: "act-1",
            type: "dividend" as const,
            keyId: "creator-alpha",
            creatorName: "Alpha Creator",
            amount: 50,
            timestamp: new Date("2026-03-01T12:00:00Z"),
         },
         {
            id: "act-2",
            type: "burn" as const,
            keyId: "creator-alpha",
            creatorName: "Alpha Creator",
            amount: 2,
            timestamp: new Date("2026-03-01T11:00:00Z"),
         },
         {
            id: "act-3",
            type: "transfer_out" as const,
            keyId: "creator-beta",
            creatorName: "Beta Creator",
            amount: 5,
            timestamp: new Date("2026-03-01T10:00:00Z"),
         },
         {
            id: "act-4",
            type: "transfer_in" as const,
            keyId: "creator-beta",
            creatorName: "Beta Creator",
            amount: 10,
            timestamp: new Date("2026-03-01T09:00:00Z"),
         },
         {
            id: "act-5",
            type: "sell" as const,
            keyId: "creator-gamma",
            creatorName: "Gamma Creator",
            amount: 3,
            timestamp: new Date("2026-03-01T08:00:00Z"),
         },
         {
            id: "act-6",
            type: "buy" as const,
            keyId: "creator-gamma",
            creatorName: "Gamma Creator",
            amount: 8,
            timestamp: new Date("2026-03-01T07:00:00Z"),
         },
      ];

      jest.spyOn(walletActivityService, "fetchWalletActivity").mockResolvedValue([
         mockEvents,
         6,
         null,
      ]);

      const res = await request(app)
         .get(`/wallets/${TEST_WALLET_1}/activity`)
         .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items).toHaveLength(6);

      const types = items.map((i: any) => i.type);
      expect(types).toEqual([
         "dividend",
         "burn",
         "transfer_out",
         "transfer_in",
         "sell",
         "buy",
      ]);

      // Every item contains keyId, creatorName, amount, and timestamp
      for (const item of items) {
         expect(item).toHaveProperty("keyId");
         expect(item).toHaveProperty("creatorName");
         expect(item).toHaveProperty("amount");
         expect(item).toHaveProperty("timestamp");
      }
   });

   it("supports cursor pagination returning nextCursor", async () => {
      const mockFirstPage = [
         {
            id: "act-1",
            type: "buy" as const,
            keyId: "creator-1",
            creatorName: "Creator 1",
            amount: 1,
            timestamp: new Date("2026-03-01T12:00:00Z"),
         },
      ];

      const cursor = "eyJpZCI6ImFjdC0xIn0=";

      jest.spyOn(walletActivityService, "fetchWalletActivity").mockImplementation(
         async (_address, query) => {
            if (query.cursor === cursor) {
               return [
                  [
                     {
                        id: "act-2",
                        type: "sell" as const,
                        keyId: "creator-1",
                        creatorName: "Creator 1",
                        amount: 1,
                        timestamp: new Date("2026-03-01T11:00:00Z"),
                     },
                  ],
                  2,
                  null,
               ];
            }
            return [mockFirstPage, 2, cursor];
         }
      );

      // Fetch page 1
      const res1 = await request(app)
         .get(`/wallets/${TEST_WALLET_1}/activity?limit=1`)
         .set("Authorization", `Bearer ${validToken}`);

      expect(res1.status).toBe(200);
      expect(res1.body.data.items[0].id).toBe("act-1");
      expect(res1.body.data.meta.nextCursor).toBe(cursor);

      // Fetch page 2 with cursor
      const res2 = await request(app)
         .get(`/wallets/${TEST_WALLET_1}/activity?limit=1&cursor=${cursor}`)
         .set("Authorization", `Bearer ${validToken}`);

      expect(res2.status).toBe(200);
      expect(res2.body.data.items[0].id).toBe("act-2");
      expect(res2.body.data.meta.nextCursor).toBeNull();
   });
});
