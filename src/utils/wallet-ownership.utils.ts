// src/utils/wallet-ownership.utils.ts
// Reusable wallet-ownership access checks.
//
// Gated resources need a single, predictable answer to the question
// "does this caller's wallet own this resource?" so handlers and middleware
// stop reimplementing the check inline. Functions here return small typed
// results that the middleware turns into HTTP responses; handlers can call
// them directly when they need finer-grained control.

import { prisma } from './prisma.utils';

/**
 * Outcome of a wallet-ownership check. Distinguishes the three states the
 * middleware needs to surface as different HTTP responses:
 *
 * - `granted` — the caller's wallet owns the resource.
 * - `wallet_not_found` — the caller has no wallet on file. Treated as 401
 *   so clients know to map a wallet first.
 * - `forbidden` — caller has a wallet but it does not own the resource.
 */
export type WalletOwnershipResult =
   | { status: 'granted'; ownerUserId: string }
   | { status: 'wallet_not_found'; address: string }
   | { status: 'forbidden'; address: string; ownerUserId: string | null };

/**
 * Check whether the supplied Stellar address owns the given creator profile.
 *
 * Resolves both lookups in parallel — the wallet record (so we know the
 * caller is a known user) and the creator profile (so we know who the owner
 * is) — and returns a typed verdict.
 */
export async function checkCreatorProfileOwnership(
   address: string,
   creatorIdOrHandle: string
): Promise<WalletOwnershipResult> {
   const trimmedAddress = address.trim();
   if (!trimmedAddress) {
      return { status: 'wallet_not_found', address: trimmedAddress };
   }

   const [walletRecord, creatorProfile] = await Promise.all([
      prisma.stellarWallet.findUnique({
         where: { address: trimmedAddress },
         select: { userId: true },
      }),
      prisma.creatorProfile.findFirst({
         where: {
            OR: [{ id: creatorIdOrHandle }, { handle: creatorIdOrHandle }],
         },
         select: { userId: true },
      }),
   ]);

   if (!walletRecord) {
      return { status: 'wallet_not_found', address: trimmedAddress };
   }

   if (!creatorProfile || creatorProfile.userId !== walletRecord.userId) {
      return {
         status: 'forbidden',
         address: trimmedAddress,
         ownerUserId: creatorProfile?.userId ?? null,
      };
   }

   return { status: 'granted', ownerUserId: walletRecord.userId };
}
