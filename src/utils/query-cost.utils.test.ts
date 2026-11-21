import {
   compileCostMap,
   computeQueryCost,
   matchCostRoute,
} from './query-cost.utils';

describe('compileCostMap', () => {
   it('compiles the default map and matches param segments', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc-123/holders');
      expect(matched?.baseCost).toBe(3);
   });

   it('does not match a different method for the same path', () => {
      const routes = compileCostMap();
      expect(matchCostRoute(routes, 'POST', '/creators')).toBeNull();
   });

   it('merges a JSON override over the defaults without dropping unrelated entries', () => {
      const routes = compileCostMap('{"GET /custom": 9}');
      expect(matchCostRoute(routes, 'GET', '/custom')?.baseCost).toBe(9);
      expect(matchCostRoute(routes, 'GET', '/creators')?.baseCost).toBe(1);
   });

   it('lets a JSON override replace a default entry', () => {
      const routes = compileCostMap('{"GET /creators": 4}');
      expect(matchCostRoute(routes, 'GET', '/creators')?.baseCost).toBe(4);
   });

   it('rejects malformed JSON', () => {
      expect(() => compileCostMap('{not json')).toThrow(/valid JSON/);
   });

   it('rejects a non-object JSON value', () => {
      expect(() => compileCostMap('[1,2,3]')).toThrow(/JSON object/);
   });

   it('rejects a non-positive-number cost', () => {
      expect(() => compileCostMap('{"GET /x": -1}')).toThrow(/positive number/);
      expect(() => compileCostMap('{"GET /x": "5"}')).toThrow(/positive number/);
   });

   it('rejects a key with no method prefix', () => {
      expect(() => compileCostMap('{"/no-method": 1}')).toThrow(/METHOD \/pattern/);
   });
});

describe('computeQueryCost', () => {
   it('uses the default cost when no route matched', () => {
      expect(computeQueryCost(null, undefined)).toBe(1);
   });

   it('uses the matched route base cost with no limit param', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc/holders');
      expect(computeQueryCost(matched, undefined)).toBe(3);
   });

   it('multiplies by a numeric limit param', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc/holders');
      expect(computeQueryCost(matched, '100')).toBe(300);
   });

   it('ignores a limit of 1 or less (no discount below base cost)', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc/holders');
      expect(computeQueryCost(matched, '1')).toBe(3);
      expect(computeQueryCost(matched, '0')).toBe(3);
   });

   it('ignores a non-numeric limit param', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc/holders');
      expect(computeQueryCost(matched, 'not-a-number')).toBe(3);
   });

   it('uses the first value when limit is an array', () => {
      const routes = compileCostMap();
      const matched = matchCostRoute(routes, 'GET', '/creators/abc/holders');
      expect(computeQueryCost(matched, ['50', '999'])).toBe(150);
   });
});
