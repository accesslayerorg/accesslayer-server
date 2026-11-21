import { prisma } from '../../utils/prisma.utils';
import { createAirdrop, getAirdropProof, AirdropRequestError } from './airdrop.service';
import { MerkleService } from './merkle.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      stellarWallet: { findUnique: jest.fn() },
      airdrop: { upsert: jest.fn(), findUnique: jest.fn() },
      airdropLeaf: { findUnique: jest.fn(), findMany: jest.fn() },
   },
}));
jest.mock('./merkle.service', () => ({
   MerkleService: { build: jest.fn() },
}));

const { Prisma } = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');

describe('airdrop ownership and persisted proofs', () => {
   beforeEach(() => jest.clearAllMocks());

   it('does not persist allocations signed by a different key creator', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key', userId: 'creator' });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({ userId: 'other' });
      await expect(createAirdrop({
         keyId: 'key', allocations: [{ address: 'recipient', amount: '10' }],
      }, 'intruder')).rejects.toBeInstanceOf(AirdropRequestError);
      expect(MerkleService.build).not.toHaveBeenCalled();
      expect(prisma.airdrop.upsert).not.toHaveBeenCalled();
   });

   it('uses canonical key IDs and atomically stores every proof', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key', userId: 'creator' });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({ userId: 'creator' });
      (MerkleService.build as jest.Mock).mockReturnValue({
         root: 'a'.repeat(64),
         leaves: [{ address: 'recipient', amount: '10', index: 0, proof: ['b'.repeat(64)] }],
      });
      (prisma.airdrop.upsert as jest.Mock).mockResolvedValue({ id: 'drop', root: 'a'.repeat(64) });
      await createAirdrop({
         keyId: 'handle', allocations: [{ address: 'recipient', amount: '10' }],
      }, 'creator-wallet');
      expect(prisma.airdrop.upsert).toHaveBeenCalledWith(expect.objectContaining({
         where: { keyId_root: { keyId: 'key', root: 'a'.repeat(64) } },
         update: {},
         create: expect.objectContaining({
            keyId: 'key', creator: 'creator-wallet',
            leaves: { create: [{ address: 'recipient', amount: '10', index: 0, proof: ['b'.repeat(64)] }] },
         }),
      }));
   });

   it('returns no proof for an ineligible address', async () => {
      (prisma.airdropLeaf.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await getAirdropProof('drop', 'ineligible')).toBeNull();
   });

   it('serves exact amounts and indexed claim status', async () => {
      (prisma.airdropLeaf.findUnique as jest.Mock).mockResolvedValue({
         amount: new Prisma.Decimal('170141183460469231731687303715884105727'),
         index: 2, proof: ['a'.repeat(64)], claimedAt: new Date('2026-11-21T00:00:00Z'),
         airdrop: { root: 'b'.repeat(64) },
      });
      expect(await getAirdropProof('drop', 'eligible')).toMatchObject({
         amount: '170141183460469231731687303715884105727',
         index: 2, proof: ['a'.repeat(64)], claimed: true,
      });
   });
});
