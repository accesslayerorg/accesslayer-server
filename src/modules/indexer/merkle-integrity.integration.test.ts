// src/modules/indexer/merkle-integrity.integration.test.ts
import supertest from 'supertest';
import app from '../../app';
import {
   canonicalLeafHash,
   computeInteriorHash,
   verifyInclusionProof,
} from '../../utils/merkle';
import {
   ingestEventAndExtendTree,
   getPartitionBounds,
} from './merkle-tree.service';
import { closeAndPublishPartition } from './soroban-attestation.service';

// In-memory mock store for Prisma models to ensure tests run reliably in all environments
const store = {
   events: new Map<string, any>(),
   treeState: new Map<string, any>(),
   partitionRoots: new Map<string, any>(),
};

function clearStore() {
   store.events.clear();
   store.treeState.clear();
   store.partitionRoots.clear();
}

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      event: {
         create: jest.fn().mockImplementation(async ({ data }: any) => {
            const id = `ev-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
            const record = { id, createdAt: new Date(), ...data };
            store.events.set(id, record);
            return record;
         }),
         findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where.id) {
               return store.events.get(where.id) || null;
            }
            return null;
         }),
         deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where.contractId) {
               for (const [id, ev] of store.events.entries()) {
                  if (ev.contractId === where.contractId) store.events.delete(id);
               }
            } else {
               store.events.clear();
            }
            return { count: 0 };
         }),
      },
      merkleTreeState: {
         count: jest.fn().mockImplementation(async ({ where }: any) => {
            let count = 0;
            for (const node of store.treeState.values()) {
               let match = true;
               if (where.network && node.network !== where.network) match = false;
               if (where.contractId && node.contractId !== where.contractId) match = false;
               if (where.partitionStartLedger !== undefined && node.partitionStartLedger !== where.partitionStartLedger) match = false;
               if (where.level !== undefined && node.level !== where.level) match = false;
               if (match) count++;
            }
            return count;
         }),
         upsert: jest.fn().mockImplementation(async ({ where, update, create }: any) => {
            const compoundKey = where.network_contractId_partitionStartLedger_level_position;
            const key = `${compoundKey.network}:${compoundKey.contractId}:${compoundKey.partitionStartLedger}:${compoundKey.level}:${compoundKey.position}`;
            const existing = store.treeState.get(key);
            const record = existing
               ? { ...existing, ...update, updatedAt: new Date() }
               : { id: `tree-${Date.now()}-${Math.random()}`, createdAt: new Date(), updatedAt: new Date(), ...create };
            store.treeState.set(key, record);
            return record;
         }),
         findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            const compoundKey = where.network_contractId_partitionStartLedger_level_position;
            const key = `${compoundKey.network}:${compoundKey.contractId}:${compoundKey.partitionStartLedger}:${compoundKey.level}:${compoundKey.position}`;
            return store.treeState.get(key) || null;
         }),
         findFirst: jest.fn().mockImplementation(async ({ where, orderBy }: any) => {
            let results: any[] = [];
            for (const node of store.treeState.values()) {
               let match = true;
               if (where.network && node.network !== where.network) match = false;
               if (where.contractId && node.contractId !== where.contractId) match = false;
               if (where.partitionStartLedger !== undefined && node.partitionStartLedger !== where.partitionStartLedger) match = false;
               if (where.level !== undefined && node.level !== where.level) match = false;
               if (where.position !== undefined && node.position !== where.position) match = false;
               if (where.hash !== undefined && node.hash !== where.hash) match = false;
               if (match) results.push(node);
            }
            if (orderBy?.level === 'desc') {
               results.sort((a, b) => b.level - a.level);
            }
            return results[0] || null;
         }),
         deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where.contractId) {
               for (const [key, node] of store.treeState.entries()) {
                  if (node.contractId === where.contractId) store.treeState.delete(key);
               }
            } else {
               store.treeState.clear();
            }
            return { count: 0 };
         }),
      },
      merklePartitionRoot: {
         upsert: jest.fn().mockImplementation(async ({ where, update, create }: any) => {
            const compoundKey = where.network_contractId_ledgerStart_ledgerEnd;
            const key = `${compoundKey.network}:${compoundKey.contractId}:${compoundKey.ledgerStart}:${compoundKey.ledgerEnd}`;
            const existing = store.partitionRoots.get(key);
            const record = existing
               ? { ...existing, ...update, updatedAt: new Date() }
               : { id: `part-${Date.now()}-${Math.random()}`, createdAt: new Date(), updatedAt: new Date(), ...create };
            store.partitionRoots.set(key, record);
            return record;
         }),
         findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            const compoundKey = where.network_contractId_ledgerStart_ledgerEnd;
            const key = `${compoundKey.network}:${compoundKey.contractId}:${compoundKey.ledgerStart}:${compoundKey.ledgerEnd}`;
            return store.partitionRoots.get(key) || null;
         }),
         deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where.contractId) {
               for (const [key, part] of store.partitionRoots.entries()) {
                  if (part.contractId === where.contractId) store.partitionRoots.delete(key);
               }
            } else {
               store.partitionRoots.clear();
            }
            return { count: 0 };
         }),
      },
      $disconnect: jest.fn().mockResolvedValue(undefined),
   },
}));

describe('Merkle-Proof Integrity Layer Integration Tests', () => {
   const contractId = 'CC123456789012345678901234567890123456789012345678901234';
   const network = 'testnet';
   let eventIds: string[] = [];
   let expectedRoot: string = '';

   beforeAll(async () => {
      clearStore();
   });

   afterAll(async () => {
      clearStore();
   });

   it('Scenario 1: Ingest 8 events, close partition, publish root — verify root matches reference implementation', async () => {
      const referenceLeafHashes: string[] = [];

      for (let i = 0; i < 8; i++) {
         const eventPayload = {
            network,
            contractId,
            ledger: 100 + i,
            txHash: `tx_hash_${i}`,
            eventIndex: i,
            topic: 'KEY_BOUGHT',
            dataJson: { buyer: `G_BUYER_${i}`, amount: `${(i + 1) * 10}` },
         };

         const leafHash = canonicalLeafHash(eventPayload);
         referenceLeafHashes.push(leafHash);

         const result = await ingestEventAndExtendTree(eventPayload);
         eventIds.push(result.event.id);
      }

      // Compute reference Merkle root manually:
      // Level 0: L0_0..L0_7
      // Level 1: N1_0 = H(L0_0, L0_1), N1_1 = H(L0_2, L0_3), N1_2 = H(L0_4, L0_5), N1_3 = H(L0_6, L0_7)
      // Level 2: N2_0 = H(N1_0, N1_1), N2_1 = H(N1_2, N1_3)
      // Level 3 (Root): N3_0 = H(N2_0, N2_1)
      const n1_0 = computeInteriorHash(referenceLeafHashes[0], referenceLeafHashes[1]);
      const n1_1 = computeInteriorHash(referenceLeafHashes[2], referenceLeafHashes[3]);
      const n1_2 = computeInteriorHash(referenceLeafHashes[4], referenceLeafHashes[5]);
      const n1_3 = computeInteriorHash(referenceLeafHashes[6], referenceLeafHashes[7]);

      const n2_0 = computeInteriorHash(n1_0, n1_1);
      const n2_1 = computeInteriorHash(n1_2, n1_3);

      expectedRoot = computeInteriorHash(n2_0, n2_1);

      // Close partition ledgers 0-999
      const { ledgerStart, ledgerEnd } = getPartitionBounds(100);
      const partitionRecord = await closeAndPublishPartition(
         network,
         contractId,
         ledgerStart,
         ledgerEnd
      );

      expect(partitionRecord.status).toBe('SUCCESS');
      expect(partitionRecord.eventCount).toBe(8);
      expect(partitionRecord.root).toBe(expectedRoot);
      expect(partitionRecord.sorobanTxHash).toBeDefined();
      expect(typeof partitionRecord.sorobanTxHash).toBe('string');
   });

   it('Scenario 2: Request proof for event at index 3 — verify proof is valid using client utility', async () => {
      const event3Id = eventIds[3];
      const res = await supertest(app).get(`/api/v1/events/${event3Id}/proof`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const proof = res.body.data;
      expect(proof.leafIndex).toBe(3);
      expect(proof.treeSize).toBe(8);
      expect(proof.root).toBe(expectedRoot);
      expect(proof.siblings).toHaveLength(3);

      // Verify proof using client-side utility function
      const isValid = verifyInclusionProof(proof, expectedRoot);
      expect(isValid).toBe(true);
   });

   it('Scenario 3: Tamper with event dataJson after ingestion — verify proof fails verification', async () => {
      const event3Id = eventIds[3];
      const res = await supertest(app).get(`/api/v1/events/${event3Id}/proof`);
      const originalProof = res.body.data;

      // Create tampered event payload
      const tamperedEvent = {
         ledger: 103,
         txHash: 'tx_hash_3',
         eventIndex: 3,
         topic: 'KEY_BOUGHT',
         dataJson: { buyer: 'G_BUYER_3', amount: '999999' }, // tampered amount!
      };

      const tamperedLeafHash = canonicalLeafHash(tamperedEvent);
      const tamperedProof = {
         ...originalProof,
         leafHash: tamperedLeafHash,
      };

      expect(() => verifyInclusionProof(tamperedProof, expectedRoot)).toThrow(
         /Inclusion proof verification failed/
      );
   });

   it('Scenario 4: Request proof for an event in an open partition — verify 404 is returned', async () => {
      // Ingest an event into an open partition (ledgers 1000-1999) that has not been closed
      const openEventResult = await ingestEventAndExtendTree({
         network,
         contractId,
         ledger: 1500,
         txHash: 'tx_hash_open_partition',
         eventIndex: 0,
         topic: 'KEY_SOLD',
         dataJson: { seller: 'G_SELLER_OPEN', amount: '50' },
      });

      const res = await supertest(app).get(
         `/api/v1/events/${openEventResult.event.id}/proof`
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });

   it('Scenario 5: Simulate a publication failure — verify partition is marked PUBLICATION_FAILED and retried', async () => {
      const failContractId = 'CC_FAIL_CONTRACT_TEST_1234567890';
      const failLedger = 2500;
      const { ledgerStart, ledgerEnd } = getPartitionBounds(failLedger);

      await ingestEventAndExtendTree({
         network,
         contractId: failContractId,
         ledger: failLedger,
         txHash: 'tx_fail_pub',
         eventIndex: 0,
         topic: 'TEST_EVENT',
         dataJson: { test: true },
      });

      let attempts = 0;
      const failingPublisher = jest.fn().mockImplementation(async () => {
         attempts++;
         throw new Error(`Soroban RPC connection error attempt ${attempts}`);
      });

      const partitionRecord = await closeAndPublishPartition(
         network,
         failContractId,
         ledgerStart,
         ledgerEnd,
         {
            publisher: failingPublisher,
            maxRetries: 3,
            initialBackoffMs: 1,
         }
      );

      expect(failingPublisher).toHaveBeenCalledTimes(3);
      expect(partitionRecord.status).toBe('PUBLICATION_FAILED');
      expect(partitionRecord.sorobanTxHash).toBeNull();
   });
});
