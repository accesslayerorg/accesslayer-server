import { createHash } from 'crypto';
import { Address } from '@stellar/stellar-base';
import { AllocationSchema, AllocationsSchema } from './airdrop.schemas';
import type { Allocation } from './airdrop.schemas';

export interface AirdropMerkleLeaf extends Allocation {
   index: number;
   proof: string[];
}

export interface AirdropMerkleTree {
   root: string;
   leaves: AirdropMerkleLeaf[];
}

/**
 * Matches creator-keys/src/issue_primitives.rs::airdrop_leaf:
 * SHA256(Address.to_xdr(env) || amount.to_be_bytes()).
 * Address.to_xdr serializes the ScVal; amount is a signed big-endian i128.
 */
export function hashAirdropLeaf(input: Allocation): string {
   const allocation = AllocationSchema.parse({ address: input.address, amount: input.amount });
   const addressXdr = Address.fromString(allocation.address).toScVal().toXDR();
   const amountBytes = Buffer.from(BigInt(allocation.amount).toString(16).padStart(32, '0'), 'hex');
   return createHash('sha256').update(Buffer.concat([addressXdr, amountBytes])).digest('hex');
}

/** The contract sorts BytesN<32> siblings before hashing; no side/index bit is used. */
function hashPair(left: string, right: string): string {
   const a = Buffer.from(left, 'hex');
   const b = Buffer.from(right, 'hex');
   const pair = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
   return createHash('sha256').update(Buffer.concat(pair)).digest('hex');
}

export class MerkleService {
   static build(input: Allocation[]): AirdropMerkleTree {
      const allocations = AllocationsSchema.parse(input);
      let levels: string[][] = [allocations.map(hashAirdropLeaf)];
      while (levels[levels.length - 1].length > 1) {
         const current = levels[levels.length - 1];
         const next = Array.from({ length: Math.ceil(current.length / 2) }, (_, pairIndex) => {
            const left = current[pairIndex * 2];
            const right = current[pairIndex * 2 + 1];
            // The verifier consumes only siblings; promote an unmatched node.
            return right === undefined ? left : hashPair(left, right);
         });
         levels = [...levels, next];
      }

      const leaves = allocations.map((allocation, index) => {
         let position = index;
         let proof: string[] = [];
         for (const level of levels.slice(0, -1)) {
            const sibling = level[position ^ 1];
            if (sibling !== undefined) proof = [...proof, sibling];
            position = Math.floor(position / 2);
         }
         return { ...allocation, index, proof };
      });
      return { root: levels[levels.length - 1][0], leaves };
   }

   static verify(allocation: Allocation, proof: readonly string[], root: string): boolean {
      if (!/^[a-fA-F0-9]{64}$/.test(root) || proof.some(hash => !/^[a-fA-F0-9]{64}$/.test(hash))) {
         return false;
      }
      try {
         const computed = proof.reduce((hash, sibling) => hashPair(hash, sibling), hashAirdropLeaf(allocation));
         return computed === root.toLowerCase();
      } catch (_error) {
         return false;
      }
   }
}
