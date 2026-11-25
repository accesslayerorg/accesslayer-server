const mockGuardianUpsert = jest.fn();
const mockGuardianFindUnique = jest.fn();
const mockGuardianFindMany = jest.fn();
const mockRequestFindUnique = jest.fn();
const mockRequestFindFirst = jest.fn();
const mockRequestFindMany = jest.fn();
const mockRequestCreate = jest.fn();
const mockRequestUpdate = jest.fn();
const mockApprovalUpsert = jest.fn();
const mockNotificationCreate = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      guardianSet: {
         upsert: (...args: any[]) => mockGuardianUpsert(...args),
         findUnique: (...args: any[]) => mockGuardianFindUnique(...args),
         findMany: (...args: any[]) => mockGuardianFindMany(...args),
      },
      recoveryRequest: {
         findUnique: (...args: any[]) => mockRequestFindUnique(...args),
         findFirst: (...args: any[]) => mockRequestFindFirst(...args),
         findMany: (...args: any[]) => mockRequestFindMany(...args),
         create: (...args: any[]) => mockRequestCreate(...args),
         update: (...args: any[]) => mockRequestUpdate(...args),
      },
      recoveryApproval: {
         upsert: (...args: any[]) => mockApprovalUpsert(...args),
      },
      recoveryNotification: {
         create: (...args: any[]) => mockNotificationCreate(...args),
      },
   },
}));

import {
   getGuardianRequests,
   getRecoveryStatus,
   handleGuardiansSet,
   handleRecoveryApproved,
   handleRecoveryCancelled,
   handleRecoveryExecuted,
   handleRecoveryInitiated,
} from './social-recovery.service';

