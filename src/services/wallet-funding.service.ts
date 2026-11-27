// src/services/wallet-funding.service.ts
// Resolves which account first funded a Stellar wallet (#1241).
//
// A wallet's funding source is the `funder` of the `create_account` operation
// that created it: the first operation in the account's history. Resolved
// lookups are cached in `WalletFundingSource` because the answer never
// changes; unresolved lookups are not cached.

import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';
import { horizonGet } from '../clients/horizon.client';

export interface WalletFunding {
   funder: string;
   fundedAt: Date;
}

/** Horizon could not be reached or returned something unusable. */
export class FundingLookupError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'FundingLookupError';
   }
}

interface HorizonOperationRecord {
   type?: unknown;
   funder?: unknown;
   created_at?: unknown;
}

/**
 * Returns the wallet's funding source, or null when it cannot be determined
 * (account does not exist yet, or was not created by `create_account`).
 *
 * @throws {FundingLookupError} on Horizon errors, so callers can retry rather
 *   than treat an outage as "no funder".
 */
export async function getFundingSource(
   address: string
): Promise<WalletFunding | null> {
   const cached = await prisma.walletFundingSource.findUnique({
      where: { address },
      select: { funder: true, fundedAt: true },
   });
   if (cached) return cached;

   let response: Response;
   try {
      response = await horizonGet(
         `/accounts/${encodeURIComponent(address)}/operations?order=asc&limit=1`
      );
   } catch (error) {
      throw new FundingLookupError(
         `Horizon request failed: ${(error as Error)?.message ?? 'unknown error'}`
      );
   }

   if (response.status === 404) return null;
   if (!response.ok) {
      throw new FundingLookupError(`Horizon returned HTTP ${response.status}`);
   }

   let body: { _embedded?: { records?: HorizonOperationRecord[] } };
   try {
      body = await response.json();
   } catch {
      throw new FundingLookupError('Horizon returned a non-JSON response');
   }

   const first = body?._embedded?.records?.[0];
   if (
      !first ||
      first.type !== 'create_account' ||
      typeof first.funder !== 'string' ||
      typeof first.created_at !== 'string'
   ) {
      return null;
   }

   const fundedAt = new Date(first.created_at);
   if (Number.isNaN(fundedAt.getTime())) return null;

   const funding: WalletFunding = { funder: first.funder, fundedAt };
   await prisma.walletFundingSource.upsert({
      where: { address },
      create: { address, ...funding },
      update: {},
   });
   return funding;
}

/**
 * Best-effort cache warm-up (e.g. at referral registration). Never throws:
 * a failure here only means the lookup happens later, at evaluation time.
 */
export async function prefetchFundingSource(address: string): Promise<void> {
   try {
      await getFundingSource(address);
   } catch (error) {
      logger.warn(
         { type: 'funding_source_prefetch_failed', address, error },
         'Could not prefetch wallet funding source'
      );
   }
}
