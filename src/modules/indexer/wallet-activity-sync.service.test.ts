import {
   processTransferEvent,
   processBurnEvent,
   executeWithRetry,
   ActivitySyncJob,
   TransferChainEvent,
   BurnChainEvent,
} from "./wallet-activity-sync.service";
import { prisma } from "../../utils/prisma.utils";

describe("Wallet Activity Sync Job (#818)", () => {
   const SENDER = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27DD6W4KZYLMI";
   const RECIPIENT = "GBTESTWALLETADDRESSFORACCESSLAYERTESTINGSTELLARCONTRACT123";
   const BURNER = "GCBURNERWALLETADDRESSFORACCESSLAYERTESTINGSTELLAR12345678";

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it("keys_transferred event creates two activity records (sender and recipient)", async () => {
      const upsertMock = jest.fn().mockImplementation(async (args: any) => {
         return {
            id: `log-${args.create.actor}`,
            ...args.create,
         };
      });
      (prisma.activityLog as any).upsert = upsertMock;

      const event: TransferChainEvent = {
         eventType: "keys_transferred",
         txHash: "0xabcdef1234567890",
         fromAddress: SENDER,
         toAddress: RECIPIENT,
         keyId: "creator-101",
         amount: 25,
         creatorName: "SuperCreator",
      };

      const result = await processTransferEvent(event);

      expect(result).not.toBeNull();
      expect(upsertMock).toHaveBeenCalledTimes(2);

      // Verify sender call (transfer_out)
      expect(upsertMock).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               type: "transfer_out",
               actor: SENDER,
               target: RECIPIENT,
               keyId: "creator-101",
               amount: 25,
            }),
         })
      );

      // Verify recipient call (transfer_in)
      expect(upsertMock).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               type: "transfer_in",
               actor: RECIPIENT,
               target: SENDER,
               keyId: "creator-101",
               amount: 25,
            }),
         })
      );
   });

   it("keys_burned event creates one activity record for the burner", async () => {
      const upsertMock = jest.fn().mockImplementation(async (args: any) => {
         return {
            id: `log-burn-${args.create.actor}`,
            ...args.create,
         };
      });
      (prisma.activityLog as any).upsert = upsertMock;

      const event: BurnChainEvent = {
         eventType: "keys_burned",
         txHash: "0xburnhash12345678",
         burnerAddress: BURNER,
         keyId: "creator-202",
         amount: 10,
         creatorName: "FireCreator",
      };

      const result = await processBurnEvent(event);

      expect(result).not.toBeNull();
      expect(upsertMock).toHaveBeenCalledTimes(1);
      expect(upsertMock).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               type: "burn",
               actor: BURNER,
               keyId: "creator-202",
               amount: 10,
               txHash: "0xburnhash12345678",
            }),
         })
      );
   });

   it("retries failed database writes up to 3 times before skipping", async () => {
      let callCount = 0;
      const failingFn = jest.fn().mockImplementation(async () => {
         callCount++;
         if (callCount < 3) {
            throw new Error("Temporary DB lock");
         }
         return "success";
      });

      const res = await executeWithRetry(failingFn, 3, 10);
      expect(res).toBe("success");
      expect(callCount).toBe(3);

      // Test complete exhaustion
      const permanentFail = jest.fn().mockRejectedValue(new Error("Fatal DB error"));
      await expect(executeWithRetry(permanentFail, 3, 10)).rejects.toThrow("Fatal DB error");
      expect(permanentFail).toHaveBeenCalledTimes(3);
   });

   it("handles duplicate events idempotently via txHash", async () => {
      const upsertMock = jest.fn().mockResolvedValue({
         id: "existing-log-1",
      });
      (prisma.activityLog as any).upsert = upsertMock;

      const event: BurnChainEvent = {
         eventType: "keys_burned",
         txHash: "0xduplicate123",
         burnerAddress: BURNER,
         keyId: "creator-303",
         amount: 5,
      };

      // Call twice with the same event
      await processBurnEvent(event);
      await processBurnEvent(event);

      expect(upsertMock).toHaveBeenCalledTimes(2);
      expect(upsertMock).toHaveBeenLastCalledWith(
         expect.objectContaining({
            where: {
               txHash_actor_type: {
                  txHash: "0xduplicate123",
                  actor: BURNER,
                  type: "burn",
               },
            },
         })
      );
   });

   it("reconnects automatically if the Horizon stream drops", () => {
      jest.useFakeTimers();

      const job = new ActivitySyncJob({ reconnectIntervalMs: 1000 });
      job.start();
      expect(job.isRunning()).toBe(true);

      // Trigger disconnect
      job.triggerReconnect();

      // Fast forward past timer
      jest.advanceTimersByTime(1000);
      expect(job.isRunning()).toBe(true);

      job.stop();
      expect(job.isRunning()).toBe(false);

      jest.useRealTimers();
   });
});
