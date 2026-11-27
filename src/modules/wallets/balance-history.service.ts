// src/modules/wallets/balance-history.service.ts
// Historical balance lookups and as-of portfolio queries backed by
// BalanceCheckpoint (#1323).

import { prisma } from '../../utils/prisma.utils';

const STELLAR_LEDGER_MS = 5000;

interface CheckpointRow {
   holder: string;
   keyId: string;
   ledger: number;
   balance: unknown;
   timestamp: Date;
}

interface BalanceCheckpointDb {
   balanceCheckpoint: {
      findFirst: (args: any) => Promise<CheckpointRow | null>;
      findMany: (args: any) => Promise<CheckpointRow[]>;
   };
   ledgerCheckpoint: {
      findFirst: (args: any) => Promise<{
         ledger: number;
         completedAt: Date;
      } | null>;
   };
   creatorProfile: {
      findMany: (args: any) => Promise<
         Array<{ id: string; handle: string; displayName: string }>
      >;
   };
}

export interface BalanceAtResult {
   holder: string;
   keyId: string;
   ledger: number;
   balance: number;
   checkpointLedger: number | null;
   timestamp: string | null;
}

export interface BalanceHistoryPoint {
   ledger: number;
   balance: number;
   timestamp: string | null;
}

export interface LedgerResolution {
   ledger: number;
   timestamp: Date;
   approximated: boolean;
}

export interface AsOfHolding {
   keyId: string;
   handle: string | null;
   displayName: string | null;
   balance: number;
   checkpointLedger: number;
}

export interface AsOfPortfolioResult {
   address: string;
   asOf: string;
   ledger: number;
   timestamp: string;
   approximated: boolean;
   holdings: AsOfHolding[];
}

export class BalanceHistoryService {
   private get db(): BalanceCheckpointDb {
      return prisma as unknown as BalanceCheckpointDb;
   }

   /**
    * Indexed `<=` lookup returning the latest checkpoint balance for
    * (holder, keyId) at or before `ledger`.
    * Uses the composite index on (holder, keyId, ledger).
    * Returns 0 when `ledger` is before the first checkpoint.
    */
   async at(
      holder: string,
      keyId: string,
      ledger: number
   ): Promise<BalanceAtResult> {
      const checkpoint = await this.db.balanceCheckpoint.findFirst({
         where: {
            holder,
            keyId,
            ledger: { lte: ledger },
         },
         orderBy: { ledger: 'desc' },
      });

      return {
         holder,
         keyId,
         ledger,
         balance: checkpoint ? Number(checkpoint.balance) : 0,
         checkpointLedger: checkpoint ? checkpoint.ledger : null,
         timestamp: checkpoint ? checkpoint.timestamp.toISOString() : null,
      };
   }

   /**
    * Returns step points for (holder, keyId) between `fromLedger` and `toLedger`.
    * Includes an initial carry-forward point at `fromLedger` when prior
    * checkpoints exist and no checkpoint falls directly on `fromLedger`.
    */
   async history(
      holder: string,
      keyId: string,
      fromLedger?: number,
      toLedger?: number
   ): Promise<BalanceHistoryPoint[]> {
      const ledgerFilter: Record<string, number> = {};
      if (fromLedger !== undefined) ledgerFilter.gte = fromLedger;
      if (toLedger !== undefined) ledgerFilter.lte = toLedger;

      const rows = await this.db.balanceCheckpoint.findMany({
         where: {
            holder,
            keyId,
            ...(Object.keys(ledgerFilter).length > 0
               ? { ledger: ledgerFilter }
               : {}),
         },
         orderBy: { ledger: 'asc' },
      });

      const points: BalanceHistoryPoint[] = rows.map((row) => ({
         ledger: row.ledger,
         balance: Number(row.balance),
         timestamp: row.timestamp.toISOString(),
      }));

      if (
         fromLedger !== undefined &&
         (points.length === 0 || points[0].ledger > fromLedger)
      ) {
         const prior = await this.at(holder, keyId, fromLedger);
         if (prior.checkpointLedger !== null || points.length > 0) {
            points.unshift({
               ledger: fromLedger,
               balance: prior.balance,
               timestamp: prior.timestamp,
            });
         }
      }

      return points;
   }

