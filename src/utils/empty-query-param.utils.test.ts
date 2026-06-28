import { strict as assert } from 'assert';
import { CreatorListQuerySchema } from '../modules/creators/creators.schemas';
import { coerceEmptyStringQueryParamsToUndefined } from './empty-query-param.utils';
import { parsePublicQuery } from './public-query-parse.utils';

function assertOk<T>(
   result: { ok: true; data: T } | { ok: false; details: unknown }
): T {
   if (!result.ok) {
      throw new Error('Expected query parsing to succeed');
   }

   return result.data;
}

describe('empty query param normalization', () => {
   it('treats empty string and omitted creator params the same after validation', () => {
      const omitted = assertOk(parsePublicQuery(CreatorListQuerySchema, {}));
      const emptyStrings = assertOk(
         parsePublicQuery(CreatorListQuerySchema, {
            search: '',
            verified: '',
            cursor: '',
         })
      );

      assert.deepEqual(emptyStrings, omitted);
   });

   it('leaves non-empty string values unchanged', () => {
      assert.deepEqual(
         coerceEmptyStringQueryParamsToUndefined({
            search: 'jazz',
            verified: 'false',
            cursor: 'cursor-123',
         }),
         {
            search: 'jazz',
            verified: 'false',
            cursor: 'cursor-123',
         }
      );
   });
});
