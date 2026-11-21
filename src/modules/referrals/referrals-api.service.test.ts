jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralEvent: { findMany: jest.fn() },
      referral: { findMany: jest.fn() },
      registeredKey: { findFirst: jest.fn(), findMany: jest.fn() },
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      STELLAR_NETWORK: 'testnet',
      STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
   },
}));

import { Keypair, TransactionBuilder } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import {
   createReferralClaimTransaction,
   formatStroops,
   getReferralHistory,
} from './referrals-api.service';

describe('referral API service', () => {
   beforeEach(() => jest.clearAllMocks());

   it('converts stroops without rounding away Stellar precision', () => {
      expect(formatStroops(12_345_678n)).toBe(1.2345678);
      expect(formatStroops(0n)).toBe(0);
   });

   it('returns referral history in stable newest-first pages', async () => {
      const first = {
         id: 'event-new',
         keyId: 'key-1',
         amount: '1.25',
         txHash: 'tx-new',
         eventIndex: 2,
         refereeAddress: 'GREFEREE',
         createdAt: new Date('2026-10-01T12:00:00.000Z'),
      };
      const second = { ...first, id: 'event-old', createdAt: new Date('2026-09-30T12:00:00.000Z') };
      (prisma.referralEvent.findMany as jest.Mock).mockResolvedValue([first, second]);

      const page = await getReferralHistory('GREFERRER', { limit: 1 });

      expect(page.items).toEqual([
         expect.objectContaining({ id: 'event-new', amountXlm: 1.25 }),
      ]);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(prisma.referralEvent.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 2,
         })
      );
   });

   it('builds an unsigned claim_referral_rewards call for the authenticated wallet', () => {
      const wallet = Keypair.random().publicKey();
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const result = createReferralClaimTransaction({
         wallet,
         keyId: 'key-1',
         contractId,
         pendingAmount: 3.5,
      });
      const transaction = TransactionBuilder.fromXDR(result.transaction, result.networkPassphrase);
      const operation = transaction.operations[0] as any;

      if (!('source' in transaction)) {
         throw new Error('Expected a standard transaction, not a fee-bump transaction');
      }
      expect(transaction.source).toBe(wallet);
      expect(transaction.signatures).toHaveLength(0);
      expect(operation.type).toBe('invokeHostFunction');
      expect(operation.func.invokeContract().functionName().toString()).toBe(
         'claim_referral_rewards'
      );
      expect(result.pendingAmount).toBe(3.5);
      expect(result.contractId).toBe(contractId);
   });
});
