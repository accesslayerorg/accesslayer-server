import { checkCreatorProfileOwnership } from './wallet-ownership.utils';
import { prisma } from './prisma.utils';

jest.mock('./prisma.utils', () => ({
   prisma: {
      stellarWallet: {
         findUnique: jest.fn(),
      },
      creatorProfile: {
         findFirst: jest.fn(),
      },
   },
}));

const walletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;
const profileFindFirst = prisma.creatorProfile.findFirst as jest.Mock;

describe('checkCreatorProfileOwnership', () => {
   beforeEach(() => {
      walletFindUnique.mockReset();
      profileFindFirst.mockReset();
   });

   it('returns wallet_not_found when the address is empty', async () => {
      const result = await checkCreatorProfileOwnership('   ', 'creator-1');
      expect(result).toEqual({ status: 'wallet_not_found', address: '' });
      expect(walletFindUnique).not.toHaveBeenCalled();
      expect(profileFindFirst).not.toHaveBeenCalled();
   });

   it('returns wallet_not_found when the wallet is unknown', async () => {
      walletFindUnique.mockResolvedValue(null);
      profileFindFirst.mockResolvedValue({ userId: 'user-1' });

      const result = await checkCreatorProfileOwnership('GABC', 'creator-1');

      expect(result).toEqual({ status: 'wallet_not_found', address: 'GABC' });
   });

   it('returns forbidden when the creator profile does not exist', async () => {
      walletFindUnique.mockResolvedValue({ userId: 'user-1' });
      profileFindFirst.mockResolvedValue(null);

      const result = await checkCreatorProfileOwnership(
         'GABC',
         'missing-creator'
      );

      expect(result).toEqual({
         status: 'forbidden',
         address: 'GABC',
         ownerUserId: null,
      });
   });

   it('returns forbidden when the wallet belongs to a different user', async () => {
      walletFindUnique.mockResolvedValue({ userId: 'wallet-user' });
      profileFindFirst.mockResolvedValue({ userId: 'profile-user' });

      const result = await checkCreatorProfileOwnership('GABC', 'creator-1');

      expect(result).toEqual({
         status: 'forbidden',
         address: 'GABC',
         ownerUserId: 'profile-user',
      });
   });

   it('grants access when the wallet owns the profile', async () => {
      walletFindUnique.mockResolvedValue({ userId: 'shared-user' });
      profileFindFirst.mockResolvedValue({ userId: 'shared-user' });

      const result = await checkCreatorProfileOwnership('GABC', 'creator-1');

      expect(result).toEqual({
         status: 'granted',
         ownerUserId: 'shared-user',
      });
   });

   it('looks up the creator by id or by handle', async () => {
      walletFindUnique.mockResolvedValue({ userId: 'shared-user' });
      profileFindFirst.mockResolvedValue({ userId: 'shared-user' });

      await checkCreatorProfileOwnership('GABC', 'alice');

      expect(profileFindFirst).toHaveBeenCalledWith({
         where: { OR: [{ id: 'alice' }, { handle: 'alice' }] },
         select: { userId: true },
      });
   });
});
