// Unit tests for wallet funding source resolution (#1241).

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      walletFundingSource: { findUnique: jest.fn(), upsert: jest.fn() },
   },
}));
jest.mock('../clients/horizon.client', () => ({ horizonGet: jest.fn() }));

import { prisma } from '../utils/prisma.utils';
import { horizonGet } from '../clients/horizon.client';
import {
   FundingLookupError,
   getFundingSource,
   prefetchFundingSource,
} from './wallet-funding.service';

const findUnique = prisma.walletFundingSource.findUnique as jest.Mock;
const upsert = prisma.walletFundingSource.upsert as jest.Mock;
const horizon = horizonGet as jest.Mock;

const ADDRESS = 'GADDRESS';

function horizonResponse(status: number, body?: unknown) {
   return {
      ok: status >= 200 && status < 300,
      status,
      json: jest.fn().mockResolvedValue(body),
   };
}

const createAccountOp = {
   _embedded: {
      records: [
         {
            type: 'create_account',
            funder: 'GFUNDER',
            created_at: '2026-10-01T08:00:00Z',
         },
      ],
   },
};

beforeEach(() => {
   jest.clearAllMocks();
   findUnique.mockResolvedValue(null);
   upsert.mockResolvedValue({});
});

describe('getFundingSource', () => {
   it('returns the cached funding source without calling Horizon', async () => {
      const cached = { funder: 'GCACHED', fundedAt: new Date('2026-01-01') };
      findUnique.mockResolvedValue(cached);

      await expect(getFundingSource(ADDRESS)).resolves.toEqual(cached);
      expect(horizon).not.toHaveBeenCalled();
   });

   it("reads the funder of the account's first create_account operation and caches it", async () => {
      horizon.mockResolvedValue(horizonResponse(200, createAccountOp));

      const funding = await getFundingSource(ADDRESS);

      expect(horizon).toHaveBeenCalledWith(
         `/accounts/${ADDRESS}/operations?order=asc&limit=1`
      );
      expect(funding).toEqual({
         funder: 'GFUNDER',
         fundedAt: new Date('2026-10-01T08:00:00Z'),
      });
      expect(upsert).toHaveBeenCalledWith({
         where: { address: ADDRESS },
         create: { address: ADDRESS, ...funding },
         update: {},
      });
   });

   it('returns null for an account Horizon does not know, and does not cache it', async () => {
      horizon.mockResolvedValue(horizonResponse(404));
      await expect(getFundingSource(ADDRESS)).resolves.toBeNull();
      expect(upsert).not.toHaveBeenCalled();
   });

   it('returns null when the first operation is not create_account', async () => {
      horizon.mockResolvedValue(
         horizonResponse(200, {
            _embedded: { records: [{ type: 'payment' }] },
         })
      );
      await expect(getFundingSource(ADDRESS)).resolves.toBeNull();
      expect(upsert).not.toHaveBeenCalled();
   });

   it('returns null when the operation history is empty or malformed', async () => {
      horizon.mockResolvedValue(
         horizonResponse(200, { _embedded: { records: [] } })
      );
      await expect(getFundingSource(ADDRESS)).resolves.toBeNull();

      horizon.mockResolvedValue(
         horizonResponse(200, {
            _embedded: {
               records: [
                  {
                     type: 'create_account',
                     funder: 'G',
                     created_at: 'not-a-date',
                  },
               ],
            },
         })
      );
      await expect(getFundingSource(ADDRESS)).resolves.toBeNull();
   });

   it('throws FundingLookupError on Horizon errors so callers retry instead of guessing', async () => {
      horizon.mockResolvedValue(horizonResponse(503));
      await expect(getFundingSource(ADDRESS)).rejects.toBeInstanceOf(
         FundingLookupError
      );

      horizon.mockRejectedValue(new Error('socket hang up'));
      await expect(getFundingSource(ADDRESS)).rejects.toBeInstanceOf(
         FundingLookupError
      );
   });
});

describe('prefetchFundingSource', () => {
   it('never throws, even when Horizon is down', async () => {
      horizon.mockRejectedValue(new Error('down'));
      await expect(prefetchFundingSource(ADDRESS)).resolves.toBeUndefined();
   });

   it('warms the cache on success', async () => {
      horizon.mockResolvedValue(horizonResponse(200, createAccountOp));
      await prefetchFundingSource(ADDRESS);
      expect(upsert).toHaveBeenCalledTimes(1);
   });
});
