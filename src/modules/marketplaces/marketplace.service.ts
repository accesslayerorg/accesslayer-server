import { resolveCreatorId } from '../whitelist/whitelist.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const MARKETPLACE_CACHE_KEY = 'registry:approved-marketplaces';

export class RoyaltyKeyNotFoundError extends Error {
   constructor() {
      super('Key not found');
      this.name = 'RoyaltyKeyNotFoundError';
   }
}

export async function getApprovedMarketplaces() {
   const cached = await cacheGetJson<{ address: string; approvedAt: string | null }[]>(MARKETPLACE_CACHE_KEY);
   if (cached !== null) return cached;
   const rows = await prisma.approvedMarketplace.findMany({
      where: { approved: true },
      orderBy: [{ approvedAt: 'desc' }, { address: 'asc' }],
      select: { address: true, approvedAt: true },
   });
   const result = rows.map(row => ({
      address: row.address,
      approvedAt: row.approvedAt?.toISOString() ?? null,
   }));
   await cacheSetJson(MARKETPLACE_CACHE_KEY, result, 300);
   return result;
}

export async function getRoyaltyEnforcement(keyId: string) {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, handle: true },
   });
   const resolvedKeyId = creator?.id ?? await resolveCreatorId(keyId);
   if (!resolvedKeyId) throw new RoyaltyKeyNotFoundError();
   const registered = await prisma.registeredKey.findFirst({
      where: { OR: [
         { id: resolvedKeyId }, { id: keyId }, { keyAddress: keyId },
         { handle: creator?.handle ?? keyId },
      ] },
      select: { id: true, handle: true, keyAddress: true },
   });
   const aliases = [...new Set([
      resolvedKeyId, keyId, creator?.handle,
      registered?.id, registered?.handle, registered?.keyAddress,
   ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
   // Unknown identifiers may be indexed before their creator/registration exists.
   // Compare their historical projection with the canonical row after registration.
   const state = await prisma.keyRoyaltyEnforcement.findFirst({
      where: { keyId: { in: aliases } },
      orderBy: [
         { ledger: 'desc' },
         { transactionIndex: { sort: 'desc', nulls: 'last' } },
         { eventIndex: 'desc' },
      ],
   });
   return {
      keyId: resolvedKeyId,
      royaltyEnforced: state?.royaltyEnforced ?? false,
      locked: state?.locked ?? false,
   };
}
