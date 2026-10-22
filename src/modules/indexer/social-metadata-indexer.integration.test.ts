import {
   processSocialMetadataEvents,
   processSocialMetadataUpdatedEvent,
   SOCIAL_METADATA_UPDATED_EVENT_TYPE,
   SocialMetadataUpdatedEvent,
} from './social-metadata-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { invalidateCreatorSocialMetadataCache } from '../creators/creator-social-cache-invalidation';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      socialMetadataEvent: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      creatorSocialMetadata: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
   },
}));

jest.mock('../creators/creator-social-cache-invalidation', () => ({
   invalidateCreatorSocialMetadataCache: jest.fn(),
}));

type MockPrisma = {
   socialMetadataEvent: { findUnique: jest.Mock; create: jest.Mock };
   creatorSocialMetadata: { findUnique: jest.Mock; upsert: jest.Mock };
};

const mockPrisma = prisma as unknown as MockPrisma;
const mockLogger = logger as unknown as { warn: jest.Mock };
const mockInvalidate = invalidateCreatorSocialMetadataCache as jest.Mock;

function baseEvent(
   overrides: Partial<SocialMetadataUpdatedEvent> = {}
): SocialMetadataUpdatedEvent {
   return {
      txHash: 'tx-social-1',
      eventIndex: 0,
      eventType: SOCIAL_METADATA_UPDATED_EVENT_TYPE,
      ledger: 500,
      creatorId: 'creator-1',
      actor: 'GARTISTWALLET',
      displayName: 'Ada Artist',
      bio: 'On-chain bio',
      avatarCid: 'ipfs://bafybeigdyrzt',
      socialLinks: [
         { label: 'X', url: 'https://x.com/ada?ref=timeline' },
         { label: 'Site', url: 'https://ada.example' },
      ],
      socialUpdatedAt: '2026-10-17T10:00:00.000Z',
      ...overrides,
   };
}

