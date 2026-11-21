import { processIssuerVerificationEvents } from './issuer-verification-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => {
   const tx = {
      issuerVerificationEvent: { createMany: jest.fn() },
      issuerVerification: { upsert: jest.fn() },
   };
   return {
      prisma: {
         $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
            callback(tx)
         ),
         __tx: tx,
      },
   };
});

const tx = (prisma as unknown as { __tx: any }).__tx;

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const base = { txHash: 'tx-v', eventIndex: 0, ledger: 900, timestamp: 1_800_000_000 };

beforeEach(() => {
   jest.clearAllMocks();
   tx.issuerVerificationEvent.createMany.mockResolvedValue({ count: 1 });
   tx.issuerVerification.upsert.mockResolvedValue({});
});

describe('processIssuerVerificationEvents', () => {
   it('marks the issuer verified with tier and expiry on VerificationGranted', async () => {
      await processIssuerVerificationEvents([
         {
            ...base,
            eventType: 'VerificationGranted',
            wallet: WALLET,
            tier: 'GOLD',
            expiry_timestamp: 1_900_000_000,
         },
      ]);

      expect(tx.issuerVerification.upsert).toHaveBeenCalledWith({
         where: { wallet: WALLET },
         create: {
            wallet: WALLET,
            isVerified: true,
            tier: 'GOLD',
            expiresAt: new Date(1_900_000_000 * 1000),
            lastLedger: 900,
         },
         update: {
            isVerified: true,
            tier: 'GOLD',
            expiresAt: new Date(1_900_000_000 * 1000),
            lastLedger: 900,
         },
      });
      expect(cacheInvalidate).toHaveBeenCalledWith(
         `issuers:verification:${WALLET}`,
         'issuers:verified:*'
      );
   });

   it('clears verification and tier on VerificationRevoked', async () => {
      await processIssuerVerificationEvents([
         { ...base, eventType: 'VerificationRevoked', wallet: WALLET, tier: 'GOLD' },
      ]);

      expect(tx.issuerVerification.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({
               isVerified: false,
               tier: null,
               expiresAt: null,
            }),
         })
      );
   });

   it('leaves state untouched when the event was already recorded', async () => {
      tx.issuerVerificationEvent.createMany.mockResolvedValue({ count: 0 });

      await processIssuerVerificationEvents([
         { ...base, eventType: 'VerificationGranted', wallet: WALLET, tier: 'GOLD' },
      ]);

      expect(tx.issuerVerification.upsert).not.toHaveBeenCalled();
   });

   it('skips a grant without a wallet', async () => {
      await processIssuerVerificationEvents([
         { ...base, eventType: 'VerificationGranted', tier: 'GOLD' },
      ]);

      expect(prisma.$transaction).not.toHaveBeenCalled();
   });
});
