import { prisma } from '../../utils/prisma.utils';
import { MerkleService } from './merkle.service';
import type { CreateAirdropInput } from './airdrop.schemas';

export class AirdropRequestError extends Error {
   constructor(message: string, readonly statusCode: 403 | 404) {
      super(message);
      this.name = 'AirdropRequestError';
   }
}

/** Persist a complete tree in one nested write; signed submission replays reuse it. */
export async function createAirdrop(input: CreateAirdropInput, wallet: string) {
   const [creator, owner] = await Promise.all([
      prisma.creatorProfile.findFirst({
         where: { OR: [{ id: input.keyId }, { handle: input.keyId }] },
         select: { id: true, userId: true },
      }),
      prisma.stellarWallet.findUnique({
         where: { address: wallet },
         select: { userId: true },
      }),
   ]);
   if (!creator) throw new AirdropRequestError('Key not found', 404);
   if (!owner || owner.userId !== creator.userId) {
      throw new AirdropRequestError('Only the key creator may create an airdrop', 403);
   }

   const tree = MerkleService.build(input.allocations);
   const record = await prisma.airdrop.upsert({
      where: { keyId_root: { keyId: creator.id, root: tree.root } },
      update: {},
      create: {
         keyId: creator.id,
         creator: wallet,
         root: tree.root,
         leaves: { create: tree.leaves },
      },
   });
   return {
      id: record.id,
      keyId: record.keyId,
      root: record.root,
      allocationCount: tree.leaves.length,
   };
}

export async function getAirdropProof(id: string, address: string) {
   const leaf = await prisma.airdropLeaf.findUnique({
      where: { airdropId_address: { airdropId: id, address } },
      include: { airdrop: { select: { root: true } } },
   });
   if (!leaf) return null;
   return {
      root: leaf.airdrop.root,
      amount: leaf.amount.toFixed(0),
      index: leaf.index,
      proof: leaf.proof,
      claimed: leaf.claimedAt !== null,
      claimedAt: leaf.claimedAt?.toISOString() ?? null,
   };
}

export async function listAirdropClaims(id: string, limit = 25, cursor?: number) {
   if (!await prisma.airdrop.findUnique({ where: { id }, select: { id: true } })) {
      return null;
   }
   const leaves = await prisma.airdropLeaf.findMany({
      where: { airdropId: id, ...(cursor === undefined ? {} : { index: { gt: cursor } }) },
      orderBy: { index: 'asc' },
      take: limit + 1,
   });
   const items = leaves.slice(0, limit).map(leaf => ({
      address: leaf.address,
      amount: leaf.amount.toFixed(0),
      index: leaf.index,
      claimed: leaf.claimedAt !== null,
      claimedAt: leaf.claimedAt?.toISOString() ?? null,
      txHash: leaf.claimedTxHash,
   }));
   return {
      items,
      nextCursor: leaves.length > limit ? String(items[items.length - 1].index) : null,
   };
}
