// src/modules/events/events.integration.test.ts
// Integration tests for Merkle-proof event integrity system (#727)

import request from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import {
   ingestEvent,
   closePartition,
   closeCompletedPartitions,
   getEventInclusionProof,
   recomputeRootFromState,
   setSorobanPublisher,
   resetSorobanPublisher,
   buildPartitionId,
   getPartitionBounds,
} from './events.service';
import {
   buildFullReferenceMerkleTree,
   computeEventLeafHash,
   verifyInclusionProof,
} from '../../utils/merkle';

// In-memory data structures to back mock Prisma for events module
const eventsStore = new Map<string, any>();
const merkleStateStore = new Map<string, any>();
const partitionRootStore = new Map<string, any>();

function clearStores() {
   eventsStore.clear();
   merkleStateStore.clear();
   partitionRootStore.clear();
}

// Bind mock implementations to prisma models
beforeAll(() => {
   // Event mock
   (prisma.event.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const id = data.id || `event-${eventsStore.size + 1}-${Math.random().toString(36).substring(2, 7)}`;
      const record = {
         ...data,
         id,
         createdAt: new Date(),
      };
      eventsStore.set(id, record);
      return record;
   });

   (prisma.event.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id) {
         return eventsStore.get(where.id) || null;
      }
      return null;
   });

   (prisma.event.count as jest.Mock).mockImplementation(async ({ where }: any) => {
      let count = 0;
      for (const ev of eventsStore.values()) {
         if (!where?.partitionId || ev.partitionId === where.partitionId) {
            count++;
         }
      }
      return count;
   });

   (prisma.event.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const results: any[] = [];
      for (const ev of eventsStore.values()) {
         if (!where?.partitionId || ev.partitionId === where.partitionId) {
            results.push(ev);
         }
      }
      return results;
   });

   // MerkleTreeState mock
   (prisma.merkleTreeState.upsert as jest.Mock).mockImplementation(async ({ where, create, update }: any) => {
      const { partitionId, level, position } = where.partitionId_level_position;
      const key = `${partitionId}:${level}:${position}`;
      const existing = merkleStateStore.get(key);
      const hash = update?.hash || create.hash;
      const record = {
         id: existing?.id || `state-${merkleStateStore.size + 1}`,
         partitionId,
         level,
         position,
         hash,
         createdAt: existing?.createdAt || new Date(),
         updatedAt: new Date(),
      };
      merkleStateStore.set(key, record);
      return record;
   });

   (prisma.merkleTreeState.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.partitionId_level_position) {
         const { partitionId, level, position } = where.partitionId_level_position;
         const key = `${partitionId}:${level}:${position}`;
         return merkleStateStore.get(key) || null;
      }
      return null;
   });

   (prisma.merkleTreeState.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const results: any[] = [];
      for (const node of merkleStateStore.values()) {
         if (where?.partitionId && node.partitionId !== where.partitionId) continue;
         if (where?.level !== undefined && node.level !== where.level) continue;
         results.push(node);
      }
      return results.sort((a, b) => a.position - b.position);
   });

   // MerklePartitionRoot mock
   (prisma.merklePartitionRoot.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const record = {
         id: `part-${partitionRootStore.size + 1}`,
         status: 'OPEN',
         retryCount: 0,
         lastError: null,
         sorobanTxHash: null,
         closedAt: null,
         publishedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
         ...data,
      };
      partitionRootStore.set(data.partitionId, record);
      return record;
   });

   (prisma.merklePartitionRoot.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.partitionId) {
         return partitionRootStore.get(where.partitionId) || null;
      }
      return null;
   });

   (prisma.merklePartitionRoot.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const results: any[] = [];
      for (const partition of partitionRootStore.values()) {
         if (where?.network && partition.network !== where.network) continue;
         if (where?.contractId && partition.contractId !== where.contractId) continue;
         if (where?.status && partition.status !== where.status) continue;
         if (where?.ledgerEnd?.lt !== undefined && !(partition.ledgerEnd < where.ledgerEnd.lt)) continue;
         results.push(partition);
      }
      return results.sort((a, b) => a.ledgerStart - b.ledgerStart);
   });

   (prisma.merklePartitionRoot.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const record = partitionRootStore.get(where.partitionId);
      if (!record) {
         throw new Error(`Partition ${where.partitionId} not found`);
      }
      const updated = {
         ...record,
         ...data,
         updatedAt: new Date(),
      };
      partitionRootStore.set(where.partitionId, updated);
      return updated;
   });
});

beforeEach(() => {
   clearStores();
   resetSorobanPublisher();
});

afterAll(() => {
   resetSorobanPublisher();
});

