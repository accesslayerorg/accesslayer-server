// src/utils/merkle.ts
import crypto from 'crypto';

export interface MerkleSibling {
   hash: string;
   side: 'left' | 'right';
}

export interface MerkleInclusionProof {
   leafHash: string;
   leafIndex: number;
   treeSize: number;
   root: string;
   siblings: MerkleSibling[];
   partitionId: string;
   sorobanTxHash: string | null;
}

export interface EventLeafInput {
   ledger: number;
   txHash: string;
   eventIndex: number;
   topic: string;
   dataJson: any;
}

/**
 * Recursively sorts all keys of a JSON object or array alphabetically.
 * Primitives, null, and non-objects are returned as-is.
 */
export function sortKeysRecursively(obj: any): any {
   if (obj === null || typeof obj !== 'object') {
      return obj;
   }
   if (Array.isArray(obj)) {
      return obj.map(sortKeysRecursively);
   }
   const sortedKeys = Object.keys(obj).sort();
   const sortedObj: Record<string, any> = {};
   for (const key of sortedKeys) {
      sortedObj[key] = sortKeysRecursively(obj[key]);
   }
   return sortedObj;
}

/**
 * Encodes a single field payload into length-prefixed big-endian bytes.
 * The length prefix is a 4-byte big-endian uint32.
 */
export function encodeLengthPrefixed(payload: Buffer): Buffer {
   const lenBuf = Buffer.alloc(4);
   lenBuf.writeUInt32BE(payload.length, 0);
   return Buffer.concat([lenBuf, payload]);
}

/**
 * Converts a field value into its byte representation before length-prefixing.
 */
function fieldToBuffer(val: any, isNumber = false): Buffer {
   if (Buffer.isBuffer(val)) {
      return val;
   }
   if (isNumber || typeof val === 'number') {
      const numBuf = Buffer.alloc(4);
      numBuf.writeUInt32BE(Number(val), 0);
      return numBuf;
   }
   if (typeof val === 'string') {
      return Buffer.from(val, 'utf-8');
   }
   // JSON payload or object
   const sorted = sortKeysRecursively(val);
   const jsonStr = JSON.stringify(sorted);
   return Buffer.from(jsonStr, 'utf-8');
}

/**
 * Computes the canonical leaf hash for an event:
 * sha256(ledger || txHash || eventIndex || topic || dataJson)
 * where all 5 fields are length-prefixed big-endian bytes.
 *
 * Sorting JSON keys recursively ensures determinism regardless of key ordering.
 */
export function canonicalLeafHash(event: EventLeafInput): string {
   const ledgerBuf = encodeLengthPrefixed(fieldToBuffer(event.ledger, true));
   const txHashBuf = encodeLengthPrefixed(fieldToBuffer(event.txHash));
   const eventIndexBuf = encodeLengthPrefixed(fieldToBuffer(event.eventIndex, true));
   const topicBuf = encodeLengthPrefixed(fieldToBuffer(event.topic));
   const dataJsonBuf = encodeLengthPrefixed(fieldToBuffer(event.dataJson));

   const combined = Buffer.concat([
      ledgerBuf,
      txHashBuf,
      eventIndexBuf,
      topicBuf,
      dataJsonBuf,
   ]);

   return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Computes interior node hash: sha256(leftChild || rightChild).
 * Promotes unpaired nodes as-is.
 */
export function computeInteriorHash(leftHex: string, rightHex: string): string {
   const leftBuf = Buffer.from(leftHex, 'hex');
   const rightBuf = Buffer.from(rightHex, 'hex');
   return crypto
      .createHash('sha256')
      .update(Buffer.concat([leftBuf, rightBuf]))
      .digest('hex');
}

/**
 * Client-side proof verification utility.
 * Recomputes the root hash from leafHash and siblings and asserts equality with expectedRoot.
 *
 * @throws Error if the recomputed root does not match expectedRoot.
 * @returns true if verification succeeds.
 */
export function verifyInclusionProof(
   proof: MerkleInclusionProof,
   expectedRoot: string
): boolean {
   let currentHash = proof.leafHash;

   for (const sibling of proof.siblings) {
      if (sibling.side === 'left') {
         currentHash = computeInteriorHash(sibling.hash, currentHash);
      } else {
         currentHash = computeInteriorHash(currentHash, sibling.hash);
      }
   }

   const normalizedComputed = currentHash.toLowerCase();
   const normalizedExpected = expectedRoot.toLowerCase();

   if (normalizedComputed !== normalizedExpected) {
      throw new Error(
         `Inclusion proof verification failed: expected root ${normalizedExpected}, got ${normalizedComputed}`
      );
   }

   return true;
}
