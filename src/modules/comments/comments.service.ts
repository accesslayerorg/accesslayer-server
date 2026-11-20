// src/modules/comments/comments.service.ts
//
// Key comments with one level of threading and creator moderation (#1221).

import { prisma } from '../../utils/prisma.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';

export interface CommentReply {
   id: string;
   author: string;
   body: string;
   isHolder: boolean;
   hidden: boolean;
   createdAt: string;
}

export interface CommentItem {
   id: string;
   author: string;
   body: string;
   isHolder: boolean;
   hidden: boolean;
   createdAt: string;
   replies: CommentReply[];
}

export interface CommentPage {
   key_id: string;
   data: CommentItem[];
   meta: {
      hasMore: boolean;
      nextCursor: string | null;
   };
}

const MAX_BODY_LENGTH = 500;

export function validateBody(body: string): string | null {
   if (typeof body !== 'string' || body.trim().length === 0) {
      return 'Comment body is required';
   }
   if (body.length > MAX_BODY_LENGTH) {
      return `Comment body must be at most ${MAX_BODY_LENGTH} characters`;
   }
   return null;
}

async function isHolder(keyId: string, wallet: string): Promise<boolean> {
   const ownership = await prisma.keyOwnership.findFirst({
      where: { creatorId: keyId, ownerAddress: wallet },
      select: { balance: true },
   });
   return !!ownership && Number(ownership.balance) > 0;
}

async function holderMap(keyId: string, authors: string[]): Promise<Map<string, boolean>> {
   const unique = Array.from(new Set(authors));
   const map = new Map<string, boolean>();
   if (unique.length === 0) return map;
   const rows = await prisma.keyOwnership.findMany({
      where: { creatorId: keyId, ownerAddress: { in: unique } },
      select: { ownerAddress: true, balance: true },
   });
   const balanceByWallet = new Map(rows.map(r => [r.ownerAddress, Number(r.balance)]));
   for (const a of unique) {
      map.set(a, (balanceByWallet.get(a) ?? 0) > 0);
   }
   return map;
}

export async function listComments(
   keyId: string,
   limit: number,
   cursor?: string
): Promise<CommentPage> {
   const resolvedKeyId = (await resolveCreatorId(keyId)) ?? keyId;

   const topRows = await prisma.comment.findMany({
      where: { keyId: resolvedKeyId, parentId: null, hidden: false },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
   });

   const hasMore = topRows.length > limit;
   const page = hasMore ? topRows.slice(0, limit) : topRows;

   const topIds = page.map(c => c.id);
   const replies = topIds.length
      ? await prisma.comment.findMany({
           where: { keyId: resolvedKeyId, parentId: { in: topIds }, hidden: false },
           orderBy: { createdAt: 'asc' },
        })
      : [];

   const allAuthors = [...page.map(c => c.author), ...replies.map(r => r.author)];
   const holders = await holderMap(resolvedKeyId, allAuthors);

   const repliesByParent = new Map<string, typeof replies>();
   for (const r of replies) {
      if (!r.parentId) continue;
      const arr = repliesByParent.get(r.parentId) ?? [];
      arr.push(r);
      repliesByParent.set(r.parentId, arr);
   }

   const data: CommentItem[] = page.map(c => ({
      id: c.id,
      author: c.author,
      body: c.body,
      isHolder: holders.get(c.author) ?? false,
      hidden: c.hidden,
      createdAt: c.createdAt.toISOString(),
      replies: (repliesByParent.get(c.id) ?? []).map(r => ({
         id: r.id,
         author: r.author,
         body: r.body,
         isHolder: holders.get(r.author) ?? false,
         hidden: r.hidden,
         createdAt: r.createdAt.toISOString(),
      })),
   }));

   const lastRow = page[page.length - 1];
   return {
      key_id: resolvedKeyId,
      data,
      meta: {
         hasMore,
         nextCursor: hasMore && lastRow ? lastRow.id : null,
      },
   };
}

export async function createComment(
   keyId: string,
   author: string,
   body: string,
   parentId?: string | null
): Promise<CommentItem> {
   const resolvedKeyId = (await resolveCreatorId(keyId)) ?? keyId;

   // Validate parent: must be a top-level comment on the same key.
   if (parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent || parent.keyId !== resolvedKeyId) {
         throw new Error('INVALID_PARENT');
      }
      if (parent.parentId !== null) {
         throw new Error('REPLY_TO_REPLY');
      }
   }

   const comment = await prisma.comment.create({
      data: {
         keyId: resolvedKeyId,
         author,
         body,
         parentId: parentId ?? null,
      },
   });

   const holder = await isHolder(resolvedKeyId, author);
   return {
      id: comment.id,
      author: comment.author,
      body: comment.body,
      isHolder: holder,
      hidden: comment.hidden,
      createdAt: comment.createdAt.toISOString(),
      replies: [],
   };
}

export async function hideComment(id: string, hidden: boolean): Promise<CommentItem | null> {
   const existing = await prisma.comment.findUnique({ where: { id } });
   if (!existing) return null;
   const updated = await prisma.comment.update({
      where: { id },
      data: { hidden },
   });
   const holder = await isHolder(updated.keyId, updated.author);
   return {
      id: updated.id,
      author: updated.author,
      body: updated.body,
      isHolder: holder,
      hidden: updated.hidden,
      createdAt: updated.createdAt.toISOString(),
      replies: [],
   };
}

export async function getComment(id: string) {
   return prisma.comment.findUnique({ where: { id } });
}

export async function getKeyCreatorWallet(keyId: string): Promise<string | null> {
   const resolvedKeyId = (await resolveCreatorId(keyId)) ?? keyId;
   // CreatorProfile path
   const profile = await prisma.creatorProfile.findFirst({
      where: { id: resolvedKeyId },
      include: { user: { include: { stellarWallet: true } } },
   });
   if (profile?.user?.stellarWallet?.address) {
      return profile.user.stellarWallet.address;
   }
   // RegisteredKey path
   const regKey = await prisma.registeredKey.findFirst({
      where: { id: resolvedKeyId },
   });
   if (regKey?.creatorWallet) return regKey.creatorWallet;
   // Maybe keyId is a keyAddress
   const regByKey = await prisma.registeredKey.findFirst({
      where: { keyAddress: resolvedKeyId },
   });
   return regByKey?.creatorWallet ?? null;
}