describe('processSocialMetadataUpdatedEvent', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.socialMetadataEvent.findUnique.mockResolvedValue(null);
      mockPrisma.socialMetadataEvent.create.mockResolvedValue({});
      mockPrisma.creatorSocialMetadata.findUnique.mockResolvedValue(null);
      mockPrisma.creatorSocialMetadata.upsert.mockResolvedValue({});
   });

   it('stores the event and upserts the snapshot with a resolved avatar gateway URL', async () => {
      const processed = await processSocialMetadataUpdatedEvent(baseEvent());

      expect(processed).toBe(true);

      // Raw event stored per key
      expect(mockPrisma.socialMetadataEvent.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.socialMetadataEvent.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               creatorId: 'creator-1',
               txHash: 'tx-social-1',
               eventIndex: 0,
               ledger: 500,
               avatarCid: 'bafybeigdyrzt',
               avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt',
            }),
         })
      );

      // Snapshot (read model) upserted with normalized links + resolved avatar
      expect(mockPrisma.creatorSocialMetadata.upsert).toHaveBeenCalledTimes(1);
      const upsertArg =
         mockPrisma.creatorSocialMetadata.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({ creatorId: 'creator-1' });
      expect(upsertArg.create.avatarUrl).toBe(
         'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt'
      );
      expect(upsertArg.create.socialLinks).toEqual([
         { label: 'X', url: 'https://x.com/ada' },
         { label: 'Site', url: 'https://ada.example/' },
      ]);

      // Cache invalidated synchronously
      expect(mockInvalidate).toHaveBeenCalledWith({
         creatorId: 'creator-1',
         txHash: 'tx-social-1',
         eventIndex: 0,
      });
   });

   it('is idempotent — skips events already indexed by (txHash, eventIndex)', async () => {
      mockPrisma.socialMetadataEvent.findUnique.mockResolvedValue({
         id: 'existing',
      });

      const processed = await processSocialMetadataUpdatedEvent(baseEvent());

      expect(processed).toBe(false);
      expect(mockPrisma.socialMetadataEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.creatorSocialMetadata.upsert).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('treats a unique-constraint race (P2002) as a duplicate', async () => {
      mockPrisma.socialMetadataEvent.create.mockRejectedValue({
         code: 'P2002',
      });

      const processed = await processSocialMetadataUpdatedEvent(baseEvent());

      expect(processed).toBe(false);
      expect(mockPrisma.creatorSocialMetadata.upsert).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('skips an event with a missing creatorId and logs a warning', async () => {
      const event = baseEvent({ creatorId: undefined as unknown as string });

      const processed = await processSocialMetadataUpdatedEvent(event);

      expect(processed).toBe(false);
      expect(mockPrisma.socialMetadataEvent.create).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
         expect.objectContaining({ missingField: 'creatorId' }),
         expect.any(String)
      );
   });

   it('does not roll back the snapshot when an older event arrives out of order', async () => {
      mockPrisma.creatorSocialMetadata.findUnique.mockResolvedValue({
         sourceLedger: 900,
         socialUpdatedAt: new Date('2026-10-17T12:00:00.000Z'),
         sourceTxHash: 'newer-tx',
      });

      const processed = await processSocialMetadataUpdatedEvent(
         baseEvent({ ledger: 500 })
      );

      expect(processed).toBe(true);
      // Event is still recorded for the audit trail...
      expect(mockPrisma.socialMetadataEvent.create).toHaveBeenCalledTimes(1);
      // ...but the read model is not overwritten with older state.
      expect(mockPrisma.creatorSocialMetadata.upsert).not.toHaveBeenCalled();
      // Caches are still invalidated (snapshot unchanged, but AC: each event).
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
   });

   it('preserves previously synced fields when a partial update omits them', async () => {
      const processed = await processSocialMetadataUpdatedEvent(
         baseEvent({
            displayName: undefined,
            bio: undefined,
            avatarCid: undefined,
            avatarUrl: undefined,
            socialLinks: undefined,
         })
      );

      expect(processed).toBe(true);

      const update =
         mockPrisma.creatorSocialMetadata.upsert.mock.calls[0][0].update;
      expect(update).not.toHaveProperty('displayName');
      expect(update).not.toHaveProperty('bio');
      expect(update).not.toHaveProperty('avatarUrl');
      expect(update).not.toHaveProperty('socialLinks');
      expect(update.sourceLedger).toBe(500);
   });

   it('falls back to an explicit avatarUrl when no CID is present', async () => {
      await processSocialMetadataUpdatedEvent(
         baseEvent({
            avatarCid: null,
            avatarUrl: 'https://cdn.example/avatar.png',
         })
      );

      const create =
         mockPrisma.creatorSocialMetadata.upsert.mock.calls[0][0].create;
      expect(create.avatarCid).toBeNull();
      expect(create.avatarUrl).toBe('https://cdn.example/avatar.png');
   });
});

describe('processSocialMetadataEvents', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.socialMetadataEvent.findUnique.mockResolvedValue(null);
      mockPrisma.socialMetadataEvent.create.mockResolvedValue({});
      mockPrisma.creatorSocialMetadata.findUnique.mockResolvedValue(null);
      mockPrisma.creatorSocialMetadata.upsert.mockResolvedValue({});
   });

   it('deduplicates identical events within a batch', async () => {
      const event = baseEvent();

      await processSocialMetadataEvents([event, event]);

      expect(mockPrisma.socialMetadataEvent.create).toHaveBeenCalledTimes(1);
   });

   it('ignores non-social event types', async () => {
      await processSocialMetadataEvents([
         {
            txHash: 'tx-trade',
            eventIndex: 0,
            eventType: 'KEY_BOUGHT',
            ledger: 501,
            creatorId: 'creator-1',
         },
      ]);

      expect(mockPrisma.socialMetadataEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.creatorSocialMetadata.upsert).not.toHaveBeenCalled();
   });
});
