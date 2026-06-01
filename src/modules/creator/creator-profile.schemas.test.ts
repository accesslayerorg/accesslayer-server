import { strict as assert } from 'assert';
import { CreatorProfileParamsSchema } from './creator-profile.schemas';

function run() {
   const emptySlugResult = CreatorProfileParamsSchema.safeParse({
      creatorId: '',
   });
   assert.equal(emptySlugResult.success, false);
   assert.deepEqual(
      emptySlugResult.success ? [] : emptySlugResult.error.issues,
      [
         {
            code: 'invalid_type',
            expected: 'string',
            received: 'undefined',
            path: ['creatorId'],
            message: 'Creator ID is required',
         },
      ]
   );

   const whitespaceSlugResult = CreatorProfileParamsSchema.safeParse({
      creatorId: '   ',
   });
   assert.equal(whitespaceSlugResult.success, false);
   assert.deepEqual(
      whitespaceSlugResult.success ? [] : whitespaceSlugResult.error.issues,
      [
         {
            code: 'invalid_type',
            expected: 'string',
            received: 'undefined',
            path: ['creatorId'],
            message: 'Creator ID is required',
         },
      ]
   );

   const validSlugResult = CreatorProfileParamsSchema.safeParse({
      creatorId: 'alice',
   });
   assert.equal(validSlugResult.success, true);

   console.log('creator-profile.schemas tests passed');
}

run();
