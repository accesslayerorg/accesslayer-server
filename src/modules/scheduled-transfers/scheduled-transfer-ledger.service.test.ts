import { horizonGet } from '../../clients/horizon.client';
import { readScheduledTransferLedger } from './scheduled-transfer-ledger.service';

jest.mock('../../clients/horizon.client', () => ({ horizonGet: jest.fn() }));
const get = horizonGet as jest.Mock;

describe('scheduled transfer latest-ledger context', () => {
   it('uses the latest ledger and the observed interval between ledger close times', async () => {
      get.mockResolvedValue({
         ok: true,
         json: async () => ({ _embedded: { records: [
            { sequence: 101, closed_at: '2026-11-21T01:00:00Z' },
            { sequence: 100, closed_at: '2026-11-21T00:59:54Z' },
         ] } }),
      });
      expect(await readScheduledTransferLedger()).toEqual({
         ledger: 101, closedAt: new Date('2026-11-21T01:00:00Z'),
         closeIntervalMs: 6000,
      });
      expect(get).toHaveBeenCalledWith('/ledgers?order=desc&limit=2');
   });

   it('allows a single genesis ledger without guessing an interval', async () => {
      get.mockResolvedValue({
         ok: true,
         json: async () => ({ _embedded: { records: [
            { sequence: 1, closed_at: '2026-11-21T01:00:00Z' },
         ] } }),
      });
      expect((await readScheduledTransferLedger()).closeIntervalMs).toBeNull();
   });

   it.each([
      { ok: false },
      { ok: true, json: async () => ({ _embedded: { records: [] } }) },
      { ok: true, json: async () => ({ _embedded: { records: [
         { sequence: 101, closed_at: 'invalid' },
      ] } }) },
   ])('fails closed when current-ledger evidence is unavailable', async response => {
      get.mockResolvedValue(response);
      await expect(readScheduledTransferLedger()).rejects.toThrow();
   });
});
