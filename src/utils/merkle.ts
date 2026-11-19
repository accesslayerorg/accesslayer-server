// src/utils/merkle.ts
// Merkle-proof event integrity system (#727)

import { createHash } from 'crypto';

export interface EventLeafInput {
   ledger: number | string | bigint;
   txHash: string;
   eventIndex: number | string;
   topic: string;
   dataJson: unknown;
}

export interface MerkleProofSibling {
   hash: string;
   side: 'left' | 'right';
}

export interface MerkleInclusionProof {
   leafHash: string;
   leafIndex: number;
   treeSize: number;
   root: string;
   siblings: MerkleProofSibling[];
   partitionId: string;
   sorobanTxHash: string | null;
}

/**
 * Deterministically serializes JSON by sorting all object keys recursively.
 */
export function canonicalizeJson(value: unknown): string {
   if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
   }

   if (Array.isArray(value)) {
      return '[' + value.map(item => canonicalizeJson(item)).join(',') + ']';
   }

   const obj = value as Record<string, unknown>;
   const sortedKeys = Object.keys(obj).sort();
   const pairs = sortedKeys.map(
      key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`
   );
   return '{' + pairs.join(',') + '}';
}

/**
 * Encodes a value into a big-endian length-prefixed buffer:
 * [4-byte big-endian unsigned length] || [payload bytes]
 */
export function encodeLengthPrefixed(value: Buffer | string | number | bigint): Buffer {
   let payload: Buffer;
   if (Buffer.isBuffer(value)) {
      payload = value;
   } else {
      payload = Buffer.from(String(value), 'utf8');
   }

   const lengthBuf = Buffer.alloc(4);
   lengthBuf.writeUInt32BE(payload.length, 0);
   return Buffer.concat([lengthBuf, payload]);
}

/**
 * Computes the deterministic leaf hash for an event:
 * sha256(ledger || txHash || eventIndex || topic || dataJson)
 * where all fields are length-prefixed big-endian bytes.
 */
export function computeEventLeafHash(event: EventLeafInput): string {
   let canonicalData: string;
   if (typeof event.dataJson === 'string') {
      try {
         const parsed = JSON.parse(event.dataJson);
         canonicalData = canonicalizeJson(parsed);
      } catch {
         canonicalData = event.dataJson;
      }
   } else {
      canonicalData = canonicalizeJson(event.dataJson);
   }

   const ledgerBuf = encodeLengthPrefixed(event.ledger);
   const txHashBuf = encodeLengthPrefixed(event.txHash);
   const eventIndexBuf = encodeLengthPrefixed(event.eventIndex);
   const topicBuf = encodeLengthPrefixed(event.topic);
   const dataJsonBuf = encodeLengthPrefixed(canonicalData);

   const combined = Buffer.concat([
      ledgerBuf,
      txHashBuf,
      eventIndexBuf,
      topicBuf,
      dataJsonBuf,
   ]);

   return createHash('sha256').update(combined).digest('hex');
}

/**
 * Computes the parent hash of two interior nodes:
 * sha256(leftChild || rightChild)
 */
export function hashPair(leftChildHex: string, rightChildHex: string): string {
   const left = Buffer.from(leftChildHex, 'hex');
   const right = Buffer.from(rightChildHex, 'hex');
   return createHash('sha256').update(Buffer.concat([left, right])).digest('hex');
}

/**
 * Reference implementation that builds a full Bitcoin-style binary Merkle tree
 * over an array of leaf hashes. Unpaired nodes are promoted as-is.
 */
export function buildFullReferenceMerkleTree(leafHashes: string[]): {
   root: string;
   levels: string[][];
} {
   if (leafHashes.length === 0) {
      return { root: '', levels: [[]] };
   }

   const levels: string[][] = [[...leafHashes]];
   let currentLevel = [...leafHashes];

   while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
         if (i + 1 < currentLevel.length) {
            nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]));
         } else {
            // Unpaired node promoted as-is
            nextLevel.push(currentLevel[i]);
         }
      }
      levels.push(nextLevel);
      currentLevel = nextLevel;
   }

   return {
      root: currentLevel[0],
      levels,
   };
}

/**
 * Recomputes the root from leafHash and sibling path and verifies it matches expectedRoot.
 */
export function verifyInclusionProof(
   proof: {
      leafHash: string;
      siblings: MerkleProofSibling[];
      root?: string;
   },
   expectedRoot: string
): boolean {
   let current = proof.leafHash.toLowerCase();

   for (const sibling of proof.siblings) {
      const siblingHash = sibling.hash.toLowerCase();
      if (sibling.side === 'left') {
         current = hashPair(siblingHash, current);
      } else {
         current = hashPair(current, siblingHash);
      }
   }

   return current.toLowerCase() === expectedRoot.toLowerCase();
}
