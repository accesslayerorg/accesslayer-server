// src/modules/events/events.service.ts
// Merkle-proof event integrity service (#727)

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   computeEventLeafHash,
   hashPair,
   MerkleProofSibling,
} from '../../utils/merkle';
import type {
   IngestEventInput,
   IngestEventResult,
   EventInclusionProofResponse,
   PublishRootParams,
} from './events.types';

export const DEFAULT_PARTITION_LEDGER_RANGE = 1000;

export type SorobanPublisher = (
   params: PublishRootParams
) => Promise<{ txHash: string }>;

/** Default in-memory/simulated Soroban root publisher (can be overridden in tests or config) */
let activeSorobanPublisher: SorobanPublisher = async params => {
   // Generates a mock or real Soroban tx hash
   const txHash =
      '0x' +
      Buffer.from(
         `${params.network}:${params.contractId}:${params.ledgerStart}:${params.root}`
      )
         .toString('hex')
         .padEnd(64, '0')
         .slice(0, 64);
   return { txHash };
};

export function setSorobanPublisher(publisher: SorobanPublisher): void {
   activeSorobanPublisher = publisher;
}

export function resetSorobanPublisher(): void {
   activeSorobanPublisher = async params => {
      const txHash =
         '0x' +
         Buffer.from(
            `${params.network}:${params.contractId}:${params.ledgerStart}:${params.root}`
         )
            .toString('hex')
            .padEnd(64, '0')
            .slice(0, 64);
      return { txHash };
   };
}

/**
 * Derives partition ID and ledger bounds for an event based on its network, contractId, and ledger.
 */
export function getPartitionBounds(
   ledger: number,
   range = DEFAULT_PARTITION_LEDGER_RANGE
): { ledgerStart: number; ledgerEnd: number } {
   const partitionIndex = Math.floor(ledger / range);
   const ledgerStart = partitionIndex * range;
   const ledgerEnd = ledgerStart + range - 1;
   return { ledgerStart, ledgerEnd };
}

export function buildPartitionId(
   network: string,
   contractId: string,
   ledgerStart: number,
   ledgerEnd: number
): string {
   return `${network}:${contractId}:${ledgerStart}-${ledgerEnd}`;
}

/**
 * Extends the binary Merkle tree incrementally in O(log n) by updating only
 * the path from the new leaf at position `leafIndex` to the root.
 */
export async function extendTreeIncremental(
   partitionId: string,
   leafIndex: number,
   leafHash: string
): Promise<string> {
   const treeSize = leafIndex + 1;
   const maxLevel = treeSize <= 1 ? 0 : Math.ceil(Math.log2(treeSize));

   // 1. Store leaf at level 0
   await prisma.merkleTreeState.upsert({
      where: {
         partitionId_level_position: {
            partitionId,
            level: 0,
            position: leafIndex,
         },
      },
      update: { hash: leafHash },
      create: {
         partitionId,
         level: 0,
         position: leafIndex,
         hash: leafHash,
      },
   });

   // 2. Traverse up from level 0 to maxLevel
   let currLevel = 0;
   let currPos = leafIndex;
   let currHash = leafHash;

   while (currLevel < maxLevel) {
      if (currPos % 2 === 1) {
         // Right child: pair with left sibling at currPos - 1
         const leftSibling = await prisma.merkleTreeState.findUnique({
            where: {
               partitionId_level_position: {
                  partitionId,
                  level: currLevel,
                  position: currPos - 1,
               },
            },
         });

         const leftHash = leftSibling ? leftSibling.hash : currHash;
         const parentHash = hashPair(leftHash, currHash);

         currLevel += 1;
         currPos = Math.floor(currPos / 2);
         currHash = parentHash;

         await prisma.merkleTreeState.upsert({
            where: {
               partitionId_level_position: {
                  partitionId,
                  level: currLevel,
                  position: currPos,
               },
            },
            update: { hash: currHash },
            create: {
               partitionId,
               level: currLevel,
               position: currPos,
               hash: currHash,
            },
         });
      } else {
         // Even position: unpaired at this level so far, promoted as-is
         currLevel += 1;
         currPos = Math.floor(currPos / 2);

         await prisma.merkleTreeState.upsert({
            where: {
               partitionId_level_position: {
                  partitionId,
                  level: currLevel,
                  position: currPos,
               },
            },
            update: { hash: currHash },
            create: {
               partitionId,
               level: currLevel,
               position: currPos,
               hash: currHash,
            },
         });
      }
   }

   // Node at maxLevel, position 0 is the root
   return currHash;
}

/**
 * Recomputes the tree root directly from stored MerkleTreeState node hashes.
 */
export async function getRootFromState(
   partitionId: string,
   treeSize: number
): Promise<string> {
   if (treeSize === 0) return '';
   const maxLevel = treeSize <= 1 ? 0 : Math.ceil(Math.log2(treeSize));
   const rootNode = await prisma.merkleTreeState.findUnique({
      where: {
         partitionId_level_position: {
            partitionId,
            level: maxLevel,
            position: 0,
         },
      },
   });

   return rootNode ? rootNode.hash : '';
}

