// src/utils/merkle.test.ts
import {
   canonicalizeJson,
   computeEventLeafHash,
   hashPair,
   buildFullReferenceMerkleTree,
   verifyInclusionProof,
} from './merkle';

describe('merkle.ts utilities', () => {
   describe('canonicalizeJson', () => {
      it('should sort keys deterministically at all levels', () => {
         const obj1 = {
            zebra: 'stripes',
            apple: 'red',
            nested: {
               delta: 4,
               beta: 2,
               charlie: [3, 2, 1],
               alpha: 1,
            },
         };

         const obj2 = {
            nested: {
               alpha: 1,
               beta: 2,
               delta: 4,
               charlie: [3, 2, 1],
            },
            apple: 'red',
            zebra: 'stripes',
         };

         expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
         expect(canonicalizeJson(obj1)).toBe(
            '{"apple":"red","nested":{"alpha":1,"beta":2,"charlie":[3,2,1],"delta":4},"zebra":"stripes"}'
         );
      });

      it('should handle primitives and null', () => {
         expect(canonicalizeJson(null)).toBe('null');
         expect(canonicalizeJson(123)).toBe('123');
         expect(canonicalizeJson('hello')).toBe('"hello"');
         expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
      });
   });

   describe('computeEventLeafHash', () => {
      it('should produce identical leaf hashes regardless of dataJson key order', () => {
         const eventA = {
            ledger: 1000,
            txHash: '0x1234567890abcdef',
            eventIndex: 2,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: 'GBUYER123', price: '100', amount: '10' },
         };

         const eventB = {
            ledger: 1000,
            txHash: '0x1234567890abcdef',
            eventIndex: 2,
            topic: 'KEY_BOUGHT',
            dataJson: { amount: '10', price: '100', buyer: 'GBUYER123' },
         };

         const hashA = computeEventLeafHash(eventA);
         const hashB = computeEventLeafHash(eventB);

         expect(hashA).toBe(hashB);
         expect(hashA).toHaveLength(64);
      });

      it('should also handle JSON string input for dataJson', () => {
         const eventA = {
            ledger: 1000,
            txHash: '0xabcdef',
            eventIndex: 0,
            topic: 'TEST',
            dataJson: '{"z":1,"a":2}',
         };

         const eventB = {
            ledger: 1000,
            txHash: '0xabcdef',
            eventIndex: 0,
            topic: 'TEST',
            dataJson: '{"a":2,"z":1}',
         };

         expect(computeEventLeafHash(eventA)).toBe(computeEventLeafHash(eventB));
      });

      it('should produce different hashes if any field is modified', () => {
         const base = {
            ledger: 1000,
            txHash: '0xabcdef',
            eventIndex: 0,
            topic: 'TEST',
            dataJson: { key: 'value' },
         };

         const original = computeEventLeafHash(base);
         const tampered = computeEventLeafHash({
            ...base,
            dataJson: { key: 'tampered-value' },
         });

         expect(original).not.toBe(tampered);
      });
   });

   describe('buildFullReferenceMerkleTree', () => {
      it('should compute root for single leaf', () => {
         const leaves = ['aaaa'];
         const tree = buildFullReferenceMerkleTree(leaves);
         expect(tree.root).toBe('aaaa');
         expect(tree.levels).toHaveLength(1);
      });

      it('should compute root for 2 leaves', () => {
         const leaves = [
            '1111111111111111111111111111111111111111111111111111111111111111',
            '2222222222222222222222222222222222222222222222222222222222222222',
         ];
         const tree = buildFullReferenceMerkleTree(leaves);
         expect(tree.levels).toHaveLength(2);
         expect(tree.root).toBe(hashPair(leaves[0], leaves[1]));
      });

      it('should promote unpaired nodes as-is (Bitcoin-style)', () => {
         const leaves = [
            '1111111111111111111111111111111111111111111111111111111111111111',
            '2222222222222222222222222222222222222222222222222222222222222222',
            '3333333333333333333333333333333333333333333333333333333333333333',
         ];
         const tree = buildFullReferenceMerkleTree(leaves);
         // Level 1: [hashPair(l0, l1), l2]
         const l01 = hashPair(leaves[0], leaves[1]);
         expect(tree.levels[1]).toEqual([l01, leaves[2]]);
         // Level 2: [hashPair(l01, l2)]
         const expectedRoot = hashPair(l01, leaves[2]);
         expect(tree.root).toBe(expectedRoot);
      });
   });

   describe('verifyInclusionProof', () => {
      it('should verify a valid proof', () => {
         const l0 = '1111111111111111111111111111111111111111111111111111111111111111';
         const l1 = '2222222222222222222222222222222222222222222222222222222222222222';
         const root = hashPair(l0, l1);

         const proof = {
            leafHash: l0,
            siblings: [{ hash: l1, side: 'right' as const }],
            root,
         };

         expect(verifyInclusionProof(proof, root)).toBe(true);
      });

      it('should reject a tampered leafHash', () => {
         const l0 = '1111111111111111111111111111111111111111111111111111111111111111';
         const l1 = '2222222222222222222222222222222222222222222222222222222222222222';
         const root = hashPair(l0, l1);

         const proof = {
            leafHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            siblings: [{ hash: l1, side: 'right' as const }],
            root,
         };

         expect(verifyInclusionProof(proof, root)).toBe(false);
      });
   });
});
