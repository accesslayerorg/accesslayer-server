// src/modules/keys/oracle-price.service.ts
//
// Business logic for GET /keys/:id/oracle-price.
//
// Responsibilities:
//   - Fetch the indexed oracle price row from the DB (written by the indexer
//     on every OraclePriceUpdated contract event).
//   - Compute the bonding-curve spot price from the current circulating supply.
//   - Derive the deviation percentage between the two prices.
//   - Set the isStale flag when the oracle price is older than
//     ORACLE_STALENESS_THRESHOLD_MS.
//
// Caching is handled by the route layer (cacheGetJson / cacheSetJson with
// ORACLE_CACHE_TTL_MS), keeping this file focused on pure data logic.

import { prisma } from '../../utils/prisma.utils';
import { getBuyUnitPrice } from '../../utils/pricing.utils';
import { envConfig } from '../../config';

// ── Custom errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when the creator key cannot be found in the database.
 */
export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

/**
 * Thrown when no oracle price row exists for a creator.
 * Distinct from KeyNotFoundError so the route can return a 404 with a
 * specific message about the oracle feed rather than the key itself.
 */
export class OraclePriceNotFoundError extends Error {
   constructor(keyId: string) {
      super(`No oracle price data found for key: ${keyId}`);
      this.name = 'OraclePriceNotFoundError';
   }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OraclePriceResult {
   /** Oracle price in stroops (as string to avoid JS precision loss). */
   oraclePrice: string;
   /** Bonding-curve spot price for the next buy unit, in stroops. */
   spotPrice: string;
   /**
    * Signed percentage difference from spotPrice to oraclePrice:
    *   ((oraclePrice - spotPrice) / spotPrice) * 100
    * Positive = oracle is above spot; negative = oracle is below spot.
    * null when spotPrice is 0 (empty supply with no defined price).
    */
   deviationPct: number | null;
   /** True when the oracle price age exceeds ORACLE_STALENESS_THRESHOLD_MS. */
   isStale: boolean;
   /** The ledger number at which the oracle price was last emitted. */
   ledger: number;
   /** Transaction hash of the OraclePriceUpdated event. */
   txHash: string;
   /** ISO-8601 timestamp of the on-chain event that set the oracle price. */
   eventAt: string;
   /** ISO-8601 timestamp of the last DB write (indexer upsert). */
   updatedAt: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Return the oracle price data for a creator key.
 *
 * @throws {KeyNotFoundError}         when the creator key doesn't exist.
 * @throws {OraclePriceNotFoundError} when no oracle price row exists yet.
 */
export async function getOraclePrice(
   keyId: string
): Promise<OraclePriceResult> {
   // Resolve by id OR handle to match the pattern used elsewhere in keys routes.
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: {
         id: true,
         circulatingSupply: true,
         creatorRoyaltyBuyBps: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const oracleRow = await prisma.oraclePrice.findUnique({
      where: { creatorId: creator.id },
   });

   if (!oracleRow) {
      throw new OraclePriceNotFoundError(keyId);
   }

   // ── Spot price ─────────────────────────────────────────────────────────────
   // getBuyUnitPrice expects an integer supply value. Prisma stores
   // circulatingSupply as Decimal; convert safely.
   const supply = Number(creator.circulatingSupply.toString());
   const feeBps = creator.creatorRoyaltyBuyBps;
   const spotPriceBigInt = getBuyUnitPrice(supply, feeBps);

   // ── Deviation ──────────────────────────────────────────────────────────────
   const oraclePriceBigInt = BigInt(oracleRow.price.toString());
   let deviationPct: number | null = null;
   if (spotPriceBigInt !== 0n) {
      // Use floating-point arithmetic; the percentage doesn't need bigint precision.
      const oracle = Number(oraclePriceBigInt);
      const spot = Number(spotPriceBigInt);
      deviationPct = parseFloat((((oracle - spot) / spot) * 100).toFixed(4));
   }

   // ── Staleness ──────────────────────────────────────────────────────────────
   const ageMs = Date.now() - oracleRow.eventAt.getTime();
   const isStale = ageMs > envConfig.ORACLE_STALENESS_THRESHOLD_MS;

   return {
      oraclePrice: oraclePriceBigInt.toString(),
      spotPrice: spotPriceBigInt.toString(),
      deviationPct,
      isStale,
      ledger: oracleRow.ledger,
      txHash: oracleRow.txHash,
      eventAt: oracleRow.eventAt.toISOString(),
      updatedAt: oracleRow.updatedAt.toISOString(),
   };
}
