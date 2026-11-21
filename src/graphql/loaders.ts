// src/graphql/loaders.ts
// DataLoaders for the read-only GraphQL endpoint (issue #1248).
//
// DataLoaders batch lookups that happen at the same request level into a
// single database query. E.g. resolving `holders` for several keys in one
// `keys { edges { node { holders { ... } } } }` query issues a single
// `trade.findMany({ creatorId: { in: [...] } })` instead of one query per key.

import DataLoader from 'dataloader';
import { Request } from 'express';
import { prisma } from '../utils/prisma.utils';

export interface HolderSummary {
   id: string;
   walletAddress: string;
   totalKeysHeld: number;
   totalTrades: number;
   totalSpent: string;
}

export interface GraphQLLoaders {
   creatorLoader: DataLoader<string, any | null>;
   holderLoader: DataLoader<string, HolderSummary | null>;
   holdersByKeyLoader: DataLoader<string, HolderSummary[] | null>;
}

/**
 * GraphQL execution context: the originating HTTP request plus per-request
 * DataLoaders. One loader set per request so batch caches never leak across
 * requests.
 */
export interface GraphQLContext {
   req: Request;
   loaders: GraphQLLoaders;
}

function aggregateHolder(wallet: string, trades: any[]): HolderSummary {
   const keysHeld = new Set(trades.map(trade => trade.creatorId)).size;
   const totalSpent = trades.reduce(
      (sum, trade) =>
         sum + Number(trade.price ?? 0) * Number(trade.quantity ?? 0),
      0
   );

   return {
      walletAddress: wallet,
      id: wallet,
      totalKeysHeld: keysHeld,
      totalTrades: trades.length,
      totalSpent: String(totalSpent || 0),
   };
}

/**
 * Builds per-request DataLoaders. One instance per GraphQL request ensures
 * the batch cache does not leak across requests.
 */
export function createLoaders(): GraphQLLoaders {
   const creatorLoader = new DataLoader<string, any | null>(async ids => {
      const keyIds = ids as string[];
      const rows = await prisma.creatorProfile.findMany({
         where: { id: { in: keyIds } },
      });
      const byId = new Map(rows.map(row => [row.id, row]));
      return keyIds.map(id => byId.get(id) ?? null);
   });

   const holderLoader = new DataLoader<string, HolderSummary | null>(
      async wallets => {
         const walletList = wallets as string[];
         const rows = await prisma.trade.findMany({
            where: { buyer: { in: walletList } },
         });
         const byWallet = new Map<string, any[]>();
         for (const row of rows) {
            const list = byWallet.get(row.buyer) ?? [];
            list.push(row);
            byWallet.set(row.buyer, list);
         }
         return walletList.map(wallet => {
            const trades = byWallet.get(wallet) ?? [];
            return trades.length > 0 ? aggregateHolder(wallet, trades) : null;
         });
      }
   );

   const holdersByKeyLoader = new DataLoader<string, HolderSummary[] | null>(
      async keyIds => {
         const rows = await prisma.trade.findMany({
            where: { creatorId: { in: keyIds as string[] } },
         });
         const byKey = new Map<string, any[]>();
         for (const row of rows) {
            const list = byKey.get(row.creatorId) ?? [];
            list.push(row);
            byKey.set(row.creatorId, list);
         }
         return keyIds.map(keyId => {
            const trades = byKey.get(keyId) ?? [];
            if (trades.length === 0) return null;
            const byWallet = new Map<string, any[]>();
            for (const trade of trades) {
               const list = byWallet.get(trade.buyer) ?? [];
               list.push(trade);
               byWallet.set(trade.buyer, list);
            }
            return [...byWallet.entries()].map(([wallet, wsTrades]) =>
               aggregateHolder(wallet, wsTrades)
            );
         });
      }
   );

   return { creatorLoader, holderLoader, holdersByKeyLoader };
}
