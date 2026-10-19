import { getCreatorProfile } from './creator-profile.service';

const findFirstMock = jest.fn();
const socialMetadataFindUniqueMock = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
      creatorSocialMetadata: {
         findUnique: (...args: unknown[]) =>
            socialMetadataFindUniqueMock(...args),
      },
   },
}));

const PROFILE_ROW = {
   id: 'creator-1',
   handle: 'ada',
   displayName: 'Ada (off-chain)',
   bio: 'Off-chain bio',
   avatarUrl: 'https://cdn.example/offchain.png',
   perks: [],
   isVerified: true,
   createdAt: new Date('2026-01-01T00:00:00.000Z'),
   updatedAt: new Date('2026-02-01T00:00:00.000Z'),
   priceSnapshot: null,
};

describe('getCreatorProfile — social metadata inclusion', () => {
   beforeEach(() => {
      findFirstMock.mockReset();
      socialMetadataFindUniqueMock.mockReset();
      findFirstMock.mockResolvedValue(PROFILE_ROW);
   });

   it('includes the synced social block and surfaces social links', async () => {
      socialMetadataFindUniqueMock.mockResolvedValue({
         displayName: 'Ada Artist',
         bio: 'On-chain bio',
         avatarCid: 'bafybeigdyrzt',
         avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt',
         socialLinks: [{ label: 'X', url: 'https://x.com/ada' }],
         sourceLedger: 500,
         sourceTxHash: 'tx-social-1',
         sourceEventIndex: 0,
         socialUpdatedAt: new Date('2026-10-17T10:00:00.000Z'),
      });

      const result = await getCreatorProfile('creator-1');

      expect(socialMetadataFindUniqueMock).toHaveBeenCalledWith(
         expect.objectContaining({ where: { creatorId: 'creator-1' } })
      );
      expect(result.social).toMatchObject({
         displayName: 'Ada Artist',
         bio: 'On-chain bio',
         avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt',
         avatarCid: 'bafybeigdyrzt',
         links: [{ label: 'X', url: 'https://x.com/ada' }],
         synced: true,
         source: { ledger: 500, txHash: 'tx-social-1', eventIndex: 0 },
      });
      // Social links are surfaced at the top-level `links` field too.
      expect(result.links).toEqual([{ label: 'X', url: 'https://x.com/ada' }]);
      // Off-chain profile fields are left untouched by the social sync.
      expect(result.displayName).toBe('Ada (off-chain)');
   });

   it('returns social=null and links=[] when no social event has been indexed', async () => {
      socialMetadataFindUniqueMock.mockResolvedValue(null);

      const result = await getCreatorProfile('creator-1');

      expect(result.social).toBeNull();
      expect(result.links).toEqual([]);
   });
});
