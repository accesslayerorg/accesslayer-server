// src/modules/indexer/merkle-tree.service.ts
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import {
   canonicalLeafHash,
   computeInteriorHash,
   EventLeafInput,
   MerkleInclusionProof,
   MerkleSibling,
} from '../../utils/merkle';

export interface IngestEventInput extends EventLeafInput {
   network?: string;
   contractId: string;
}

export function getPartitionBounds(
   ledger: number,
   partitionSize = envConfig.PARTITION_LEDGER_RANGE
): { ledgerStart: number; ledgerEnd: number } {
   const ledgerStart = Math.floor(ledger / partitionSize) * partitionSize;
   const ledgerEnd = ledgerStart + partitionSize - 1;
   return { ledgerStart, ledgerEnd };
}

/**
 * Ingests a new contract event and updates the binary Merkle tree in O(log n) time
 * by only updating nodes along the path from the new leaf to the root.
 */
export async function ingestEventAndExtendTree(input: IngestEventInput) {
   const network = input.network || envConfig.STELLAR_NETWORK;
   const { contractId, ledger, txHash, eventIndex, topic, dataJson } = input;

   const leafHash = canonicalLeafHash({
      ledger,
      txHash,
      eventIndex,
      topic,
      dataJson,
   });

   const { ledgerStart } = getPartitionBounds(ledger);

   // Create event record in DB
   const event = await prisma.event.create({
      data: {
         network,
         contractId,
         ledger,
         txHash,
         eventIndex,
         topic,
         dataJson,
         leafHash,
      },
   });

   // Get current count of leaves at level 0 in this partition
   const leafCount = await prisma.merkleTreeState.count({
      where: {
         network,
         contractId,
         partitionStartLedger: ledgerStart,
         level: 0,
      },
   });

   const pos = leafCount;

   // Save level 0 leaf node
   await prisma.merkleTreeState.upsert({
      where: {
         network_contractId_partitionStartLedger_level_position: {
            network,
            contractId,
            partitionStartLedger: ledgerStart,
            level: 0,
            position: pos,
         },
      },
      update: { hash: leafHash },
      create: {
         network,
         contractId,
         partitionStartLedger: ledgerStart,
         level: 0,
         position: pos,
         hash: leafHash,
      },
   });

   // Update path upwards to root in O(log n)
   let currLevel = 0;
   let currPos = pos;
   let currHash = leafHash;

   while (true) {
      const parentPos = Math.floor(currPos / 2);
      const nextLevel = currLevel + 1;

      if (currPos % 2 === 0) {
         // Even node (left child): no right sibling yet, promote hash as-is
         await prisma.merkleTreeState.upsert({
            where: {
               network_contractId_partitionStartLedger_level_position: {
                  network,
                  contractId,
                  partitionStartLedger: ledgerStart,
                  level: nextLevel,
                  position: parentPos,
               },
            },
            update: { hash: currHash },
            create: {
               network,
               contractId,
               partitionStartLedger: ledgerStart,
               level: nextLevel,
               position: parentPos,
               hash: currHash,
            },
         });

         currLevel = nextLevel;
         currPos = parentPos;
      } else {
         // Odd node (right child): pair with left sibling at (currLevel, currPos - 1)
         const leftSiblingPos = currPos - 1;
         const leftNode = await prisma.merkleTreeState.findUnique({
            where: {
               network_contractId_partitionStartLedger_level_position: {
                  network,
                  contractId,
                  partitionStartLedger: ledgerStart,
                  level: currLevel,
                  position: leftSiblingPos,
               },
            },
         });

         if (!leftNode) {
            throw new Error(
               `Merkle tree corrupted: left sibling missing at level ${currLevel}, pos ${leftSiblingPos}`
            );
         }

         const parentHash = computeInteriorHash(leftNode.hash, currHash);

         await prisma.merkleTreeState.upsert({
            where: {
               network_contractId_partitionStartLedger_level_position: {
                  network,
                  contractId,
                  partitionStartLedger: ledgerStart,
                  level: nextLevel,
                  position: parentPos,
               },
            },
            update: { hash: parentHash },
            create: {
               network,
               contractId,
               partitionStartLedger: ledgerStart,
               level: nextLevel,
               position: parentPos,
               hash: parentHash,
            },
         });

         currLevel = nextLevel;
         currPos = parentPos;
         currHash = parentHash;
      }

      // Check if we reached top level of the tree
      const nodesAtNextLevel = await prisma.merkleTreeState.count({
         where: {
            network,
            contractId,
            partitionStartLedger: ledgerStart,
            level: currLevel,
         },
      });

      if (currPos === 0 && nodesAtNextLevel === 1) {
         break;
      }
   }

   return { event, rootHash: currHash };
}

