// src/modules/comments/comments.service.test.ts
import { prisma } from '../../utils/prisma.utils';
import {
   listComments,
   createComment,
   hideComment,
   validateBody,
} from './comments.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      comment: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      keyOwnership: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      creatorProfile: {
         findFirst: jest.fn(),
      },
      registeredKey: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn().mockResolvedValue(null),
}));

const mp = prisma as any;

const d = (iso: string) => new Date(iso);

const topComment = (overrides: any = {}) => ({
   id: 'c1',
   keyId: 'key-1',
   author: 'wallet-a',
   parentId: null,
   body: 'hello',
   hidden: false,
   createdAt: d('2026-11-20T10:00:00.000Z'),
   ...overrides,
});

describe('comments.service', () => {
   beforeEach(() => jest.clearAllMocks());

   describe('validateBody', () => {
      it('rejects empty/whitespace bodies', () => {
         expect(validateBody('')).toBe('Comment body is required');
         expect(validateBody('   ')).toBe('Comment body is required');
      });

      it('rejects bodies over 500 chars', () => {
         expect(validateBody('a'.repeat(501))).toContain('at most 500');
      });

      it('accepts valid bodies', () => {
         expect(validateBody('hi')).toBeNull();
      });
   });

   describe('listComments', () => {
      it('returns top-level comments with nested replies and cursor pagination meta', async () => {
         mp.comment.findMany
            .mockResolvedValueOnce([
               topComment({ id: 'c1', author: 'wallet-a' }),
               topComment({ id: 'c2', author: 'wallet-b' }),
               topComment({ id: 'c3', author: 'wallet-a' }),
            ])
            .mockResolvedValueOnce([
               {
                  id: 'r1',
                  keyId: 'key-1',
                  author: 'wallet-b',
                  parentId: 'c1',
                  body: 'reply',
                  hidden: false,
                  createdAt: d('2026-11-20T10:05:00.000Z'),
               },
            ]);
         mp.keyOwnership.findMany.mockResolvedValueOnce([
            { ownerAddress: 'wallet-a', balance: 5 },
         ]);

         const result = await listComments('key-1', 2);

         expect(mp.comment.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
               where: { keyId: 'key-1', parentId: null, hidden: false },
               take: 3,
            })
         );
         expect(result.data).toHaveLength(2);
         expect(result.data[0].id).toBe('c1');
         expect(result.data[0].replies).toHaveLength(1);
         expect(result.data[0].replies[0].id).toBe('r1');
         expect(result.data[0].isHolder).toBe(true);
         expect(result.data[1].isHolder).toBe(false);
         expect(result.meta.hasMore).toBe(true);
         expect(result.meta.nextCursor).toBe('c2');
      });

      it('returns hasMore=false and null cursor on last page', async () => {
         mp.comment.findMany
            .mockResolvedValueOnce([topComment({ id: 'c1' })])
            .mockResolvedValueOnce([]);
         mp.keyOwnership.findMany.mockResolvedValueOnce([]);

         const result = await listComments('key-1', 5);

         expect(result.meta.hasMore).toBe(false);
         expect(result.meta.nextCursor).toBeNull();
         expect(result.data).toHaveLength(1);
         expect(result.data[0].replies).toEqual([]);
      });

      it('passes cursor through to findMany (skip:1)', async () => {
         mp.comment.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
         mp.keyOwnership.findMany.mockResolvedValueOnce([]);

         await listComments('key-1', 5, 'cursor-id');

         expect(mp.comment.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
               cursor: { id: 'cursor-id' },
               skip: 1,
            })
         );
      });

      it('excludes hidden comments via where clause', async () => {
         mp.comment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
         mp.keyOwnership.findMany.mockResolvedValueOnce([]);

         await listComments('key-1', 5);

         expect(mp.comment.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
               where: expect.objectContaining({ hidden: false }),
            })
         );
      });
   });

   describe('createComment', () => {
      it('creates a top-level comment and returns isHolder flag', async () => {
         mp.comment.create.mockResolvedValueOnce({
            id: 'new-1',
            keyId: 'key-1',
            author: 'wallet-a',
            body: 'hi',
            parentId: null,
            hidden: false,
            createdAt: d('2026-11-20T11:00:00.000Z'),
         });
         mp.keyOwnership.findFirst.mockResolvedValueOnce({ balance: 3 });

         const result = await createComment('key-1', 'wallet-a', 'hi');

         expect(mp.comment.create).toHaveBeenCalledWith(
            expect.objectContaining({
               data: expect.objectContaining({
                  keyId: 'key-1',
                  author: 'wallet-a',
                  body: 'hi',
                  parentId: null,
               }),
            })
         );
         expect(result.id).toBe('new-1');
         expect(result.isHolder).toBe(true);
         expect(result.replies).toEqual([]);
      });

      it('creates a reply when parent is a top-level comment on same key', async () => {
         mp.comment.findUnique.mockResolvedValueOnce({
            id: 'parent-1',
            keyId: 'key-1',
            parentId: null,
         });
         mp.comment.create.mockResolvedValueOnce({
            id: 'reply-1',
            keyId: 'key-1',
            author: 'wallet-b',
            body: 'reply body',
            parentId: 'parent-1',
            hidden: false,
            createdAt: d('2026-11-20T11:00:00.000Z'),
         });
         mp.keyOwnership.findFirst.mockResolvedValueOnce(null);

         const result = await createComment('key-1', 'wallet-b', 'reply body', 'parent-1');

         expect(result.id).toBe('reply-1');
         expect(result.isHolder).toBe(false);
      });

      it('throws INVALID_PARENT for missing parent', async () => {
         mp.comment.findUnique.mockResolvedValueOnce(null);
         await expect(createComment('key-1', 'wallet-a', 'hi', 'nope')).rejects.toThrow('INVALID_PARENT');
      });

      it('throws INVALID_PARENT for parent on a different key', async () => {
         mp.comment.findUnique.mockResolvedValueOnce({
            id: 'parent-1',
            keyId: 'other-key',
            parentId: null,
         });
         await expect(createComment('key-1', 'wallet-a', 'hi', 'parent-1')).rejects.toThrow('INVALID_PARENT');
      });

      it('throws REPLY_TO_REPLY when parent is itself a reply', async () => {
         mp.comment.findUnique.mockResolvedValueOnce({
            id: 'reply-parent',
            keyId: 'key-1',
            parentId: 'top-1',
         });
         await expect(createComment('key-1', 'wallet-a', 'hi', 'reply-parent')).rejects.toThrow('REPLY_TO_REPLY');
      });
   });

   describe('hideComment', () => {
      it('returns null when comment does not exist', async () => {
         mp.comment.findUnique.mockResolvedValueOnce(null);
         const result = await hideComment('missing', true);
         expect(result).toBeNull();
      });

      it('updates hidden flag and returns updated comment', async () => {
         mp.comment.findUnique.mockResolvedValueOnce({
            id: 'c1',
            keyId: 'key-1',
            author: 'wallet-a',
            body: 'hi',
            hidden: false,
            createdAt: d('2026-11-20T10:00:00.000Z'),
         });
         mp.comment.update.mockResolvedValueOnce({
            id: 'c1',
            keyId: 'key-1',
            author: 'wallet-a',
            body: 'hi',
            hidden: true,
            createdAt: d('2026-11-20T10:00:00.000Z'),
         });
         mp.keyOwnership.findFirst.mockResolvedValueOnce(null);

         const result = await hideComment('c1', true);

         expect(mp.comment.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { hidden: true } })
         );
         expect(result?.hidden).toBe(true);
      });
   });
});
