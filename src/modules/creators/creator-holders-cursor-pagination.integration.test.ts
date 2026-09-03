// Integration test: cursor-based pagination on GET /creators/:id/holders (#778)
//
// Exercises the keyset pagination path added alongside the existing
// offset-based pagination:
//   1. ?cursor=<token> resumes after the given holder and returns nextCursor
//   2. Last page returns hasMore=false and nextCursor=null
//   3. An invalid/tampered cursor returns 400
//   4. A cursor for a holder that no longer exists returns 400
//
// Uses Jest mocks — no database required.

import { httpGetCreatorHolders } from './creator-holders.controller';
import * as holdersService from './creator-holders.service';
import { encodeHoldersCursor } from './creator-holders.service';
import type { HolderRecord } from './creator-holders.service';

function makeReq(
   params: Record<string, string> = {},
   query: Record<string, string> = {}
): any {
   return { params, query };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

// NOTE: parseCreatorId (src/utils/creator-id.utils.ts) currently only accepts
// positive-integer route params, so the id used here must be numeric — a
// pre-existing constraint unrelated to cursor pagination.
const CREATOR_STUB = { id: '12345', handle: 'alice' };

function makeHolder(
   index: number,
   overrides: Partial<HolderRecord> = {}
): HolderRecord {
   const key_balance = (4 - index) * 10;
   return {
      wallet_address: `GWALLETADDRESS${String(index).padStart(46, '0')}`,
      key_balance,
      held_since: new Date(`2024-0${index}-01T00:00:00.000Z`),
      key_count: key_balance,
      share_percent: 0,
      rank: index,
      stakedQuantity: 0,
      liquidQuantity: key_balance,
      ...overrides,
   };
}

describe('GET /creators/:id/holders — cursor pagination', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('resumes after the given cursor and returns a nextCursor when more holders exist', async () => {
      jest
         .spyOn(holdersService, 'findCreatorByIdOrHandle')
         .mockResolvedValue(CREATOR_STUB);

      const nextHolder = makeHolder(2);
      const fetchByCursorSpy = jest
         .spyOn(holdersService, 'fetchCreatorHoldersByCursor')
         .mockResolvedValue({
            holders: [nextHolder],
            nextCursor: encodeHoldersCursor(nextHolder.wallet_address),
            hasMore: true,
         });

      const cursor = encodeHoldersCursor(makeHolder(1).wallet_address);
      const req = makeReq({ id: CREATOR_STUB.id }, { cursor, limit: '1' });
      const res = makeRes();
      await httpGetCreatorHolders(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].wallet_address).toBe(nextHolder.wallet_address);
      expect(body.data.meta.hasMore).toBe(true);
      expect(body.data.meta.nextCursor).toBeTruthy();
      expect(fetchByCursorSpy).toHaveBeenCalledWith(
         CREATOR_STUB.id,
         expect.objectContaining({ limit: 1 }),
         makeHolder(1).wallet_address
      );
   });

   it('returns hasMore=false and nextCursor=null on the last page', async () => {
      jest
         .spyOn(holdersService, 'findCreatorByIdOrHandle')
         .mockResolvedValue(CREATOR_STUB);
      jest.spyOn(holdersService, 'fetchCreatorHoldersByCursor').mockResolvedValue({
         holders: [makeHolder(3)],
         nextCursor: null,
         hasMore: false,
      });

      const cursor = encodeHoldersCursor(makeHolder(2).wallet_address);
      const req = makeReq({ id: CREATOR_STUB.id }, { cursor });
      const res = makeRes();
      await httpGetCreatorHolders(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.hasMore).toBe(false);
      expect(body.data.meta.nextCursor).toBeNull();
   });

   it('returns 400 for a malformed cursor', async () => {
      jest
         .spyOn(holdersService, 'findCreatorByIdOrHandle')
         .mockResolvedValue(CREATOR_STUB);

      const req = makeReq(
         { id: CREATOR_STUB.id },
         { cursor: 'not-a-real-cursor' }
      );
      const res = makeRes();
      await httpGetCreatorHolders(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('returns 400 when the cursor does not match a known holder', async () => {
      jest
         .spyOn(holdersService, 'findCreatorByIdOrHandle')
         .mockResolvedValue(CREATOR_STUB);
      jest
         .spyOn(holdersService, 'fetchCreatorHoldersByCursor')
         .mockResolvedValue(null);

      const cursor = encodeHoldersCursor('GNONEXISTENTWALLET');
      const req = makeReq({ id: CREATOR_STUB.id }, { cursor });
      const res = makeRes();
      await httpGetCreatorHolders(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
   });

   it('offset-mode pagination is unaffected when no cursor is supplied', async () => {
      jest
         .spyOn(holdersService, 'findCreatorByIdOrHandle')
         .mockResolvedValue(CREATOR_STUB);
      const fetchOffsetSpy = jest
         .spyOn(holdersService, 'fetchCreatorHolders')
         .mockResolvedValue([[makeHolder(1)], 1]);
      const fetchByCursorSpy = jest.spyOn(
         holdersService,
         'fetchCreatorHoldersByCursor'
      );

      const req = makeReq({ id: CREATOR_STUB.id }, { limit: '20', offset: '0' });
      const res = makeRes();
      await httpGetCreatorHolders(req, res, makeNext());

      expect(fetchOffsetSpy).toHaveBeenCalled();
      expect(fetchByCursorSpy).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.total).toBe(1);
   });
});
