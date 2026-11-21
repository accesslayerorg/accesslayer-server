// src/modules/admin/key-snapshot.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export class KeySnapshotNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeySnapshotNotFoundError';
   }
}

/**
 * The set of on-chain fields exposed by the snapshot reconciliation
 * endpoint. Each field is read both from the Soroban contract and from the
 * database key record, and a `drift` boolean indicates whether they differ.
 */
export interface SnapshotField {
   field: string;
   onChain: string | number | boolean | null;
   database: string | number | boolean | null;
   drift: boolean;
}

export interface KeySnapshot {
   keyId: string;
   timestamp: string;
   fields: SnapshotField[];
   drifts: SnapshotField[];
   inSync: boolean;
}

interface OnChainFields {
   circulatingSupply: string | number;
   currentPrice: string | number;
   holderCount: number;
   tradingPaused: boolean;
   supplyCap: number | null;
   holderCapBps: number;
   circuitBreakerThresholdBps: number;
}

/**
 * Reads the specified on-chain fields for a key via the Soroban RPC.
 *
 * TODO: replace with real getLedgerEntries calls once the contract's
 * persistent storage keys can be built and XDR-decoded. The current
 * implementation returns a placeholder so the endpoint is functional for
 * reconciliation scaffolding.
 */
async function readOnChainSnapshot(creatorId: string): Promise<OnChainFields> {
   // TODO: submit Soroban RPC calls to read:
   // - circulating_supply
   // - current_price
   // - holder_count
   // - trading_paused
   // - supply_cap
   // - holder_cap_bps
   // - circuit_breaker_threshold_bps
   logger.debug(
      { creatorId },
      'Reading on-chain snapshot (placeholder implementation)'
   );

   const priceSnapshot = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId },
      select: { currentPrice: true },
   });
   const holderCount = await prisma.keyOwnership.count({
      where: { creatorId, balance: { gt: 0 } },
   });

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: {
         circulatingSupply: true,
         tradingPaused: true,
         supplyCap: true,
         holderCapBps: true,
         circuitBreakerThreshold: true,
      },
   });

   // Fall back to the database values so on-chain placeholder matches DB
   // (no false positives on drift) until real RPC reads are wired up.
   return {
      circulatingSupply: creator ? creator.circulatingSupply.toString() : '0',
      currentPrice: priceSnapshot ? priceSnapshot.currentPrice.toString() : '0',
      holderCount,
      tradingPaused: creator ? creator.tradingPaused : false,
      supplyCap: creator ? creator.supplyCap : null,
      holderCapBps: creator ? creator.holderCapBps : 2500,
      circuitBreakerThresholdBps: creator?.circuitBreakerThreshold ?? 3000,
   };
}

function normalizeNumber(value: string | number | null): string {
   if (value === null || value === undefined) return '';
   return String(value);
}

/**
 * Builds a full on-chain state snapshot for a key alongside the
 * corresponding database values, with a `drift` boolean per field.
 *
 * Returns null when the key does not exist, allowing the caller to map to
 * 404.
 */
export async function getKeySnapshot(
   keyId: string
): Promise<KeySnapshot | null> {
   const key = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
   });
   if (!key) {
      throw new KeySnapshotNotFoundError(keyId);
   }

   const onChain = await readOnChainSnapshot(key.id);

   // Database-side holder count is derived from the ownership table.
   const dbHolderCount = await prisma.keyOwnership.count({
      where: { creatorId: key.id, balance: { gt: 0 } },
   });

   const priceSnapshot = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId: key.id },
      select: { currentPrice: true },
   });

   const dbPrice = priceSnapshot ? priceSnapshot.currentPrice.toString() : '0';

   const definitions: Array<{
      field: string;
      onChain: string | number | boolean | null;
      database: string | number | boolean | null;
   }> = [
      {
         field: 'circulatingSupply',
         onChain: onChain.circulatingSupply,
         database: key.circulatingSupply.toString(),
      },
      {
         field: 'currentPrice',
         onChain: onChain.currentPrice,
         database: dbPrice,
      },
      {
         field: 'holderCount',
         onChain: onChain.holderCount,
         database: dbHolderCount,
      },
      {
         field: 'tradingPaused',
         onChain: onChain.tradingPaused,
         database: key.tradingPaused,
      },
      {
         field: 'supplyCap',
         onChain: onChain.supplyCap,
         database: key.supplyCap,
      },
      {
         field: 'holderCapBps',
         onChain: onChain.holderCapBps,
         database: key.holderCapBps,
      },
      {
         field: 'circuitBreakerThresholdBps',
         onChain: onChain.circuitBreakerThresholdBps,
         database: key.circuitBreakerThreshold,
      },
   ];

   const fields: SnapshotField[] = definitions.map(d => {
      const drift =
         normalizeNumber(d.onChain as string | number) !==
         normalizeNumber(d.database as string | number);
      return { ...d, drift };
   });

   const drifts = fields.filter(f => f.drift);

   return {
      keyId: key.id,
      timestamp: new Date().toISOString(),
      fields,
      drifts,
      inSync: drifts.length === 0,
   };
}
