import express from 'express';
import request from 'supertest';
import { listScheduledTransfers } from './scheduled-transfer.service';
import router from './scheduled-transfer.routes';

jest.mock('./scheduled-transfer.service', () => ({
   listScheduledTransfers: jest.fn(),
   ScheduledTransferCursorError: class extends Error {},
}));
const list = listScheduledTransfers as jest.Mock;
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const app = express();
app.use('/api/v1/wallets', router);
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
   res.status(500).json({ success: false });
});

describe('GET wallet scheduled transfers', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      list.mockResolvedValue({
         items: [], meta: { limit: 25, hasNextPage: false, nextCursor: null }, currentLedger: 100,
      });
   });

   it('defaults to all directions and 25 records', async () => {
      const response = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers`);
      expect(response.status).toBe(200);
      expect(list).toHaveBeenCalledWith(ADDRESS, { direction: 'all', limit: 25 });
      expect(response.body.data.items).toEqual([]);
   });

   it.each([
      'direction=sideways', 'limit=0', 'limit=101', 'limit=1.5',
      'direction=incoming&direction=outgoing', 'cursor=!', 'unknown=value',
   ])('rejects malformed query %s before reading state', async query => {
      const response = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers?${query}`);
      expect(response.status).toBe(400);
      expect(list).not.toHaveBeenCalled();
   });

   it('rejects an invalid wallet address', async () => {
      const response = await request(app).get('/api/v1/wallets/GSHORT/scheduled-transfers');
      expect(response.status).toBe(400);
      expect(list).not.toHaveBeenCalled();
   });

   it('forwards ledger or database failures', async () => {
      list.mockRejectedValue(new Error('Unavailable'));
      const response = await request(app).get(`/api/v1/wallets/${ADDRESS}/scheduled-transfers`);
      expect(response.status).toBe(500);
   });
});
