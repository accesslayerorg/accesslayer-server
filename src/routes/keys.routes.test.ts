jest.mock('../services/related-keys.service', () => ({
   DEFAULT_RELATED_KEYS_LIMIT: 8,
   MAX_RELATED_KEYS_LIMIT: 20,
   RelatedKeysService: {
      find: jest.fn(),
   },
}));

import express from 'express';
import supertest from 'supertest';
import { RelatedKeysService } from '../services/related-keys.service';
import keysRouter from './keys.routes';

const findMock = RelatedKeysService.find as jest.Mock;

function createApp() {
   const app = express();
   app.use('/v1', keysRouter);
   return app;
}

describe('GET /v1/keys/:keyId/related', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns related keys with scores', async () => {
      findMock.mockResolvedValue([{ keyId: 'other', score: 7.5 }]);

      const response = await supertest(createApp()).get(
         '/v1/keys/source/related'
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
         success: true,
         data: [{ keyId: 'other', score: 7.5 }],
      });
      expect(findMock).toHaveBeenCalledWith('source', 8);
   });

   it('returns an empty list for a key with no holders', async () => {
      findMock.mockResolvedValue([]);

      const response = await supertest(createApp()).get(
         '/v1/keys/empty/related'
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
   });

   it('rejects limits above 20 with 400', async () => {
      const response = await supertest(createApp()).get(
         '/v1/keys/source/related?limit=21'
      );

      expect(response.status).toBe(400);
      expect(findMock).not.toHaveBeenCalled();
   });

   it('passes an explicit limit through to the service', async () => {
      findMock.mockResolvedValue([]);

      await supertest(createApp()).get('/v1/keys/source/related?limit=12');

      expect(findMock).toHaveBeenCalledWith('source', 12);
   });
});