/**
 * Publishes the Merkle root to the Soroban attestation contract with up to 3 retries
 * and exponential backoff.
 */
export async function publishRootWithRetry(
   partitionId: string,
   params: PublishRootParams,
   maxRetries = 3
): Promise<{ success: boolean; txHash?: string; error?: string }> {
   let lastError: Error | null = null;

   for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
         const result = await activeSorobanPublisher(params);

         // Success: update partition root table
         await prisma.merklePartitionRoot.update({
            where: { partitionId },
            data: {
               status: 'PUBLISHED',
               sorobanTxHash: result.txHash,
               publishedAt: new Date(),
               retryCount: attempt,
               lastError: null,
            },
         });

         logger.info(
            {
               partitionId,
               root: params.root,
               eventCount: params.eventCount,
               sorobanTxHash: result.txHash,
               attempts: attempt + 1,
            },
            'Published Merkle root to Soroban'
         );

         return { success: true, txHash: result.txHash };
      } catch (err: any) {
         lastError = err;
         logger.warn(
            {
               partitionId,
               attempt: attempt + 1,
               maxRetries,
               error: err?.message,
            },
            'Soroban root publication attempt failed'
         );

         if (attempt < maxRetries) {
            // Exponential backoff: 50ms, 100ms, 200ms in tests/production
            const delay = 50 * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
         }
      }
   }

   // All retries failed
   const errorMessage = lastError?.message || 'Publication retries exhausted';
   await prisma.merklePartitionRoot.update({
      where: { partitionId },
      data: {
         status: 'PUBLICATION_FAILED',
         lastError: errorMessage,
         retryCount: maxRetries,
      },
   });

   logger.error(
      {
         partitionId,
         root: params.root,
         attempts: maxRetries + 1,
         error: errorMessage,
      },
      'CRITICAL: Failed to publish Merkle partition root to Soroban after retries'
   );

   return { success: false, error: errorMessage };
}

/**
 * Rebuilds the partition root from the persisted MerkleTreeState rows alone,
 * rehashing upwards from level 0. Unlike getRootFromState (which reads the
 * stored root node in O(1)), this proves the stored root is actually
 * reproducible from the committed leaves and can be used as an integrity
 * audit of a partition.
 */
export async function recomputeRootFromState(
   partitionId: string
): Promise<string> {
   const leafNodes = await prisma.merkleTreeState.findMany({
      where: { partitionId, level: 0 },
      orderBy: { position: 'asc' },
   });

   if (leafNodes.length === 0) return '';

   let currentLevel = leafNodes.map(node => node.hash);

   while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
         if (i + 1 < currentLevel.length) {
            nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]));
         } else {
            // Unpaired node promoted as-is (Bitcoin-style)
            nextLevel.push(currentLevel[i]);
         }
      }
      currentLevel = nextLevel;
   }

   return currentLevel[0];
}

/**
 * Closes an open partition, marks it CLOSED, and triggers publication to Soroban.
 * Closing an already-published partition is a no-op so a retried or duplicated
 * close cannot submit a second on-chain attestation for the same root.
 */
export async function closePartition(
   partitionId: string,
   maxRetries = 3
): Promise<any> {
   const partition = await prisma.merklePartitionRoot.findUnique({
      where: { partitionId },
   });

   if (!partition) {
      throw new Error(`Partition ${partitionId} not found`);
   }

   if (partition.status === 'PUBLISHED') {
      return partition;
   }

   await prisma.merklePartitionRoot.update({
      where: { partitionId },
      data: {
         status: 'CLOSED',
         closedAt: new Date(),
      },
   });

   // Publish root on-chain
   await publishRootWithRetry(
      partitionId,
      {
         network: partition.network,
         contractId: partition.contractId,
         ledgerStart: partition.ledgerStart,
         ledgerEnd: partition.ledgerEnd,
         root: partition.root,
         eventCount: partition.eventCount,
      },
      maxRetries
   );

   return prisma.merklePartitionRoot.findUnique({
      where: { partitionId },
   });
}

/**
 * Closes every open partition for a (network, contractId) whose ledger range has
 * been completed by the chain, publishing each root to Soroban.
 * Returns the closed partition ids.
 */
export async function closeCompletedPartitions(
   network: string,
   contractId: string,
   latestLedger: number,
   maxRetries = 3
): Promise<string[]> {
   const completed = await prisma.merklePartitionRoot.findMany({
      where: {
         network,
         contractId,
         status: 'OPEN',
         ledgerEnd: { lt: latestLedger },
      },
      orderBy: { ledgerStart: 'asc' },
   });

   const closedPartitionIds: string[] = [];

   for (const partition of completed) {
      await closePartition(partition.partitionId, maxRetries);
      closedPartitionIds.push(partition.partitionId);
   }

   return closedPartitionIds;
}

/**
 * Ingests a new contract event, computes canonical leaf hash, appends to the
 * incremental Merkle tree in O(log n), and updates partition state.
 */
