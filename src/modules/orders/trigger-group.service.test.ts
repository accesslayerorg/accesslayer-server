const mockGroupCreate = jest.fn();
const mockGroupUpdate = jest.fn();
const mockGroupFindMany = jest.fn();
const mockLegUpdateMany = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      triggerGroup: {
         create: (...args: any[]) => mockGroupCreate(...args),
         update: (...args: any[]) => mockGroupUpdate(...args),
         findMany: (...args: any[]) => mockGroupFindMany(...args),
      },
      triggerLeg: {
         updateMany: (...args: any[]) => mockLegUpdateMany(...args),
      },
      $transaction: (...args: any[]) => mockTransaction(...args),
   },
}));

import {
   InvalidTriggerError,
   cancelTriggerGroup,
   createTriggerGroup,
   fireLegAtomic,
   shouldLegFire,
   validateTrigger,
} from './trigger-group.service';

const base = {
   wallet: 'W',
   keyId: 'K',
   totalAmount: 100n,
   currentPrice: 100n,
   takeProfitPrice: 120n,
   stopLossPrice: 80n,
   walletBalance: 200n,
};

describe('trigger-group service (#1352)', () => {
   beforeEach(() => jest.clearAllMocks());

   describe('validateTrigger', () => {
      it('rejects a totalAmount above the wallet balance', () => {
         expect(() => validateTrigger({ ...base, walletBalance: 50n })).toThrow(InvalidTriggerError);
      });
      it('rejects a take-profit at/below the current price', () => {
         expect(() => validateTrigger({ ...base, takeProfitPrice: 100n })).toThrow(InvalidTriggerError);
         expect(() => validateTrigger({ ...base, takeProfitPrice: 90n })).toThrow(InvalidTriggerError);
      });
      it('rejects a stop-loss at/above the current price', () => {
         expect(() => validateTrigger({ ...base, stopLossPrice: 100n })).toThrow(InvalidTriggerError);
         expect(() => validateTrigger({ ...base, stopLossPrice: 150n })).toThrow(InvalidTriggerError);
      });
      it('rejects a non-positive totalAmount', () => {
         expect(() => validateTrigger({ ...base, totalAmount: 0n })).toThrow(InvalidTriggerError);
      });
      it('accepts a well-formed group', () => {
         expect(() => validateTrigger(base)).not.toThrow();
      });
   });

   describe('createTriggerGroup', () => {
      it('creates a group with two legs when validation passes', async () => {
         mockGroupCreate.mockResolvedValue({ id: 'g1', legs: [] });
         await createTriggerGroup({
            ...base,
            id: 'g1',
            takeProfitLegId: 'tp',
            stopLossLegId: 'sl',
         });
         const data = mockGroupCreate.mock.calls[0][0].data;
         expect(data.legs.create).toHaveLength(2);
         expect(data.legs.create.map((l: any) => l.type).sort()).toEqual([
            'stop_loss',
            'take_profit',
         ]);
      });
      it('surfaces InvalidTriggerError before touching the DB', async () => {
         await expect(
            createTriggerGroup({
               ...base,
               id: 'g1',
               takeProfitLegId: 'tp',
               stopLossLegId: 'sl',
               walletBalance: 10n,
            }),
         ).rejects.toThrow(InvalidTriggerError);
         expect(mockGroupCreate).not.toHaveBeenCalled();
      });
   });

   describe('shouldLegFire', () => {
      it('take-profit fires at or above the trigger', () => {
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'take_profit', triggerPrice: 100n }, 100n)).toBe(true);
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'take_profit', triggerPrice: 100n }, 101n)).toBe(true);
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'take_profit', triggerPrice: 100n }, 99n)).toBe(false);
      });
      it('stop-loss fires at or below the trigger', () => {
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'stop_loss', triggerPrice: 50n }, 50n)).toBe(true);
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'stop_loss', triggerPrice: 50n }, 49n)).toBe(true);
         expect(shouldLegFire({ legId: 'l', groupId: 'g', type: 'stop_loss', triggerPrice: 50n }, 51n)).toBe(false);
      });
   });

   describe('fireLegAtomic (OCO + concurrency guard)', () => {
      it('cancels the sibling leg when the winning leg fires', async () => {
         const tx = {
            triggerLeg: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            triggerGroup: { update: jest.fn() },
         };
         mockTransaction.mockImplementation((cb: any) => cb(tx));
         const result = await fireLegAtomic('g1', 'tp', new Date(0));
         expect(result.fired).toBe(true);
         const calls = tx.triggerLeg.updateMany.mock.calls;
         expect(calls[0][0].where).toMatchObject({ id: 'tp', groupId: 'g1', status: 'armed' });
         expect(calls[1][0].where).toMatchObject({ groupId: 'g1', status: 'armed', NOT: { id: 'tp' } });
         expect(tx.triggerGroup.update).toHaveBeenCalled();
      });

      it('returns fired=false when a racing worker already took the leg', async () => {
         const tx = {
            triggerLeg: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
            triggerGroup: { update: jest.fn() },
         };
         mockTransaction.mockImplementation((cb: any) => cb(tx));
         const result = await fireLegAtomic('g1', 'tp', new Date(0));
         expect(result.fired).toBe(false);
         // Sibling cancellation and group update MUST be skipped so the
         // winning worker's atomic sequence stays authoritative.
         expect(tx.triggerLeg.updateMany).toHaveBeenCalledTimes(1);
         expect(tx.triggerGroup.update).not.toHaveBeenCalled();
      });
   });

   describe('cancelTriggerGroup', () => {
      it('wraps the leg + group updates in one transaction', async () => {
         await cancelTriggerGroup('g1');
         expect(mockTransaction).toHaveBeenCalledTimes(1);
         const [ops] = mockTransaction.mock.calls[0];
         expect(Array.isArray(ops)).toBe(true);
         expect(ops.length).toBe(2);
      });
   });
});
