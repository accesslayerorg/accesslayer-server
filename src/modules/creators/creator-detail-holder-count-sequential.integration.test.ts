import { httpGetCreatorStats } from './creators.controllers';
import { updateOwnership } from '../ownership/ownership.service';
import { prisma } from '../../utils/prisma.utils';

function makeReq(creatorId: string): any {
   return {
      params: { id: creatorId },
   };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

describe('#630 Integration test: creator detail holder count after sequential buys and sells', () => {
   const creatorId = '123';
   const walletA = 'GWALLETA1111111111111111111111111111111111111111111111111';
   const walletB = 'GWALLETB2222222222222222222222222222222222222222222222222';

   beforeEach(() => {
      jest.restoreAllMocks();
   });

   it('holder count updates accurately across sequential buys and sells across multiple wallets', async () => {
      const ownershipStore = new Map<string, number>();
      (prisma.creatorProfile.findFirst as any) = jest.fn(async () => ({
         id: creatorId,
      }));
      (prisma.keyOwnership.count as any) = jest.fn(async (_args: any) => {
         let count = 0;
         for (const [key, bal] of ownershipStore.entries()) {
            if (key.endsWith(`:${creatorId}`) && bal > 0) {
               count++;
            }
         }
         return count;
      });

      (prisma.keyOwnership.findFirst as any) = jest.fn(async (args: any) => {
         const { ownerAddress, creatorId } = args.where;
         const key = `${ownerAddress}:${creatorId}`;
         const bal = ownershipStore.get(key) || 0;
         return { balance: bal } as any;
      });

      (prisma.keyOwnership.upsert as any) = jest.fn(async (args: any) => {
         const { ownerAddress, creatorId } = args.create;
         const key = `${ownerAddress}:${creatorId}`;
         const current = ownershipStore.get(key) || 0;
         const change = args.update.balance.increment;
         const newBal = current + change;
         ownershipStore.set(key, newBal);
         return { ownerAddress, creatorId, balance: newBal } as any;
      });

      // Step 0: Initial state - 0 holders
      const req0 = makeReq(creatorId);
      const res0 = makeRes();
      await httpGetCreatorStats(req0, res0, makeNext());
      expect(res0.json.mock.calls[0][0].data.holderCount).toBe(0);
      expect(res0.json.mock.calls[0][0].data.holder_count).toBe(0);

      // Step 1: Wallet A buys 1 key -> holder count is 1
      await updateOwnership(walletA, creatorId, 1);
      const req1 = makeReq(creatorId);
      const res1 = makeRes();
      await httpGetCreatorStats(req1, res1, makeNext());
      expect(res1.json.mock.calls[0][0].data.holderCount).toBe(1);
      expect(res1.json.mock.calls[0][0].data.holder_count).toBe(1);

      // Step 2: Wallet B buys 1 key -> holder count is 2
      await updateOwnership(walletB, creatorId, 1);
      const req2 = makeReq(creatorId);
      const res2 = makeRes();
      await httpGetCreatorStats(req2, res2, makeNext());
      expect(res2.json.mock.calls[0][0].data.holderCount).toBe(2);
      expect(res2.json.mock.calls[0][0].data.holder_count).toBe(2);

      // Step 3: Wallet A buys 2 more keys -> holder count remains 2 (existing holder buying more keys)
      await updateOwnership(walletA, creatorId, 2);
      const req3 = makeReq(creatorId);
      const res3 = makeRes();
      await httpGetCreatorStats(req3, res3, makeNext());
      expect(res3.json.mock.calls[0][0].data.holderCount).toBe(2);
      expect(res3.json.mock.calls[0][0].data.holder_count).toBe(2);

      // Step 4: Wallet A sells its 3 keys -> holder count drops back to 1
      await updateOwnership(walletA, creatorId, -3);
      const req4 = makeReq(creatorId);
      const res4 = makeRes();
      await httpGetCreatorStats(req4, res4, makeNext());
      expect(res4.json.mock.calls[0][0].data.holderCount).toBe(1);
      expect(res4.json.mock.calls[0][0].data.holder_count).toBe(1);

      // Step 5: Wallet B sells its 1 key -> holder count reaches 0
      await updateOwnership(walletB, creatorId, -1);
      const req5 = makeReq(creatorId);
      const res5 = makeRes();
      await httpGetCreatorStats(req5, res5, makeNext());
      expect(res5.json.mock.calls[0][0].data.holderCount).toBe(0);
      expect(res5.json.mock.calls[0][0].data.holder_count).toBe(0);
   });
});