export async function ingestEvent(
   input: IngestEventInput,
   partitionLedgerRange = DEFAULT_PARTITION_LEDGER_RANGE
): Promise<IngestEventResult> {
   const { ledgerStart, ledgerEnd } = getPartitionBounds(
      input.ledger,
      partitionLedgerRange
   );
   const partitionId = buildPartitionId(
      input.network,
      input.contractId,
      ledgerStart,
      ledgerEnd
   );

   const dataJsonString =
      typeof input.dataJson === 'string'
         ? input.dataJson
         : JSON.stringify(input.dataJson);

   const leafHash = computeEventLeafHash({
      ledger: input.ledger,
      txHash: input.txHash,
      eventIndex: input.eventIndex,
      topic: input.topic,
      dataJson: dataJsonString,
   });

   // Get current leaf count in this partition
   const existingCount = await prisma.event.count({
      where: { partitionId },
   });
   const leafIndex = existingCount;

   // 1. Create or ensure partition root record
   let partitionRoot = await prisma.merklePartitionRoot.findUnique({
      where: { partitionId },
   });

   // Once a partition is closed its root is final (and may already be attested
   // on-chain), so appending another leaf would silently invalidate every
   // proof served for that partition.
   if (partitionRoot && partitionRoot.status !== 'OPEN') {
      throw new Error(
         `Partition ${partitionId} is ${partitionRoot.status}; cannot append events to a closed partition`
      );
   }

   if (!partitionRoot) {
      partitionRoot = await prisma.merklePartitionRoot.create({
         data: {
            partitionId,
            network: input.network,
            contractId: input.contractId,
            ledgerStart,
            ledgerEnd,
            root: leafHash,
            eventCount: 0,
            status: 'OPEN',
         },
      });
   }

   // 2. Persist event with leafHash
   const event = await prisma.event.create({
      data: {
         network: input.network,
         contractId: input.contractId,
         ledger: input.ledger,
         txHash: input.txHash,
         eventIndex: input.eventIndex,
         topic: input.topic,
         dataJson: dataJsonString,
         leafHash,
         leafIndex,
         partitionId,
      },
   });

   // 3. Extend incremental Merkle tree in O(log n)
   const newRoot = await extendTreeIncremental(partitionId, leafIndex, leafHash);

   // 4. Update partition root state
   const updatedPartition = await prisma.merklePartitionRoot.update({
      where: { partitionId },
      data: {
         root: newRoot,
         eventCount: leafIndex + 1,
      },
   });

   return {
      event,
      partitionClosed: updatedPartition.status !== 'OPEN',
      root: newRoot,
      partitionRoot: updatedPartition,
   };
}

/**
 * Helper to compute node count at a given level for a tree of size K.
 */
function getLevelNodeCount(treeSize: number, level: number): number {
   let count = treeSize;
   for (let l = 0; l < level; l++) {
      count = Math.ceil(count / 2);
   }
   return count;
}

/**
 * Generates a Merkle inclusion proof for an event by collecting siblings
 * from the stored MerkleTreeState.
 */
export async function getEventInclusionProof(
   eventId: string
): Promise<EventInclusionProofResponse | null> {
   const event = await prisma.event.findUnique({
      where: { id: eventId },
   });

   if (!event) {
      return null;
   }

   const partition = await prisma.merklePartitionRoot.findUnique({
      where: { partitionId: event.partitionId },
   });

   // Proof is only available for closed or published partitions
   if (!partition || partition.status === 'OPEN') {
      return null;
   }

   const treeSize = partition.eventCount;
   const maxLevel = treeSize <= 1 ? 0 : Math.ceil(Math.log2(treeSize));

   const siblings: MerkleProofSibling[] = [];
   let currPos = event.leafIndex;

   for (let level = 0; level < maxLevel; level++) {
      const levelCount = getLevelNodeCount(treeSize, level);

      if (currPos % 2 === 1) {
         // Right child -> left sibling is at currPos - 1
         const leftSibling = await prisma.merkleTreeState.findUnique({
            where: {
               partitionId_level_position: {
                  partitionId: event.partitionId,
                  level,
                  position: currPos - 1,
               },
            },
         });

         if (leftSibling) {
            siblings.push({ hash: leftSibling.hash, side: 'left' });
         }
      } else {
         // Left child -> check if right sibling exists
         if (currPos + 1 < levelCount) {
            const rightSibling = await prisma.merkleTreeState.findUnique({
               where: {
                  partitionId_level_position: {
                     partitionId: event.partitionId,
                     level,
                     position: currPos + 1,
                  },
               },
            });

            if (rightSibling) {
               siblings.push({ hash: rightSibling.hash, side: 'right' });
            }
         }
         // If currPos + 1 >= levelCount, node was promoted as-is (no sibling)
      }

      currPos = Math.floor(currPos / 2);
   }

   return {
      leafHash: event.leafHash,
      leafIndex: event.leafIndex,
      treeSize,
      root: partition.root,
      siblings,
      partitionId: event.partitionId,
      sorobanTxHash: partition.sorobanTxHash,
   };
}
