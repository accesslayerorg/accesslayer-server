// Integration test: wallet activity feed ordered by ledger number, descending (#637)
//
// Seeds three trades for the same wallet at ledgers 1000, 2000 and 3000 and
// confirms the endpoint returns them most-recent-ledger-first, with the
// correct `type` for each trade, and that pagination (limit + cursor)
// is respected.
//
// Uses Jest mocks — no database required.

import { httpGetWalletActivity } from '../wallet-activity.controllers';
import { prisma } from '../../../utils/prisma.utils';
import { encodeCursor } from '../../../utils/cursor.utils';
import type { ActivityFeedCursorPayload } from '../wallet-activity.service';

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      activity: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
      creatorProfile: {
         findMany: jest.fn(),
      },
   },
}));

const mockPrisma = prisma as unknown as {
   activity: {
      findMany: jest.Mock;
      count: jest.Mock;
   };
   creatorProfile: {
      findMany: jest.Mock;
   };
};

const WALLET_ADDRESS =
   'GBRST3QZ5XQQ74345MTHXMY3R745B6N5J2S7K6D6NCT7YIHMHQ45X2WZ';

// Three trades seeded for the same wallet at ledgers 1000, 2000 and 3000.
// Stored here newest-ledger-first, matching what Prisma would hand back
// once `orderBy` sorts them descending.
const SEEDED_TRADES_LEDGER_DESC = [
   {
      id: 'activity-ledger-3000',
      type: 'KEY_BOUGHT',
      actor: WALLET_ADDRESS,
      creatorId: 'creator-alpha',
      payload: {
         amount: '3',
         price_at_trade: '30',
         fee_paid: '0.3',
         ledger_sequence: 3000,
      },
      createdAt: new Date('2026-03-01T00:00:00Z'),
   },
   {
      id: 'activity-ledger-2000',
      type: 'KEY_SOLD',
      actor: WALLET_ADDRESS,
      creatorId: 'creator-alpha',
      payload: {
         amount: '2',
         price_at_trade: '20',
         fee_paid: '0.2',
         ledger_sequence: 2000,
      },
      createdAt: new Date('2026-02-01T00:00:00Z'),
   },
   {
      id: 'activity-ledger-1000',
      type: 'KEY_BOUGHT',
      actor: WALLET_ADDRESS,
      creatorId: 'creator-alpha',
      payload: {
         amount: '1',
         price_at_trade: '10',
         fee_paid: '0.1',
         ledger_sequence: 1000,
      },
      createdAt: new Date('2026-01-01T00:00:00Z'),
   },
];

function makeReq(
   params: Record<string, string> = {},
   query: Record<string, string> = {}
): any {
   return { params, query };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

// Simulates Prisma's cursor-based pagination against the seeded, already
// ledger-descending-sorted fixture set.
function findManyForPage({
   skip,
   take,
   cursor,
}: {
   skip?: number;
   take: number;
   cursor?: { id: string };
}) {
   let startIndex = 0;
   if (cursor) {
      startIndex =
         SEEDED_TRADES_LEDGER_DESC.findIndex(row => row.id === cursor.id) + 1;
   } else if (skip) {
      startIndex = skip;
   }
   return Promise.resolve(
      SEEDED_TRADES_LEDGER_DESC.slice(startIndex, startIndex + take)
   );
}

describe('wallet activity feed — ledger-descending order (#637)', () => {
   beforeEach(() => {
      jest.clearAllMocks();

      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         { id: 'creator-alpha', handle: 'alpha' },
      ]);
      mockPrisma.activity.count.mockResolvedValue(
         SEEDED_TRADES_LEDGER_DESC.length
      );
      mockPrisma.activity.findMany.mockImplementation(findManyForPage);
   });

   it('returns the three seeded trades ordered ledger 3000, 2000, 1000 with the correct type', async () => {
      const req = makeReq({ address: WALLET_ADDRESS });
      const res = makeRes();
      await httpGetWalletActivity(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const items = res.json.mock.calls[0][0].data.items;

      expect(items.map((i: any) => i.ledger_sequence)).toEqual([
         3000, 2000, 1000,
      ]);
      expect(items.map((i: any) => i.type)).toEqual(['buy', 'sell', 'buy']);
   });

   it('respects the pagination limit, returning only the first page and a next cursor', async () => {
      const req = makeReq(
         { address: WALLET_ADDRESS },
         { limit: '2', offset: '0' }
      );
      const res = makeRes();
      await httpGetWalletActivity(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const items = body.data.items;

      expect(items).toHaveLength(2);
      expect(items.map((i: any) => i.ledger_sequence)).toEqual([3000, 2000]);
      expect(body.data.meta.hasMore).toBe(true);

      const expectedCursor = encodeCursor<ActivityFeedCursorPayload>({
         id: 'activity-ledger-2000',
      });
      expect(body.data.meta.nextCursor).toBe(expectedCursor);
   });

   it('respects the cursor, returning the remaining trade after the first page', async () => {
      const cursor = encodeCursor<ActivityFeedCursorPayload>({
         id: 'activity-ledger-2000',
      });

      const req = makeReq({ address: WALLET_ADDRESS }, { limit: '2', cursor });
      const res = makeRes();
      await httpGetWalletActivity(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const items = body.data.items;

      expect(items).toHaveLength(1);
      expect(items[0].ledger_sequence).toBe(1000);
      expect(items[0].type).toBe('buy');
      // nextCursor is the authoritative "no more pages" signal for cursor
      // consumers — it is derived from the cursor page itself, unlike
      // meta.hasMore which is computed from the (unset) offset param.
      expect(body.data.meta.nextCursor).toBeNull();
   });
});
