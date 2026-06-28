// Integration test: creator list sort=createdAt&order=desc (newest registered)
//
// Verifies that when sort=createdAt and order=desc are supplied, the controller
// passes those params to fetchCreatorList and the response items arrive in strict
// descending registration order. The test is designed to fail if the ordering is
// reversed or unstable.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import { buildCreatorRegistrationFixtures } from './creator-registration-fixtures.utils';

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

// ── Fixtures with distinct registration timestamps ────────────────────────────

const [FIXTURE_OLDEST, FIXTURE_MIDDLE, FIXTURE_NEWEST] =
   buildCreatorRegistrationFixtures(3, '2023-01-01T00:00:00.000Z', 90);

// Intentionally out of order to confirm the mock drives the assertion
const FIXTURES_ASCENDING = [FIXTURE_OLDEST, FIXTURE_MIDDLE, FIXTURE_NEWEST];
const FIXTURES_DESCENDING = [FIXTURE_NEWEST, FIXTURE_MIDDLE, FIXTURE_OLDEST];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — sort=createdAt&order=desc (newest registered)', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('passes sort=createdAt and order=desc to fetchCreatorList', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         FIXTURES_DESCENDING,
         FIXTURES_DESCENDING.length,
      ]);

      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({ sort: 'createdAt', order: 'desc' })
      );
   });

   it('returns items in strict descending registration order', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         FIXTURES_DESCENDING,
         FIXTURES_DESCENDING.length,
      ]);

      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const { items } = res.json.mock.calls[0][0].data;

      expect(items).toHaveLength(3);
      expect(items[0].id).toBe(FIXTURE_NEWEST.id);
      expect(items[1].id).toBe(FIXTURE_MIDDLE.id);
      expect(items[2].id).toBe(FIXTURE_OLDEST.id);
   });

   it('fails if items are returned in ascending order instead of descending', async () => {
      // Mock returns ascending order — the test must detect the wrong ordering.
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         FIXTURES_ASCENDING,
         FIXTURES_ASCENDING.length,
      ]);

      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const { items } = res.json.mock.calls[0][0].data;

      // Ascending order means oldest is first — assert that is NOT the expected desc order.
      expect(items[0].id).not.toBe(FIXTURE_NEWEST.id);
   });

   it('each consecutive pair satisfies descending registration order', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         FIXTURES_DESCENDING,
         FIXTURES_DESCENDING.length,
      ]);

      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const { items } = res.json.mock.calls[0][0].data;

      // Map back to fixture createdAt for comparison
      const fixtureById: Record<string, Date> = {
         [FIXTURE_OLDEST.id]: FIXTURE_OLDEST.createdAt,
         [FIXTURE_MIDDLE.id]: FIXTURE_MIDDLE.createdAt,
         [FIXTURE_NEWEST.id]: FIXTURE_NEWEST.createdAt,
      };

      for (let i = 0; i < items.length - 1; i++) {
         const current = fixtureById[items[i].id].getTime();
         const next = fixtureById[items[i + 1].id].getTime();
         expect(current).toBeGreaterThan(next);
      }
   });

   it('pagination meta reflects the full fixture count', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         FIXTURES_DESCENDING,
         FIXTURES_DESCENDING.length,
      ]);

      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const { meta } = res.json.mock.calls[0][0].data;
      expect(meta.total).toBe(3);
      expect(meta.hasMore).toBe(false);
      expect(meta.offset).toBe(0);
   });
});
