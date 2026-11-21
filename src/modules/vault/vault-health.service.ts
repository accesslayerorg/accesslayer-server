// src/modules/vault/vault-health.service.ts
// Health math for lending-vault positions.
//
// Collateral is valued at the collateral key's 1h TWAP, debt grows with simple
// interest from `openedAt`, and the health factor is:
//
//     health = collateral value x liquidation threshold / debt
//
// The liquidation price is the collateral price at which health would equal 1.
// This module also backs GET /wallets/:address/vault/health.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { getTwapPrice } from '../keys/key-twap.service';

const STROOPS_PER_XLM = 10_000_000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
/** Health is capped here so debt-free positions stay representable as a Decimal. */
const MAX_HEALTH_FACTOR = 1_000_000;

/** Fraction of collateral value that counts toward debt coverage. */
export const LIQUIDATION_THRESHOLD = 0.8;
/** Health below which a borrower is warned. */
export const HEALTH_WARNING_THRESHOLD = 1.3;
/** Health below which a position is liquidatable. */
export const LIQUIDATION_HEALTH_THRESHOLD = 1;

export class VaultHealthUnavailableError extends Error {
   constructor(message = 'Vault health is unavailable') {
      super(message);
      this.name = 'VaultHealthUnavailableError';
   }
}

export interface LendingPositionInput {
   collateralQuantity: number;
   principalXlm: number;
   interestRateBps: number;
   openedAt: Date;
}

export interface VaultHealth {
   collateralValueXlm: number;
   debtXlm: number;
   healthFactor: number;
   liquidationPriceXlm: number | null;
}

export interface WalletVaultHealth extends VaultHealth {
   wallet: string;
   liquidationThreshold: number;
}

function toNumber(value: unknown): number {
   if (value === null || value === undefined) return 0;
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : 0;
}

function round7(value: number): number {
   return Number(value.toFixed(7));
}

/** Debt at `now`: principal plus simple interest accrued since `openedAt`. */
export function accruedDebt(
   position: LendingPositionInput,
   now: Date
): number {
   const elapsedMs = Math.max(0, now.getTime() - position.openedAt.getTime());
   const rate = position.interestRateBps / 10_000;
   return position.principalXlm * (1 + rate * (elapsedMs / MS_PER_YEAR));
}

/**
 * Health of a position at a given collateral price (XLM per key).
 *
 * @param position           Collateral and debt terms.
 * @param collateralPriceXlm TWAP price of the collateral key, in XLM.
 */
export function computeVaultHealth(
   position: LendingPositionInput,
   collateralPriceXlm: number,
   now: Date = new Date()
): VaultHealth {
   const collateralValueXlm = position.collateralQuantity * collateralPriceXlm;
   const debtXlm = accruedDebt(position, now);

   const rawHealth =
      debtXlm > 0
         ? (collateralValueXlm * LIQUIDATION_THRESHOLD) / debtXlm
         : Number.POSITIVE_INFINITY;

   const liquidationPriceXlm =
      position.collateralQuantity > 0
         ? debtXlm / (position.collateralQuantity * LIQUIDATION_THRESHOLD)
         : null;

   return {
      collateralValueXlm: round7(collateralValueXlm),
      debtXlm: round7(debtXlm),
      healthFactor: Number.isFinite(rawHealth)
         ? Number(rawHealth.toFixed(8))
         : MAX_HEALTH_FACTOR,
      liquidationPriceXlm:
         liquidationPriceXlm === null ? null : round7(liquidationPriceXlm),
   };
}

/** Collateral key price in XLM from its 1h TWAP, or null when unavailable. */
export async function loadCollateralPriceXlm(
   keyId: string,
   now: Date = new Date()
): Promise<number | null> {
   try {
      const { twap } = await getTwapPrice(keyId, '1h', now);
      const stroops = Number(twap);
      return Number.isFinite(stroops) ? stroops / STROOPS_PER_XLM : null;
   } catch (error) {
      logger.warn(
         { keyId, err: (error as Error).message },
         'vault-health: TWAP unavailable for collateral key'
      );
      return null;
   }
}

/** Health of a stored position using its collateral key's TWAP. */
export async function computePositionHealth(
   position: {
      collateralKeyId: string;
      collateralQuantity: unknown;
      principalXlm: unknown;
      interestRateBps: number;
      openedAt: Date;
   },
   now: Date = new Date()
): Promise<VaultHealth | null> {
   const collateralPriceXlm = await loadCollateralPriceXlm(
      position.collateralKeyId,
      now
   );
   if (collateralPriceXlm === null) return null;

   return computeVaultHealth(
      {
         collateralQuantity: toNumber(position.collateralQuantity),
         principalXlm: toNumber(position.principalXlm),
         interestRateBps: position.interestRateBps,
         openedAt: position.openedAt,
      },
      collateralPriceXlm,
      now
   );
}

/**
 * Live health for a wallet's most recent open position, or null when the
 * wallet has none. Throws {@link VaultHealthUnavailableError} when the
 * collateral price cannot be read.
 */
export async function getWalletVaultHealth(
   wallet: string,
   now: Date = new Date()
): Promise<WalletVaultHealth | null> {
   const position = await prisma.lendingPosition.findFirst({
      where: { wallet, liquidatedAt: null },
      orderBy: { openedAt: 'desc' },
   });
   if (!position) return null;

   const health = await computePositionHealth(position, now);
   if (!health) throw new VaultHealthUnavailableError();

   return { wallet, ...health, liquidationThreshold: LIQUIDATION_THRESHOLD };
}
