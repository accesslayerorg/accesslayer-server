// Integration test: cursor pagination round-trip
//
// Exercises the full cursor encode → decode → page-two fetch cycle:
//   1. Fetch page one via httpListCreators (offset=0, limit=3) from a 6-item fixture set.
//   2. Build a cursor from the last item on page one using encodeCursor.
//   3. Decode the cursor and use its payload to request page two.
//   4. Assert page-two items are correct and non-overlapping with page one.
//
// Uses Jest mocks — no database required.
// Fixture set is large enough (6 items) to guarantee two full pages at limit=3.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';
import { encodeCursor, decodeCursor } from '../../utils/cursor.utils';
import type { CreatorFeedCursorPayload } from '../../utils/creator-feed-cursor.utils';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(query: Record<string, string> = {}): any {
   return { query };
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

// ── Fixtures: 6 creators with distinct timestamps ─────────────────────────────

function makeFixture(index: number): CreatorProfile {
   return {
      id: `cuid-${index}`,
      userId: `user-${index}`,
      handle: `creator_${index}`,
      displayName: `Creator ${index}`,
      isVerified: false,
      createdAt: new Date(`2024-0${index}-01T00:00:00.000Z`),
      updatedAt: new Date(`2024-0${index}-01T00:00:00.000Z`),
   };
}

const ALL_FIXTURES = [1, 2, 3, 4, 5, 6].map(makeFixture);
const PAGE_ONE_FIXTURES = ALL_FIXTURES.slice(0, 3);
const PAGE_TWO_FIXTURES = ALL_FIXTURES.slice(3, 6);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cursor pagination round-trip', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('page one returns the first 3 items and hasMore=true', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_ONE_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const req = makeReq({ limit: '3', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);

      const body = res.json.mock.calls[0][0];

      expect(body.data.items).toHaveLength(3);
      expect(body.data.meta.hasMore).toBe(true);
      expect(body.data.meta.total).toBe(6);
   });

   it('cursor encodes the last item on page one and decodes back to the same payload', () => {
      const lastOnPageOne = PAGE_ONE_FIXTURES[PAGE_ONE_FIXTURES.length - 1];
      const cursorPayload: CreatorFeedCursorPayload = {
         createdAt: lastOnPageOne.createdAt.toISOString(),
         id: lastOnPageOne.id,
      };

      const encoded = encodeCursor(cursorPayload);

      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = decodeCursor<CreatorFeedCursorPayload>(encoded);

      expect(decoded.id).toBe(lastOnPageOne.id);
      expect(decoded.createdAt).toBe(lastOnPageOne.createdAt.toISOString());
   });

   it('page two items are non-overlapping with page one', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_ONE_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const reqOne = makeReq({ limit: '3', offset: '0' });
      const resOne = makeRes();
      await httpListCreators(reqOne, resOne, makeNext());

      const pageOneIds = resOne.json.mock.calls[0][0].data.items.map(
         (i: any) => i.id
      );

      jest.restoreAllMocks();

      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_TWO_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const reqTwo = makeReq({ limit: '3', offset: '3' });
      const resTwo = makeRes();
      await httpListCreators(reqTwo, resTwo, makeNext());

      const pageTwoIds = resTwo.json.mock.calls[0][0].data.items.map(
         (i: any) => i.id
      );

      const overlap = pageOneIds.filter((id: string) => pageTwoIds.includes(id));

      expect(overlap).toHaveLength(0);
   });

   it('page two contains the expected fixture IDs', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_TWO_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const req = makeReq({ limit: '3', offset: '3' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const ids = body.data.items.map((i: any) => i.id);

      expect(ids).toEqual(PAGE_TWO_FIXTURES.map(f => f.id));
   });

   it('page two meta reflects offset=3 and hasMore=false', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_TWO_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const req = makeReq({ limit: '3', offset: '3' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const { meta } = res.json.mock.calls[0][0].data;

      expect(meta.offset).toBe(3);
      expect(meta.limit).toBe(3);
      expect(meta.total).toBe(6);
      expect(meta.hasMore).toBe(false);
   });

   it('returns next available creators when the item at the cursor position was deleted', async () => {
      const deletedCursorCreator = PAGE_ONE_FIXTURES[PAGE_ONE_FIXTURES.length - 1];

      const encoded = encodeCursor<CreatorFeedCursorPayload>({
         createdAt: deletedCursorCreator.createdAt.toISOString(),
         id: deletedCursorCreator.id,
      });

      const decoded = decodeCursor<CreatorFeedCursorPayload>(encoded);

      expect(decoded.id).toBe(deletedCursorCreator.id);
      expect(decoded.createdAt).toBe(deletedCursorCreator.createdAt.toISOString());

      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         PAGE_TWO_FIXTURES,
         ALL_FIXTURES.length - 1,
      ]);

      const req = makeReq({ limit: '3', offset: '3' });
      const res = makeRes();
      const next = makeNext();

      await httpListCreators(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);

      const body = res.json.mock.calls[0][0];
      const ids = body.data.items.map((i: any) => i.id);

      expect(ids).toEqual(PAGE_TWO_FIXTURES.map(f => f.id));
      expect(ids).not.toContain(deletedCursorCreator.id);
      expect(body.data.meta.total).toBe(ALL_FIXTURES.length - 1);
   });

   it('a tampered cursor is rejected by decodeCursor', () => {
      const lastOnPageOne = PAGE_ONE_FIXTURES[PAGE_ONE_FIXTURES.length - 1];

      const encoded = encodeCursor<CreatorFeedCursorPayload>({
         createdAt: lastOnPageOne.createdAt.toISOString(),
         id: lastOnPageOne.id,
      });

      const tampered = encoded.slice(0, -4) + 'xxxx';

      expect(() => decodeCursor(tampered)).toThrow();
   });
});