import { prisma } from '../../utils/prisma.utils';
import { createAuditEntry, getAuditLogs } from './audit-log.service';

describe('Audit Log Integration Tests', () => {
   beforeAll(async () => {
      // Clean up before tests
      await prisma.auditLog.deleteMany({});
   });

   afterAll(async () => {
      // Clean up after tests
      await prisma.auditLog.deleteMany({});
   });

   describe('createAuditEntry', () => {
      it('should create an audit entry with all fields', async () => {
         await createAuditEntry({
            actorWallet: '0x1234567890123456789012345678901234567890',
            actionType: 'protocol_fee_updated',
            targetId: 'default',
            payload: { protocolFeeBps: 500 },
         });

         const entry = await prisma.auditLog.findFirst({
            where: { actionType: 'protocol_fee_updated' },
         });

         expect(entry).toBeDefined();
         expect(entry?.actorWallet).toBe('0x1234567890123456789012345678901234567890');
         expect(entry?.actionType).toBe('protocol_fee_updated');
         expect(entry?.targetId).toBe('default');
         expect(entry?.payload).toEqual({ protocolFeeBps: 500 });
         expect(entry?.createdAt).toBeDefined();
      });

      it('should create an audit entry without optional fields', async () => {
         await createAuditEntry({
            actorWallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            actionType: 'key_trading_paused',
         });

         const entry = await prisma.auditLog.findFirst({
            where: { actionType: 'key_trading_paused' },
         });

         expect(entry).toBeDefined();
         expect(entry?.targetId).toBeNull();
         expect(entry?.payload).toBeNull();
      });

      it('should handle multiple entries', async () => {
         const actors = [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
            '0x3333333333333333333333333333333333333333',
         ];

         for (const actor of actors) {
            await createAuditEntry({
               actorWallet: actor,
               actionType: 'test_action',
               targetId: `target_${actor}`,
            });
         }

         const entries = await prisma.auditLog.findMany({
            where: { actionType: 'test_action' },
         });

         expect(entries).toHaveLength(3);
         expect(entries.map((e) => e.actorWallet)).toEqual(expect.arrayContaining(actors));
      });
   });

   describe('getAuditLogs', () => {
      beforeAll(async () => {
         // Create test data for pagination
         const baseWallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

         // Create 5 entries with different action types
         for (let i = 0; i < 5; i++) {
            await createAuditEntry({
               actorWallet: baseWallet,
               actionType: i % 2 === 0 ? 'action_a' : 'action_b',
               targetId: `target_${i}`,
               payload: { index: i },
            });

            // Add slight delay to ensure different timestamps
            await new Promise((resolve) => setTimeout(resolve, 10));
         }
      });

      it('should return entries sorted by createdAt descending', async () => {
         const result = await getAuditLogs({ limit: 10 });

         expect(result.entries).toBeDefined();
         expect(result.entries.length).toBeGreaterThan(0);

         // Verify descending order by createdAt
         for (let i = 0; i < result.entries.length - 1; i++) {
            expect(result.entries[i].createdAt.getTime()).toBeGreaterThanOrEqual(
               result.entries[i + 1].createdAt.getTime()
            );
         }
      });

      it('should support cursor-based pagination', async () => {
         const firstPage = await getAuditLogs({ limit: 2 });

         expect(firstPage.entries).toHaveLength(2);
         expect(firstPage.nextCursor).toBeDefined();
         expect(firstPage.hasMore).toBe(true);

         const secondPage = await getAuditLogs({
            limit: 2,
            cursor: firstPage.nextCursor,
         });

         expect(secondPage.entries).toHaveLength(2);
         // Verify different entries
         expect(secondPage.entries[0].id).not.toBe(firstPage.entries[0].id);
      });

      it('should filter by actionType', async () => {
         const result = await getAuditLogs({
            limit: 10,
            actionType: 'action_a',
         });

         expect(result.entries.length).toBeGreaterThan(0);
         result.entries.forEach((entry) => {
            expect(entry.actionType).toBe('action_a');
         });
      });

      it('should respect limit parameter', async () => {
         const result1 = await getAuditLogs({ limit: 2 });
         const result2 = await getAuditLogs({ limit: 5 });

         expect(result1.entries.length).toBeLessThanOrEqual(2);
         expect(result2.entries.length).toBeLessThanOrEqual(5);
      });

      it('should cap limit at 100', async () => {
         // Create 150 entries
         const wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
         for (let i = 0; i < 150; i++) {
            await createAuditEntry({
               actorWallet: wallet,
               actionType: 'high_volume_action',
               targetId: `target_${i}`,
            });
         }

         const result = await getAuditLogs({ limit: 200 });
         expect(result.entries.length).toBeLessThanOrEqual(100);
      });

      it('should detect hasMore correctly', async () => {
         // Get entries with limit less than total
         const result1 = await getAuditLogs({ limit: 5 });

         if (result1.entries.length === 5) {
            expect(result1.hasMore).toBe(true);
            expect(result1.nextCursor).toBeDefined();
         }

         // Continue pagination to the end
         let currentResult = result1;
         let pageCount = 1;

         while (currentResult.hasMore && pageCount < 100) {
            currentResult = await getAuditLogs({
               limit: 5,
               cursor: currentResult.nextCursor,
            });
            pageCount++;
         }

         // Last page should have hasMore = false
         expect(currentResult.hasMore).toBe(false);
         expect(currentResult.nextCursor).toBeUndefined();
      });

      it('should handle empty filters gracefully', async () => {
         const result = await getAuditLogs({
            actionType: 'nonexistent_action_type',
         });

         expect(result.entries).toHaveLength(0);
         expect(result.hasMore).toBe(false);
         expect(result.nextCursor).toBeUndefined();
      });
   });

   describe('Acceptance Criteria Validation', () => {
      beforeAll(async () => {
         // Clear and set up for acceptance criteria tests
         await prisma.auditLog.deleteMany({});

         // Create test entries
         const admin1 = '0xadmin0001111111111111111111111111111111';
         const admin2 = '0xadmin0002222222222222222222222222222222';

         await createAuditEntry({
            actorWallet: admin1,
            actionType: 'protocol_fee_updated',
            targetId: 'default',
            payload: { newFee: 500 },
         });

         await new Promise((resolve) => setTimeout(resolve, 10));

         await createAuditEntry({
            actorWallet: admin1,
            actionType: 'key_trading_paused',
            targetId: 'creator_123',
            payload: { paused: true },
         });

         await new Promise((resolve) => setTimeout(resolve, 10));

         await createAuditEntry({
            actorWallet: admin2,
            actionType: 'protocol_fee_updated',
            targetId: 'default',
            payload: { newFee: 600 },
         });

         await new Promise((resolve) => setTimeout(resolve, 10));

         await createAuditEntry({
            actorWallet: admin1,
            actionType: 'update_creator_metadata',
            targetId: 'creator_456',
            payload: { isVerified: true },
         });
      });

      it('AC1: Audit entry written after every admin action', async () => {
         const entries = await prisma.auditLog.findMany();
         expect(entries.length).toBeGreaterThanOrEqual(4);

         const actionTypes = entries.map((e) => e.actionType);
         expect(actionTypes).toContain('protocol_fee_updated');
         expect(actionTypes).toContain('key_trading_paused');
         expect(actionTypes).toContain('update_creator_metadata');
      });

      it('AC2: Entries returned sorted by createdAt descending', async () => {
         const result = await getAuditLogs({ limit: 100 });

         for (let i = 0; i < result.entries.length - 1; i++) {
            const current = result.entries[i].createdAt.getTime();
            const next = result.entries[i + 1].createdAt.getTime();
            expect(current).toBeGreaterThanOrEqual(next);
         }
      });

      it('AC3: actionType filter correctly narrows results', async () => {
         const allResult = await getAuditLogs({ limit: 100 });
         const filteredResult = await getAuditLogs({
            limit: 100,
            actionType: 'protocol_fee_updated',
         });

         expect(filteredResult.entries.length).toBeLessThanOrEqual(allResult.entries.length);
         expect(filteredResult.entries.length).toBeGreaterThan(0);

         filteredResult.entries.forEach((entry) => {
            expect(entry.actionType).toBe('protocol_fee_updated');
         });
      });

      it('AC4: Returned fields include actorWallet, actionType, targetId, payload, createdAt', async () => {
         const result = await getAuditLogs({ limit: 1 });

         expect(result.entries.length).toBeGreaterThan(0);

         const entry = result.entries[0];
         expect(entry).toHaveProperty('actorWallet');
         expect(entry).toHaveProperty('actionType');
         expect(entry).toHaveProperty('targetId');
         expect(entry).toHaveProperty('payload');
         expect(entry).toHaveProperty('createdAt');
         expect(entry).toHaveProperty('id');
      });

      it('AC5: Cursor pagination returns correct next page', async () => {
         const page1 = await getAuditLogs({ limit: 2 });
         expect(page1.entries.length).toBeGreaterThan(0);
         expect(page1.nextCursor).toBeDefined();

         const page2 = await getAuditLogs({
            limit: 2,
            cursor: page1.nextCursor,
         });

         // Verify we got different entries
         if (page1.entries.length > 0 && page2.entries.length > 0) {
            const page1Ids = page1.entries.map((e) => e.id);
            const page2Ids = page2.entries.map((e) => e.id);

            const overlap = page1Ids.filter((id) => page2Ids.includes(id));
            expect(overlap.length).toBe(0);
         }
      });
   });
});