describe('social recovery service (#1350)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('handleGuardiansSet', () => {
      it('clamps threshold into [1, guardians.length]', async () => {
         mockGuardianUpsert.mockResolvedValue({});
         await handleGuardiansSet({
            walletAddress: 'GW',
            guardians: ['G1', 'G2'],
            threshold: 10,
         });
         const args = mockGuardianUpsert.mock.calls[0][0];
         expect(args.create.threshold).toBe(2);
         expect(args.update.threshold).toBe(2);
      });
   });

   describe('handleRecoveryInitiated', () => {
      it('creates one row and one notification per channel', async () => {
         mockRequestFindUnique.mockResolvedValue(null);
         mockRequestCreate.mockResolvedValue({ id: 'r1' });
         await handleRecoveryInitiated({
            requestId: 'r1',
            walletAddress: 'GW',
            initiator: 'GB',
            newOwner: 'GNEW',
            initiatedLedger: 100,
            earliestExecute: 200,
         });
         expect(mockRequestCreate).toHaveBeenCalledTimes(1);
         expect(mockNotificationCreate).toHaveBeenCalledTimes(3);
         const priorities = mockNotificationCreate.mock.calls.map((c) => c[0].data.priority);
         expect(priorities.every((p) => p === 'high')).toBe(true);
      });

      it('is idempotent on replay (no duplicate rows, no duplicate notifications)', async () => {
         mockRequestFindUnique.mockResolvedValue({ id: 'r1' });
         await handleRecoveryInitiated({
            requestId: 'r1',
            walletAddress: 'GW',
            initiator: 'GB',
            newOwner: 'GNEW',
            initiatedLedger: 100,
            earliestExecute: 200,
         });
         expect(mockRequestCreate).not.toHaveBeenCalled();
         expect(mockNotificationCreate).not.toHaveBeenCalled();
      });
   });

   describe('handleRecoveryApproved', () => {
      it('upserts the approval so replay does not duplicate it', async () => {
         await handleRecoveryApproved({ requestId: 'r1', guardian: 'G1' });
         expect(mockApprovalUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { requestId_guardian: { requestId: 'r1', guardian: 'G1' } },
            }),
         );
      });
   });

   describe('handleRecoveryCancelled / Executed', () => {
      it('cancelled marks pending request as cancelled', async () => {
         mockRequestFindUnique.mockResolvedValue({ id: 'r1', status: 'pending' });
         await handleRecoveryCancelled({ requestId: 'r1' });
         expect(mockRequestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
         );
      });
      it('executed marks pending request as executed', async () => {
         mockRequestFindUnique.mockResolvedValue({ id: 'r1', status: 'pending' });
         await handleRecoveryExecuted({ requestId: 'r1' });
         expect(mockRequestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'executed' }) }),
         );
      });
      it('ignores events for already-terminal requests', async () => {
         mockRequestFindUnique.mockResolvedValue({ id: 'r1', status: 'executed' });
         await handleRecoveryCancelled({ requestId: 'r1' });
         expect(mockRequestUpdate).not.toHaveBeenCalled();
      });
   });

   describe('getRecoveryStatus visibility', () => {
      it('hides guardian details from a stranger and exposes counts only', async () => {
         mockGuardianFindUnique.mockResolvedValue({
            walletAddress: 'GW',
            guardians: ['G1', 'G2', 'G3'],
            threshold: 2,
         });
         mockRequestFindFirst.mockResolvedValue(null);
         const status = await getRecoveryStatus('GW', 'STRANGER');
         expect(status.canSeeDetails).toBe(false);
         expect(status.guardianCount).toBe(3);
         expect(status.guardians).toEqual([]);
      });

      it('exposes guardian details to the wallet owner', async () => {
         mockGuardianFindUnique.mockResolvedValue({
            walletAddress: 'GW',
            guardians: ['G1', 'G2'],
            threshold: 2,
         });
         mockRequestFindFirst.mockResolvedValue({
            id: 'r1',
            initiator: 'GB',
            newOwner: 'GNEW',
            initiatedLedger: 100,
            earliestExecute: 200,
            approvals: [{ guardian: 'G1' }],
         });
         const status = await getRecoveryStatus('GW', 'GW');
         expect(status.canSeeDetails).toBe(true);
         expect(status.guardians).toEqual(['G1', 'G2']);
         expect(status.pending?.approvals).toBe(1);
         expect(status.pending?.threshold).toBe(2);
         expect(status.pending?.approvedBy).toEqual(['G1']);
      });

      it('exposes guardian details to a named guardian', async () => {
         mockGuardianFindUnique.mockResolvedValue({
            walletAddress: 'GW',
            guardians: ['G1', 'G2'],
            threshold: 2,
         });
         mockRequestFindFirst.mockResolvedValue(null);
         const status = await getRecoveryStatus('GW', 'G2');
         expect(status.canSeeDetails).toBe(true);
         expect(status.guardians).toEqual(['G1', 'G2']);
      });

      it('returns hasGuardians=false when nothing is configured', async () => {
         mockGuardianFindUnique.mockResolvedValue(null);
         const status = await getRecoveryStatus('GW');
         expect(status.hasGuardians).toBe(false);
         expect(status.pending).toBeNull();
      });
   });

   describe('getGuardianRequests', () => {
      it('returns pending requests across every wallet the viewer guards', async () => {
         mockGuardianFindMany.mockResolvedValue([
            { walletAddress: 'W1', threshold: 2 },
            { walletAddress: 'W2', threshold: 3 },
         ]);
         mockRequestFindMany.mockResolvedValue([
            {
               id: 'r1',
               walletAddress: 'W1',
               initiator: 'GB',
               newOwner: 'GNEW',
               initiatedLedger: 10,
               earliestExecute: 20,
               approvals: [{ guardian: 'G1' }],
            },
         ]);
         const out = await getGuardianRequests('G1');
         expect(out).toHaveLength(1);
         expect(out[0]).toMatchObject({
            requestId: 'r1',
            walletAddress: 'W1',
            threshold: 2,
            approvals: 1,
            approvedByViewer: true,
         });
      });

      it('returns [] when the viewer guards nothing', async () => {
         mockGuardianFindMany.mockResolvedValue([]);
         expect(await getGuardianRequests('G1')).toEqual([]);
      });
   });
});
