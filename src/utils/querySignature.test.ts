import { strict as assert } from 'assert';
import { buildQuerySignature } from './querySignature';

async function run() {
   // Test stable output for same params in different order
   const query1 = { a: 1, b: 2, c: 3 };
   const query2 = { c: 3, b: 2, a: 1 };
   const sig1 = buildQuerySignature(query1);
   const sig2 = buildQuerySignature(query2);
   assert.equal(sig1, sig2, 'Signatures should be identical for same params in different order');

   // Test sensitive fields are excluded
   const queryWithSensitive = {
      limit: 10,
      search: 'test',
      token: 'secret123',
      password: 'pass',
      apiKey: 'key123'
   };
   const querySafe = {
      limit: 10,
      search: 'test'
   };
   const sigSensitive = buildQuerySignature(queryWithSensitive);
   const sigSafe = buildQuerySignature(querySafe);
   assert.equal(sigSensitive, sigSafe, 'Sensitive fields should be excluded from signature');

   // Test empty query returns consistent signature
   const emptySig1 = buildQuerySignature({});
   const emptySig2 = buildQuerySignature({});
   assert.equal(emptySig1, emptySig2, 'Empty query should return consistent signature');
   assert.ok(typeof emptySig1 === 'string' && emptySig1.length === 64, 'Should return 64-character hex string');

   // Test different queries produce different signatures
   const queryA = { limit: 5 };
   const queryB = { limit: 10 };
   const sigA = buildQuerySignature(queryA);
   const sigB = buildQuerySignature(queryB);
   assert.notEqual(sigA, sigB, 'Different queries should produce different signatures');

   // Test complex values are handled
   const complexQuery = {
      arr: [1, 2, 3],
      obj: { nested: 'value' },
      bool: true,
      num: 42
   };
   const complexSig = buildQuerySignature(complexQuery);
   assert.ok(typeof complexSig === 'string' && complexSig.length === 64, 'Complex values should be handled');

   console.log('querySignature.utils tests passed');
}

run().catch((err) => {
   console.error(err);
   process.exit(1);
});