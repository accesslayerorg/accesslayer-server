// src/modules/keys/key-metadata.routes.test.ts
jest.mock('./key-metadata-sync.service', () => ({
   getKeyMetadata: jest.fn(),
   KeyMetadataNotFoundError: class KeyMetadataNotFoundError extends Error {
      constructor(keyId: string) {
         super(`Key metadata not found for: ${keyId}`);
         this.name = 'KeyMetadataNotFoundError';
      }
   },
}));

import express from 'express';
import request from 'supertest';
import keysRouter from './keys.routes';
import {
   getKeyMetadata,
   KeyMetadataNotFoundError,
} from './key-metadata-sync.service';

const mockGetKeyMetadata = getKeyMetadata as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

beforeEach(() => {
   jest.clearAllMocks();
});

describe('GET /api/v1/keys/:keyId/metadata', () => {
   const MOCK_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
   const mockMetadata = {
      keyId: 'creator-key-1',
      keyAddress: 'CCW67TSB3SSS33333333333333333333333333333333333333333333',
      name: 'Alice Creator Key',
      symbol: 'ALICE',
      description: 'Access pass for Alice creative content',
      imageCid: MOCK_CID,
      imageUrl: `https://gateway.pinata.cloud/ipfs/${MOCK_CID}`,
      lastSyncedAt: new Date().toISOString(),
      contractUpdatedAt: new Date().toISOString(),
      stale: false,
   };

   it('returns 200 with synced metadata and stale=false', async () => {
      mockGetKeyMetadata.mockResolvedValue(mockMetadata);

      const res = await request(app).get('/api/v1/keys/creator-key-1/metadata');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Alice Creator Key');
      expect(res.body.data.symbol).toBe('ALICE');
      expect(res.body.data.imageUrl).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
      expect(res.body.data.stale).toBe(false);
      expect(mockGetKeyMetadata).toHaveBeenCalledWith('creator-key-1');
   });

   it('returns 200 with stale=true when sync job is delayed past threshold', async () => {
      mockGetKeyMetadata.mockResolvedValue({
         ...mockMetadata,
         lastSyncedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
         stale: true,
      });

      const res = await request(app).get('/api/v1/keys/creator-key-1/metadata');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.stale).toBe(true);
   });

   it('returns 404 when key metadata is not found', async () => {
      mockGetKeyMetadata.mockRejectedValue(
         new KeyMetadataNotFoundError('unknown-key')
      );

      const res = await request(app).get('/api/v1/keys/unknown-key/metadata');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('not found');
   });
});
