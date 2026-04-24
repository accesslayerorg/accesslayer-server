import { strict as assert } from 'assert';
import { CreatorListQuerySchema } from './creators.schemas';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';

function run() {
   const parsed = CreatorListQuerySchema.parse({
      limit: '10',
      offset: '0',
      include: 'stats',
   });

   assert.deepEqual(parsed.include, ['stats']);

   const invalid = parsePublicQuery(CreatorListQuerySchema, {
      limit: '10',
      offset: '0',
      include: 'unknown',
   });

   assert.equal(invalid.ok, false);
   if (invalid.ok) {
      throw new Error('Expected invalid include value to fail validation');
   }

   assert.deepEqual(invalid.details, [
      {
         field: 'include.0',
         message: "Invalid enum value. Expected 'stats', received 'unknown'",
      },
   ]);

   console.log('creators.include.parse tests passed');
}

run();
