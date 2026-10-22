// src/modules/revenue/creator-revenue.test.ts
import { creatorRevenueService } from './creator-revenue.service';

describe('creatorRevenueService', () => {
   it('aggregates revenue', async () => {
      const w = 'W1';
      await creatorRevenueService.recordWithdrawal(w, 'tx', '1', { royalties: '1' });
      const r = await creatorRevenueService.getCreatorRevenue(w);
      expect(r).toBeDefined();
   });

   it('history pagination', async () => {
      const w = 'W2';
      const h = await creatorRevenueService.getRevenueHistory(w, 1, 10);
      expect(h.page).toBe(1);
   });

   it('builds unsigned tx', async () => {
      const w = 'W3';
      const tx = await creatorRevenueService.buildWithdrawTransaction(w);
      expect(tx.submit).toBe(false);
   });

   it('records withdrawal', async () => {
      const w = 'W4';
      await creatorRevenueService.recordWithdrawal(w, 'txhash', '5', { royalties: '5' });
      const h = await creatorRevenueService.getRevenueHistory(w, 1, 10);
      expect(h.total).toBeGreaterThanOrEqual(1);
   });
});