/**
 * Retrieves the current root hash and event count for a partition.
 */
export async function getPartitionMerkleState(
   network: string,
   contractId: string,
   ledgerStart: number
): Promise<{ root: string; eventCount: number }> {
   const eventCount = await prisma.merkleTreeState.count({
      where: {
         network,
         contractId,
         partitionStartLedger: ledgerStart,
         level: 0,
      },
   });

   if (eventCount === 0) {
      return { root: '', eventCount: 0 };
   }

   // Find the node at the highest level, position 0
   const topNode = await prisma.merkleTreeState.findFirst({
      where: {
         network,
         contractId,
         partitionStartLedger: ledgerStart,
         position: 0,
      },
      orderBy: { level: 'desc' },
   });

   return {
      root: topNode ? topNode.hash : '',
      eventCount,
   };
}

/**
 * Generates a Merkle inclusion proof for an event by eventId.
 * Returns null if event is not found or if the event belongs to an open partition.
 */
export async function generateInclusionProof(
   eventId: string
): Promise<MerkleInclusionProof | null> {
   const event = await prisma.event.findUnique({
      where: { id: eventId },
   });

   if (!event) {
      return null;
   }

   const { ledgerStart, ledgerEnd } = getPartitionBounds(event.ledger);

   // Check if partition is closed
   const partitionRoot = await prisma.merklePartitionRoot.findUnique({
      where: {
         network_contractId_ledgerStart_ledgerEnd: {
            network: event.network,
            contractId: event.contractId,
            ledgerStart,
            ledgerEnd,
         },
      },
   });

   if (!partitionRoot || partitionRoot.status !== 'SUCCESS') {
      // Partition is not closed or publication failed
      return null;
   }

   // Find event's index at level 0
   const level0Node = await prisma.merkleTreeState.findFirst({
      where: {
         network: event.network,
         contractId: event.contractId,
         partitionStartLedger: ledgerStart,
         level: 0,
         hash: event.leafHash,
      },
   });

   if (!level0Node) {
      throw new Error(`Leaf node not found in MerkleTreeState for event ${eventId}`);
   }

   const leafIndex = level0Node.position;
   const siblings: MerkleSibling[] = [];

   let currLevel = 0;
   let currPos = leafIndex;

   while (true) {
      const nodesAtLevel = await prisma.merkleTreeState.count({
         where: {
            network: event.network,
            contractId: event.contractId,
            partitionStartLedger: ledgerStart,
            level: currLevel,
         },
      });

      if (currPos === 0 && nodesAtLevel === 1) {
         // Root level reached
         break;
      }

      if (currPos % 2 === 1) {
         // Odd node: left sibling is at currPos - 1
         const leftSibling = await prisma.merkleTreeState.findUnique({
            where: {
               network_contractId_partitionStartLedger_level_position: {
                  network: event.network,
                  contractId: event.contractId,
                  partitionStartLedger: ledgerStart,
                  level: currLevel,
                  position: currPos - 1,
               },
            },
         });

         if (leftSibling) {
            siblings.push({ hash: leftSibling.hash, side: 'left' });
         }
      } else {
         // Even node: right sibling is at currPos + 1
         const rightSibling = await prisma.merkleTreeState.findUnique({
            where: {
               network_contractId_partitionStartLedger_level_position: {
                  network: event.network,
                  contractId: event.contractId,
                  partitionStartLedger: ledgerStart,
                  level: currLevel,
                  position: currPos + 1,
               },
            },
         });

         if (rightSibling) {
            siblings.push({ hash: rightSibling.hash, side: 'right' });
         }
         // If right sibling does not exist, node was promoted as-is (no sibling added)
      }

      currPos = Math.floor(currPos / 2);
      currLevel++;
   }

   return {
      leafHash: event.leafHash,
      leafIndex,
      treeSize: partitionRoot.eventCount,
      root: partitionRoot.root,
      siblings,
      partitionId: partitionRoot.id,
      sorobanTxHash: partitionRoot.sorobanTxHash,
   };
}