describe('Merkle-proof event integrity integration tests (#727)', () => {
   const network = 'stellar-testnet';
   const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

   it('1. Ingests 8 events, closes the partition, publishes root — verifies root matches reference implementation', async () => {
      const { ledgerStart, ledgerEnd } = getPartitionBounds(100);
      const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

      const leafHashes: string[] = [];
      const ingestedEvents: any[] = [];

      // Ingest 8 events
      for (let i = 0; i < 8; i++) {
         const result = await ingestEvent({
            network,
            contractId,
            ledger: 100 + i,
            txHash: `0x${i.toString(16).padStart(64, '0')}`,
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: `GUSER${i}`, price: (100 + i * 10).toString(), amount: '1' },
         });

         leafHashes.push(result.event.leafHash);
         ingestedEvents.push(result.event);
      }

      expect(leafHashes).toHaveLength(8);

      // Close the partition and publish
      const closedPartition = await closePartition(partitionId);

      expect(closedPartition.status).toBe('PUBLISHED');
      expect(closedPartition.eventCount).toBe(8);
      expect(closedPartition.sorobanTxHash).toBeDefined();
      expect(typeof closedPartition.sorobanTxHash).toBe('string');

      // Verify incremental root matches full reference Merkle tree
      const referenceTree = buildFullReferenceMerkleTree(leafHashes);
      expect(closedPartition.root).toBe(referenceTree.root);
   });

   it('2. Requests a proof for event at index 3 — verifies proof is valid using verifyInclusionProof', async () => {
      const { ledgerStart, ledgerEnd } = getPartitionBounds(100);
      const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

      const ingestedEvents: any[] = [];

      for (let i = 0; i < 8; i++) {
         const res = await ingestEvent({
            network,
            contractId,
            ledger: 100 + i,
            txHash: `0x${i.toString(16).padStart(64, '0')}`,
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: `GUSER${i}`, price: (100 + i * 10).toString(), amount: '1' },
         });
         ingestedEvents.push(res.event);
      }

      await closePartition(partitionId);

      const eventAtIndex3 = ingestedEvents[3];
      expect(eventAtIndex3.leafIndex).toBe(3);

      // Request proof via HTTP endpoint
      const response = await request(app)
         .get(`/events/${eventAtIndex3.id}/proof`)
         .expect(200);

      expect(response.body).toHaveProperty('leafHash', eventAtIndex3.leafHash);
      expect(response.body).toHaveProperty('leafIndex', 3);
      expect(response.body).toHaveProperty('treeSize', 8);
      expect(response.body).toHaveProperty('root');
      expect(response.body).toHaveProperty('siblings');
      expect(response.body).toHaveProperty('partitionId', partitionId);
      expect(response.body.sorobanTxHash).toBeDefined();

      // Verify proof using client-side utility
      const isValid = verifyInclusionProof(response.body, response.body.root);
      expect(isValid).toBe(true);
   });

   it("3. Tampering with an event's dataJson after ingestion causes proof verification to fail", async () => {
      const { ledgerStart, ledgerEnd } = getPartitionBounds(100);
      const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

      const ingestedEvents: any[] = [];

      for (let i = 0; i < 4; i++) {
         const res = await ingestEvent({
            network,
            contractId,
            ledger: 100 + i,
            txHash: `0x${i.toString(16).padStart(64, '0')}`,
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: `GUSER${i}`, price: '100', amount: '1' },
         });
         ingestedEvents.push(res.event);
      }

      await closePartition(partitionId);

      const targetEvent = ingestedEvents[1];
      const proof = await getEventInclusionProof(targetEvent.id);
      expect(proof).not.toBeNull();

      // Tamper with dataJson and recompute leafHash
      const tamperedLeafHash = computeEventLeafHash({
         ledger: targetEvent.ledger,
         txHash: targetEvent.txHash,
         eventIndex: targetEvent.eventIndex,
         topic: targetEvent.topic,
         dataJson: { buyer: 'GATTACKER', price: '0', amount: '1000000' }, // Tampered payload
      });

      expect(tamperedLeafHash).not.toBe(proof!.leafHash);

      // Client verifies proof against tampered leaf hash
      const isValid = verifyInclusionProof(
         {
            ...proof!,
            leafHash: tamperedLeafHash,
         },
         proof!.root
      );

      expect(isValid).toBe(false);
   });

   it('4. Requests a proof for an event in an open partition — verifies 404 is returned', async () => {
      const res = await ingestEvent({
         network,
         contractId,
         ledger: 500,
         txHash: '0xopen123456789',
         eventIndex: 0,
         topic: 'KEY_SOLD',
         dataJson: { seller: 'GSELLER1', amount: '5' },
      });

      // Do NOT close the partition (remains OPEN)
      const response = await request(app)
         .get(`/events/${res.event.id}/proof`)
         .expect(404);

      expect(response.body.error).toMatch(/not available/i);
   });

   it('5. Simulates a publication failure — verifies partition is marked PUBLICATION_FAILED and retries are attempted', async () => {
      const { ledgerStart, ledgerEnd } = getPartitionBounds(2000);
      const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

      await ingestEvent({
         network,
         contractId,
         ledger: 2000,
         txHash: '0xfail123456789',
         eventIndex: 0,
         topic: 'DIVIDEND_DISTRIBUTED',
         dataJson: { poolId: 'P1', amount: '1000' },
      });

      let attempts = 0;
      setSorobanPublisher(async () => {
         attempts++;
         throw new Error('RPC endpoint unavailable (simulated 503)');
      });

      const maxRetries = 3;
      await closePartition(partitionId, maxRetries);

      // Initial attempt (1) + 3 retries = 4 total attempts
      expect(attempts).toBe(maxRetries + 1);

      const failedPartition = partitionRootStore.get(partitionId);
      expect(failedPartition.status).toBe('PUBLICATION_FAILED');
      expect(failedPartition.retryCount).toBe(maxRetries);
      expect(failedPartition.lastError).toContain('simulated 503');
   });

   it('6. Rejects ingestion into a closed partition and leaves the published root unchanged', async () => {
      const { ledgerStart, ledgerEnd } = getPartitionBounds(100);
      const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

      for (let i = 0; i < 2; i++) {
         await ingestEvent({
            network,
            contractId,
            ledger: 100 + i,
            txHash: `0xclosed${i}`,
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: `GUSER${i}` },
         });
      }

      const closed = await closePartition(partitionId);
      const publishedRoot = closed.root;

      await expect(
         ingestEvent({
            network,
            contractId,
            ledger: 102,
            txHash: '0xclosed-after-close',
            eventIndex: 0,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: 'GLATE' },
         })
      ).rejects.toThrow(/closed partition/i);

      // The attested root must still be reproducible from the stored leaves
      expect(await recomputeRootFromState(partitionId)).toBe(publishedRoot);
      expect(partitionRootStore.get(partitionId).eventCount).toBe(2);
   });

   it('7. Recomputes the published root from MerkleTreeState rows for tree sizes 1-9', async () => {
      for (let size = 1; size <= 9; size++) {
         const partitionLedger = size * 1000;
         const { ledgerStart, ledgerEnd } = getPartitionBounds(partitionLedger);
         const partitionId = buildPartitionId(network, contractId, ledgerStart, ledgerEnd);

         const leafHashes: string[] = [];
         const eventIds: string[] = [];
         for (let i = 0; i < size; i++) {
            const res = await ingestEvent({
               network,
               contractId,
               ledger: ledgerStart + i,
               txHash: `0xsize${size}-${i}`,
               eventIndex: 0,
               topic: 'KEY_BOUGHT',
               dataJson: { buyer: `GUSER${i}`, size },
            });
            leafHashes.push(res.event.leafHash);
            eventIds.push(res.event.id);
         }

         const closed = await closePartition(partitionId);

         expect(closed.root).toBe(buildFullReferenceMerkleTree(leafHashes).root);
         expect(await recomputeRootFromState(partitionId)).toBe(closed.root);

         // Every leaf in the partition must have a client-verifiable proof,
         // including odd-sized levels where a node is promoted unpaired.
         for (const eventId of eventIds) {
            const proof = await getEventInclusionProof(eventId);
            expect(proof).not.toBeNull();
            expect(verifyInclusionProof(proof!, closed.root)).toBe(true);
         }
      }
   });

   it('8. Closes only completed partitions and does not republish an already-published root', async () => {
      const completedBounds = getPartitionBounds(100);
      const openBounds = getPartitionBounds(2000);
      const completedPartitionId = buildPartitionId(
         network,
         contractId,
         completedBounds.ledgerStart,
         completedBounds.ledgerEnd
      );
      const openPartitionId = buildPartitionId(
         network,
         contractId,
         openBounds.ledgerStart,
         openBounds.ledgerEnd
      );

      await ingestEvent({
         network,
         contractId,
         ledger: 100,
         txHash: '0xcompleted',
         eventIndex: 0,
         topic: 'KEY_BOUGHT',
         dataJson: { buyer: 'GUSER1' },
      });

      await ingestEvent({
         network,
         contractId,
         ledger: 2000,
         txHash: '0xstillopen',
         eventIndex: 0,
         topic: 'KEY_BOUGHT',
         dataJson: { buyer: 'GUSER2' },
      });

      const publisher = jest.fn(async () => ({ txHash: '0xpublishedroot' }));
      setSorobanPublisher(publisher);

      // latestLedger has advanced past the first partition's ledger range only
      const closedIds = await closeCompletedPartitions(network, contractId, 1500);

      expect(closedIds).toEqual([completedPartitionId]);
      expect(publisher).toHaveBeenCalledTimes(1);
      expect(partitionRootStore.get(completedPartitionId).status).toBe('PUBLISHED');
      expect(partitionRootStore.get(openPartitionId).status).toBe('OPEN');

      // A second sweep must not republish anything
      expect(await closeCompletedPartitions(network, contractId, 1500)).toEqual([]);

      // Closing an already-published partition directly is a no-op
      const republished = await closePartition(completedPartitionId);
      expect(republished.status).toBe('PUBLISHED');
      expect(publisher).toHaveBeenCalledTimes(1);
   });
});
