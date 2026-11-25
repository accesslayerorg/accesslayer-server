// src/modules/protocol/protocol-escape.service.ts
// Escape-hatch status and per-wallet recoverable estimates (#1265).
//
// Timing: escape opens PROTOCOL_ESCAPE_DELAY_LEDGERS after the pause event's
// ledger. It is active once the indexed ledger reaches that point.
// Estimate: keyBalance / circulatingSupply x reserveBalance, rounded down to
// 7 decimals. Positions with an EscapeRedemption row are reported as zero.

import { Decimal } from '@prisma/client/runtime/library';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';

export interface ProtocolEscapeStatus {
   pausedSince: string | null;
   escapeEnabledAtLedger: number | null;
   active: boolean;
   currentLedger: number | null;
}

export interface WalletEscapeHolding {
   keyId: string;
   balance: string;
   circulatingSupply: string;
   reserveBalance: string;
   redeemed: boolean;
   estimatedRecoverable: string;
}

export interface WalletEscapeResponse {
   wallet: string;
   escape: ProtocolEscapeStatus;
   holdings: WalletEscapeHolding[];
}

export interface LatestPauseState {
   kind: string;
   ledger: number;
   occurredAt: Date;
}

/**
 * Escape status from the latest pause event and the indexed ledger. Only a
 * `paused` event leaves escape open; an `unpaused` event clears it.
 */
export function computeEscapeStatus(input: {
   latestPause: LatestPauseState | null;
   currentLedger: number | null;
   delayLedgers: number;
}): ProtocolEscapeStatus {
   const { latestPause, currentLedger, delayLedgers } = input;
   if (!latestPause || latestPause.kind !== 'paused') {
      return {
         pausedSince: null,
         escapeEnabledAtLedger: null,
         active: false,
         currentLedger,
      };
   }

   const escapeEnabledAtLedger = latestPause.ledger + delayLedgers;
   return {
      pausedSince: latestPause.occurredAt.toISOString(),
      escapeEnabledAtLedger,
      active: currentLedger !== null && currentLedger >= escapeEnabledAtLedger,
      currentLedger,
   };
}

// decimal.js rounding mode ROUND_DOWN (toward zero).
const ROUND_DOWN = 1;

/** balance / circulatingSupply x reserve, rounded down to 7 decimals. */
export function estimateRecoverable(
   balance: Decimal,
   circulatingSupply: Decimal,
   reserve: Decimal
): Decimal {
   if (circulatingSupply.lte(0) || balance.lte(0)) {
      return new Decimal(0);
   }
   return balance
      .div(circulatingSupply)
      .mul(reserve)
      .toDecimalPlaces(7, ROUND_DOWN);
}

export async function getProtocolEscapeStatus(): Promise<ProtocolEscapeStatus> {
   const [latestPause, indexed] = await Promise.all([
      prisma.protocolPauseEvent.findFirst({
         orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }],
         select: { kind: true, ledger: true, occurredAt: true },
      }),
      prisma.indexedLedger.findUnique({
         where: { id: 1 },
         select: { ledger: true },
      }),
   ]);

   return computeEscapeStatus({
      latestPause,
      currentLedger: indexed?.ledger ?? null,
      delayLedgers: envConfig.PROTOCOL_ESCAPE_DELAY_LEDGERS,
   });
}

/**
 * The wallet's positions with per-key recoverable estimates. Holdings are
 * reported whether or not escape is active, and `escape.active` says which.
 */
export async function getWalletEscapeHoldings(
   wallet: string
): Promise<WalletEscapeResponse> {
   const escape = await getProtocolEscapeStatus();

   const ownerships = await prisma.keyOwnership.findMany({
      where: { ownerAddress: wallet, balance: { gt: 0 } },
      select: { creatorId: true, balance: true },
   });
   if (ownerships.length === 0) {
      return { wallet, escape, holdings: [] };
   }

   const keyIds = ownerships.map(ownership => ownership.creatorId);
   const [creators, reserves, redemptions] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: { id: { in: keyIds } },
         select: { id: true, circulatingSupply: true },
      }),
      prisma.keyReserve.findMany({
         where: { keyId: { in: keyIds } },
         select: { keyId: true, balance: true },
      }),
      prisma.escapeRedemption.findMany({
         where: { wallet, keyId: { in: keyIds } },
         select: { keyId: true },
      }),
   ]);

   const supplyByKey = new Map<string, Decimal>(
      creators.map((creator): [string, Decimal] => [
         creator.id,
         new Decimal(String(creator.circulatingSupply)),
      ])
   );
   const reserveByKey = new Map<string, Decimal>(
      reserves.map((reserve): [string, Decimal] => [
         reserve.keyId,
         new Decimal(String(reserve.balance)),
      ])
   );
   const redeemedKeys = new Set(redemptions.map(row => row.keyId));

   const holdings = ownerships.map(ownership => {
      const supply = supplyByKey.get(ownership.creatorId) ?? new Decimal(0);
      const reserve = reserveByKey.get(ownership.creatorId) ?? new Decimal(0);
      const balance = new Decimal(String(ownership.balance));
      const redeemed = redeemedKeys.has(ownership.creatorId);
      const estimate = redeemed
         ? new Decimal(0)
         : estimateRecoverable(balance, supply, reserve);

      return {
         keyId: ownership.creatorId,
         balance: balance.toFixed(7),
         circulatingSupply: supply.toFixed(7),
         reserveBalance: reserve.toFixed(7),
         redeemed,
         estimatedRecoverable: estimate.toFixed(7),
      };
   });

   return { wallet, escape, holdings };
}
