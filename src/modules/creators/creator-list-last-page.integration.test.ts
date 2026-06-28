// Integration test: creator list cursor advancing to a PARTIAL last page.
//
// The existing cursor round-trip test covers an even split (6 items / two full
// pages of 3). This test covers the end-of-list edge where the final page holds
// fewer than `limit` items: a known total of 5 paginated at limit=2 yields pages
// of [2, 2, 1]. It asserts the last page returns only the remaining item and
// that the response indicates there are no further pages (hasMore=false).
//
// Uses Jest mocks — no database required.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';

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

// Known total of 5 → at limit=2 the pages are [2, 2, 1].
const TOTAL = 5;
const ALL_FIXTURES = [1, 2, 3, 4, 5].map(makeFixture);
const LIMIT = 2;
const LAST_PAGE_OFFSET = 4; // pages start at offsets 0, 2, 4
const LAST_PAGE_FIXTURES = ALL_FIXTURES.slice(LAST_PAGE_OFFSET); // 1 item

async function fetchPage(offset: number, pageItems: CreatorProfile[]) {
   jest
      .spyOn(creatorsUtils, 'fetchCreatorList')
      .mockResolvedValue([pageItems, TOTAL]);

   const res = makeRes();
   await httpListCreators(
      makeReq({ limit: String(LIMIT), offset: String(offset) }),
      res,
      makeNext()
   );
   jest.restoreAllMocks();
   return res.json.mock.calls[0][0].data;
}

describe('creator list — cursor pointing to the last page', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns only the remaining item and signals no further pages', async () => {
      const data = await fetchPage(LAST_PAGE_OFFSET, LAST_PAGE_FIXTURES);

      // Only the remaining item (5th of 5) is returned, not a full page.
      expect(data.items).toHaveLength(1);
      expect(data.items[0].id).toBe('cuid-5');

      // Meta reflects the end of the list.
      expect(data.meta.offset).toBe(LAST_PAGE_OFFSET);
      expect(data.meta.limit).toBe(LIMIT);
      expect(data.meta.total).toBe(TOTAL);
      expect(data.meta.hasMore).toBe(false);
   });

   it('advances through every page and ends with hasMore=false on a partial page', async () => {
      const pages: CreatorProfile[][] = [
         ALL_FIXTURES.slice(0, 2),
         ALL_FIXTURES.slice(2, 4),
         ALL_FIXTURES.slice(4, 5),
      ];

      const collected: string[] = [];
      let lastHasMore = true;

      for (let i = 0; i < pages.length; i++) {
         const data = await fetchPage(i * LIMIT, pages[i]);
         collected.push(...data.items.map((item: { id: string }) => item.id));
         lastHasMore = data.meta.hasMore;
      }

      // Traversal reconstructs the full fixture set exactly once...
      expect(collected).toEqual(ALL_FIXTURES.map(f => f.id));
      // ...and the final page is the end of the list.
      expect(lastHasMore).toBe(false);
   });
});
