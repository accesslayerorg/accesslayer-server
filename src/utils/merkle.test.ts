// src/utils/merkle.test.ts
import {
   sortKeysRecursively,
   canonicalLeafHash,
   computeInteriorHash,
   verifyInclusionProof,
   MerkleInclusionProof,
} from './merkle';
import crypto from 'crypto';

describe('Merkle Utilities', () => {
   describe('sortKeysRecursively', () => {
      it('sorts object keys recursively', () => {
         const input = {
            z: 1,
            a: {
               d: 4,
               c: 3,
            },
            b: [
               { y: 2, x: 1 },
               { w: 4, v: 3 },
            ],
         };

         const sorted = sortKeysRecursively(input);
         expect(JSON.stringify(sorted)).toBe(
            '{"a":{"c":3,"d":4},"b":[{"x":1,"y":2},{"v":3,"w":4}],"z":1}'
         );
      });

      it('handles primitive values, arrays, and null', () => {
         expect(sortKeysRecursively(null)).toBeNull();
         expect(sortKeysRecursively('hello')).toBe('hello');
         expect(sortKeysRecursively(123)).toBe(123);
         expect(sortKeysRecursively([3, 1, 2])).toEqual([3, 1, 2]);
      });
   });

   describe('canonicalLeafHash', () => {
      it('produces deterministic leaf hash regardless of JSON key order', () => {
         const event1 = {
            ledger: 100,
            txHash: 'tx_hash_123',
            eventIndex: 0,
            topic: 'CREATOR_REGISTERED',
            dataJson: { z: 10, a: { y: 20, x: 10 } },
         };

         const event2 = {
            ledger: 100,
            txHash: 'tx_hash_123',
            eventIndex: 0,
            topic: 'CREATOR_REGISTERED',
            dataJson: { a: { x: 10, y: 20 }, z: 10 },
         };

         const hash1 = canonicalLeafHash(event1);
         const hash2 = canonicalLeafHash(event2);

         expect(hash1).toBe(hash2);
         expect(hash1).toHaveLength(64);
      });

      it('produces different leaf hashes for different field values', () => {
         const baseEvent = {
            ledger: 100,
            txHash: 'tx_hash_123',
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { amount: '10' },
         };

         const differentLedger = { ...baseEvent, ledger: 101 };
         const differentIndex = { ...baseEvent, eventIndex: 1 };
         const differentData = { ...baseEvent, dataJson: { amount: '11' } };

         const baseHash = canonicalLeafHash(baseEvent);

         expect(canonicalLeafHash(differentLedger)).not.toBe(baseHash);
         expect(canonicalLeafHash(differentIndex)).not.toBe(baseHash);
         expect(canonicalLeafHash(differentData)).not.toBe(baseHash);
      });
   });

   describe('computeInteriorHash', () => {
      it('hashes left and right node byte buffers with sha256', () => {
         const leftHex = crypto.createHash('sha256').update('left').digest('hex');
         const rightHex = crypto.createHash('sha256').update('right').digest('hex');

         const expected = crypto
            .createHash('sha256')
            .update(
               Buffer.concat([
                  Buffer.from(leftHex, 'hex'),
                  Buffer.from(rightHex, 'hex'),
               ])
            )
            .digest('hex');

         const result = computeInteriorHash(leftHex, rightHex);
         expect(result).toBe(expected);
      });
   });

   describe('verifyInclusionProof', () => {
      it('returns true when recomputed root matches expected root', () => {
         const leafHash = crypto.createHash('sha256').update('leaf3').digest('hex');
         const leftSiblingHash = crypto
            .createHash('sha256')
            .update('leaf2')
            .digest('hex');

         // parent = sha256(leftSiblingHash || leafHash)
         const parentHash = computeInteriorHash(leftSiblingHash, leafHash);

         const rightSiblingHash = crypto
            .createHash('sha256')
            .update('parent_right')
            .digest('hex');

         // root = sha256(parentHash || rightSiblingHash)
         const rootHash = computeInteriorHash(parentHash, rightSiblingHash);

         const proof: MerkleInclusionProof = {
            leafHash,
            leafIndex: 3,
            treeSize: 4,
            root: rootHash,
            siblings: [
               { hash: leftSiblingHash, side: 'left' },
               { hash: rightSiblingHash, side: 'right' },
            ],
            partitionId: 'partition-1',
            sorobanTxHash: 'tx-123',
         };

         expect(verifyInclusionProof(proof, rootHash)).toBe(true);
      });

      it('throws an error when recomputed root does not match expected root', () => {
         const leafHash = crypto.createHash('sha256').update('leaf3').digest('hex');
         const leftSiblingHash = crypto
            .createHash('sha256')
            .update('leaf2')
            .digest('hex');

         const proof: MerkleInclusionProof = {
            leafHash,
            leafIndex: 3,
            treeSize: 4,
            root: 'invalid_root_hash',
            siblings: [{ hash: leftSiblingHash, side: 'left' }],
            partitionId: 'partition-1',
            sorobanTxHash: 'tx-123',
         };

         expect(() =>
            verifyInclusionProof(proof, '0000000000000000000000000000000000000000000000000000000000000000')
         ).toThrow(/Inclusion proof verification failed/);
      });
   });
});
