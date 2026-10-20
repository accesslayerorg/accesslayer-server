import { SorobanWALService } from './wal.service';
import { ISorobanClient, HorizonTxResult } from './wal.types';

class MockClient implements ISorobanClient {
   public submitTxMock = jest.fn();
   public getTxResultMock = jest.fn();

   async submitTransaction(xdrPayload: string): Promise<{ txHash: string }> {
      return this.submitTxMock(xdrPayload);
   }

   async getTransactionResult(txHash: string): Promise<HorizonTxResult> {
      return this.getTxResultMock(txHash);
   }
}

describe('SorobanWALService Unit Tests', () => {
   let mockPrisma: any;
   let mockClient: MockClient;
   let service: SorobanWALService;

   beforeEach(() => {
      mockClient = new MockClient();
      mockPrisma = {
         sorobanWALEntry: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
         },
         keyOwnership: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            count: jest.fn(),
         },
         creatorStats: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
         },
         priceSnapshot: {
            create: jest.fn(),
         },
         transactionHistory: {
            upsert: jest.fn(),
         },
         activity: {
            create: jest.fn(),
         },
         $transaction: jest.fn(async cb => cb(mockPrisma)),
      };
      service = new SorobanWALService(mockPrisma, mockClient);
   });

   describe('Validation & Edge Cases', () => {
      it('throws on invalid operation', async () => {
         await expect(
            service.createPendingWALEntry({
               operation: 'INVALID' as any,
               wallet: 'G1',
               creatorWallet: 'G2',
               amount: 1,
               expectedSupplyBefore: 0,
               xdrPayload: 'XDR',
            })
         ).rejects.toThrow(/Invalid Soroban operation/);
      });

      it('throws on non-positive amount', async () => {
         await expect(
            service.createPendingWALEntry({
               operation: 'buy',
               wallet: 'G1',
               creatorWallet: 'G2',
               amount: 0,
               expectedSupplyBefore: 0,
               xdrPayload: 'XDR',
            })
         ).rejects.toThrow(/Transaction amount must be greater than 0/);
      });

      it('throws on missing wallet address', async () => {
         await expect(
            service.createPendingWALEntry({
               operation: 'buy',
               wallet: '',
               creatorWallet: 'G2',
               amount: 5,
               expectedSupplyBefore: 0,
               xdrPayload: 'XDR',
            })
         ).rejects.toThrow(/Wallet address is required/);
      });

      it('throws on missing creator wallet address', async () => {
         await expect(
            service.createPendingWALEntry({
               operation: 'buy',
               wallet: 'G1',
               creatorWallet: '',
               amount: 5,
               expectedSupplyBefore: 0,
               xdrPayload: 'XDR',
            })
         ).rejects.toThrow(/Creator wallet address is required/);
      });

      it('throws on missing XDR payload', async () => {
         await expect(
            service.createPendingWALEntry({
               operation: 'buy',
               wallet: 'G1',
               creatorWallet: 'G2',
               amount: 5,
               expectedSupplyBefore: 0,
               xdrPayload: '',
            })
         ).rejects.toThrow(/Soroban XDR payload is required/);
      });
   });

   describe('Pricing Formula', () => {
      it('computes correct spot price for supply zero and higher supplies', () => {
         const p0 = service.calculatePrice(0);
         expect(p0.toNumber()).toBeCloseTo(0.001);

         const p40 = service.calculatePrice(40);
         // (40*40)/1600 + 0.001 = 1 + 0.001 = 1.001
         expect(p40.toNumber()).toBeCloseTo(1.001);
      });
   });

   describe('Horizon Polling', () => {
      it('returns immediately when status is SUCCESS', async () => {
         mockClient.getTxResultMock.mockResolvedValueOnce({
            status: 'SUCCESS',
            ledger: 123,
         });

         const res = await service.pollHorizonForConfirmation(
            'tx_success',
            5,
            10
         );
         expect(res.status).toBe('SUCCESS');
         expect(mockClient.getTxResultMock).toHaveBeenCalledTimes(1);
      });

      it('returns immediately when status is FAILED', async () => {
         mockClient.getTxResultMock.mockResolvedValueOnce({
            status: 'FAILED',
            error: 'insufficient fee',
         });

         const res = await service.pollHorizonForConfirmation(
            'tx_failed',
            5,
            10
         );
         expect(res.status).toBe('FAILED');
         expect(res.error).toBe('insufficient fee');
         expect(mockClient.getTxResultMock).toHaveBeenCalledTimes(1);
      });

      it('exhausts maxPollAttempts if transaction remains PENDING', async () => {
         mockClient.getTxResultMock.mockResolvedValue({ status: 'PENDING' });

         const res = await service.pollHorizonForConfirmation(
            'tx_pending',
            3,
            5
         );
         expect(res.status).toBe('PENDING');
         expect(mockClient.getTxResultMock).toHaveBeenCalledTimes(3);
      });
   });
});