   /**
    * Converts an ISO date to the closest known or estimated Stellar ledger.
    * Marks `approximated: true` whenever interpolation/extrapolation is used.
    */
   async resolveLedgerAtDate(asOf: Date): Promise<LedgerResolution> {
      const targetMs = asOf.getTime();

      const beforeLedger = await this.db.ledgerCheckpoint.findFirst({
         where: { completedAt: { lte: asOf } },
         orderBy: { completedAt: 'desc' },
      });

      if (beforeLedger) {
         const diffMs = targetMs - beforeLedger.completedAt.getTime();
         if (diffMs <= STELLAR_LEDGER_MS) {
            return {
               ledger: beforeLedger.ledger,
               timestamp: beforeLedger.completedAt,
               approximated: false,
            };
         }
         const estimatedDelta = Math.floor(diffMs / STELLAR_LEDGER_MS);
         return {
            ledger: beforeLedger.ledger + estimatedDelta,
            timestamp: beforeLedger.completedAt,
            approximated: true,
         };
      }

      const afterLedger = await this.db.ledgerCheckpoint.findFirst({
         where: { completedAt: { gt: asOf } },
         orderBy: { completedAt: 'asc' },
      });

      if (afterLedger) {
         const diffMs = afterLedger.completedAt.getTime() - targetMs;
         const estimatedDelta = Math.ceil(diffMs / STELLAR_LEDGER_MS);
         return {
            ledger: Math.max(0, afterLedger.ledger - estimatedDelta),
            timestamp: afterLedger.completedAt,
            approximated: true,
         };
      }

      // Fallback to BalanceCheckpoint timestamps when LedgerCheckpoint is empty
      const priorCheckpoint = await this.db.balanceCheckpoint.findFirst({
         where: { timestamp: { lte: asOf } },
         orderBy: { timestamp: 'desc' },
      });
      if (priorCheckpoint) {
         const diffMs = targetMs - priorCheckpoint.timestamp.getTime();
         return {
            ledger:
               priorCheckpoint.ledger +
               Math.floor(diffMs / STELLAR_LEDGER_MS),
            timestamp: priorCheckpoint.timestamp,
            approximated: diffMs > STELLAR_LEDGER_MS,
         };
      }

      return {
         ledger: 0,
         timestamp: asOf,
         approximated: true,
      };
   }

   /**
    * Returns a wallet's non-zero key holdings as of `asOf`.
    * Dates before the first checkpoint return zero holdings (`holdings: []`).
    */
   async portfolioAsOf(
      holder: string,
      asOf: Date
   ): Promise<AsOfPortfolioResult> {
      const resolution = await this.resolveLedgerAtDate(asOf);

      const checkpoints = await this.db.balanceCheckpoint.findMany({
         where: {
            holder,
            ledger: { lte: resolution.ledger },
         },
         orderBy: [{ keyId: 'asc' }, { ledger: 'desc' }],
         distinct: ['keyId'],
      });

      const nonZero = checkpoints.filter((c) => Number(c.balance) > 0);
      const keyIds = nonZero.map((c) => c.keyId);

      const profiles =
         keyIds.length > 0
            ? await this.db.creatorProfile.findMany({
                 where: { id: { in: keyIds } },
                 select: { id: true, handle: true, displayName: true },
              })
            : [];
      const profileMap = new Map(profiles.map((p) => [p.id, p]));

      const holdings: AsOfHolding[] = nonZero.map((c) => {
         const profile = profileMap.get(c.keyId);
         return {
            keyId: c.keyId,
            handle: profile?.handle ?? null,
            displayName: profile?.displayName ?? null,
            balance: Number(c.balance),
            checkpointLedger: c.ledger,
         };
      });

      return {
         address: holder,
         asOf: asOf.toISOString(),
         ledger: resolution.ledger,
         timestamp: resolution.timestamp.toISOString(),
         approximated: resolution.approximated,
         holdings,
      };
   }
}

export const balanceHistoryService = new BalanceHistoryService();
