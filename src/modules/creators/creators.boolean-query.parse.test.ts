import { strict as assert } from 'assert';
import { CreatorListQuerySchema } from './creators.schemas';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';

function run() {
   const trueParsed = CreatorListQuerySchema.parse({
      verified: 'true',
   });
   assert.equal(trueParsed.verified, true);

   const falseParsed = CreatorListQuerySchema.parse({
      verified: '0',
   });
   assert.equal(falseParsed.verified, false);

   const invalid = parsePublicQuery(CreatorListQuerySchema, {
      verified: 'yes',
   });

   assert.equal(invalid.ok, false);
   if (invalid.ok) {
      throw new Error('Expected invalid boolean query flag to fail validation');
   }

   assert.deepEqual(invalid.details, [
      {
         field: 'verified',
         message:
            'Invalid boolean value for query parameter "verified": received "yes". Accepted values: "true", "false", "1", "0".',
      },
   ]);

   console.log('creators.boolean-query.parse tests passed');
}

run();
