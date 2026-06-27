import { strict as assert } from 'assert';
import { bigIntReplacer, safeJsonStringify, sanitizeBigInts, serializeBigInt } from './bigint-serializer.utils';

function run() {
   // bigIntReplacer converts BigInt to string
   assert.equal(bigIntReplacer('id', 9007199254740993n), '9007199254740993');

   // bigIntReplacer passes non-BigInt values through unchanged
   assert.equal(bigIntReplacer('n', 42), 42);
   assert.equal(bigIntReplacer('s', 'hello'), 'hello');
   assert.equal(bigIntReplacer('b', true), true);
   assert.equal(bigIntReplacer('n', null), null);

   // safeJsonStringify handles BigInt without throwing
   const json = safeJsonStringify({ id: 1000000000000000001n, label: 'test' });
   assert.equal(json, '{"id":"1000000000000000001","label":"test"}');

   // safeJsonStringify handles nested BigInt
   const nested = safeJsonStringify({ a: { b: 2n } });
   assert.equal(nested, '{"a":{"b":"2"}}');

   // safeJsonStringify with no BigInt behaves like JSON.stringify
   assert.equal(safeJsonStringify({ x: 1 }), JSON.stringify({ x: 1 }));

   // sanitizeBigInts – top-level BigInt
   assert.equal(sanitizeBigInts(5n), '5');

   // sanitizeBigInts – nested object
   const sanitized = sanitizeBigInts({ id: 1n, nested: { amount: 500n }, label: 'ok' });
   assert.deepEqual(sanitized, { id: '1', nested: { amount: '500' }, label: 'ok' });

   // sanitizeBigInts – array
   assert.deepEqual(sanitizeBigInts([1n, 2n, 3n]), ['1', '2', '3']);

   // sanitizeBigInts – non-BigInt primitives pass through
   assert.equal(sanitizeBigInts(42), 42);
   assert.equal(sanitizeBigInts('str'), 'str');

   // serializeBigInt – top-level BigInt converts to string
   assert.equal(serializeBigInt(9007199254740993n), '9007199254740993');

   // serializeBigInt – nested BigInt in object converts correctly
   const serializedObj = serializeBigInt({ id: 1n, nested: { amount: 500n }, label: 'ok' });
   assert.deepEqual(serializedObj, { id: '1', nested: { amount: '500' }, label: 'ok' });

   // serializeBigInt – BigInt inside an array converts correctly
   assert.deepEqual(serializeBigInt([1n, 2n, 3n]), ['1', '2', '3']);

   // serializeBigInt – non-BigInt values pass through unchanged
   assert.equal(serializeBigInt(42), 42);
   assert.equal(serializeBigInt('hello'), 'hello');
   assert.deepEqual(serializeBigInt({ x: 1, y: 'str' }), { x: 1, y: 'str' });

   console.log('bigint-serializer.utils tests passed');
}

run();
