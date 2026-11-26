// src/graphql/resolvers.ts
// Resolvers for the read-only GraphQL endpoint (issue #1248).
//
// All reads go through Prisma; list queries use cursor-based pagination
// reusing `paginateQuery` from src/utils/pagination.utils. Nested lookups
// (Trade.key, Trade.holder, Key.holders) are served by DataLoaders so a
// single request level performs at most one database query per entity type.

import { GraphQLScalarType, Kind } from 'graphql';
import { prisma } from '../utils/prisma.utils';
import { encodeCursor, decodeCursor } from '../utils/cursor.utils';
import { paginateQuery } from '../utils/pagination.utils';
import { type GraphQLContext, type GraphQLLoaders } from './loaders';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export const DateTimeScalar = new GraphQLScalarType({
   name: 'DateTime',
   description: 'ISO-8601 datetime value',
   serialize(value: unknown) {
      if (value instanceof Date) return value.toISOString();
      return String(value);
   },
   parseValue(value: unknown) {
      return new Date(String(value));
   },
   parseLiteral(ast) {
      if (ast.kind === Kind.STRING) return new Date(ast.value);
      return null;
   },
});

function parseFirst(first?: number): number {
   return Math.min(
      Math.max(Math.floor(first ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE
   );
}

async function decodeAfter(after?: string): Promise<{ id: string } | null> {
   if (!after) return null;
   try {
      return decodeCursor(after);
   } catch {
      return null;
   }
}

type Edge<T> = { node: T; cursor: string };

type ConnectionResult<T> = {
   edges: Edge<T>[];
   pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
   };
   totalCount: number;
};

function buildConnection<T>(
   items: T[],
   total: number,
   hasAfter: boolean,
   hasMore: boolean,
   lastCursorValue: string | null
): ConnectionResult<T> {
   const edges: Edge<T>[] = items.map(item => ({
      node: item,
      cursor: encodeCursor({ id: (item as any).id }),
   }));

   return {
      edges,
      pageInfo: {
         hasNextPage: hasMore,
         hasPreviousPage: hasAfter,
         startCursor: edges.length > 0 ? edges[0].cursor : null,
         endCursor:
            lastCursorValue ??
            (edges.length > 0 ? edges[edges.length - 1].cursor : null),
      },
      totalCount: total,
   };
}

/**
 * Cursor-paginated list of Prisma rows mapped into GraphQL nodes.
 * Reuses the existing `paginateQuery` helper for take/skip/cursor handling.
 */
async function paginateConnection<T, Node = T>({
   query,
   count,
   first,
   after,
   mapNode,
}: {
   query: (args: {
      take: number;
      skip?: number;
      cursor?: { id: string };
   }) => Promise<T[]>;
   count: () => Promise<number>;
   first?: number;
   after?: string;
   mapNode: (row: T) => Node;
}): Promise<ConnectionResult<Node>> {
   const firstSafe = parseFirst(first);
   const cursor = await decodeAfter(after);
   const { data, nextCursor, hasMore } = await paginateQuery(
      query,
      { cursor, limit: firstSafe },
      item => (item as any).id
   );
   const total = await count();

   return buildConnection(
      data.map(mapNode),
      total,
      Boolean(after),
      hasMore,
      nextCursor ?? null
   );
}

function mapKey(row: any) {
   return {
      id: row.id,
      handle: row.handle,
      displayName: row.displayName,
      creatorWallet: row.creatorWallet,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
   };
}

function mapTrade(row: any) {
   return {
      id: row.id,
      keyId: row.creatorId,
      key: row,
      holder: row,
      buyer: row.buyer,
      quantity: row.quantity,
      price: row.price,
      paymentAsset: row.paymentAsset,
      ledger: row.ledger,
      txHash: row.txHash,
      timestamp: row.timestamp,
      createdAt: row.createdAt,
   };
}

function mapHolder(summary: HolderSummaryLike) {
   return {
      id: summary.id,
      walletAddress: summary.walletAddress,
      totalKeysHeld: summary.totalKeysHeld,
      totalTrades: summary.totalTrades,
      totalSpent: summary.totalSpent,
   };
}

type HolderSummaryLike = {
   id: string;
   walletAddress: string;
   totalKeysHeld: number;
   totalTrades: number;
   totalSpent: string;
};

export const resolvers = {
   DateTime: DateTimeScalar,
   Query: {
      key: async (_root: any, { id }: { id: string }) => {
         const row = await prisma.creatorProfile.findUnique({ where: { id } });
         return row ? mapKey(row) : null;
      },
      keys: async (
         _root: any,
         { first, after }: { first?: number; after?: string },
         _context: GraphQLContext
      ) => {
         return paginateConnection({
            query: args =>
               prisma.creatorProfile.findMany({
                  ...args,
                  orderBy: { createdAt: 'desc', id: 'desc' },
               }),
            count: () => prisma.creatorProfile.count(),
            first,
            after,
            mapNode: mapKey,
         });
      },
      trades: async (
         _root: any,
         {
            keyId,
            first,
            after,
         }: { keyId: string; first?: number; after?: string }
      ) => {
         return paginateConnection({
            query: args =>
               prisma.trade.findMany({
                  ...args,
                  where: { creatorId: keyId },
                  orderBy: { timestamp: 'desc', ledger: 'desc', id: 'desc' },
               }),
            count: () => prisma.trade.count({ where: { creatorId: keyId } }),
            first,
            after,
            mapNode: mapTrade,
         });
      },
   },
   Key: {
      trades: (parent: any, args: { first?: number; after?: string }) =>
         paginateConnection({
            query: args =>
               prisma.trade.findMany({
                  ...args,
                  where: { creatorId: parent.id },
                  orderBy: { timestamp: 'desc', ledger: 'desc', id: 'desc' },
               }),
            count: () =>
               prisma.trade.count({ where: { creatorId: parent.id } }),
            first: args.first,
            after: args.after,
            mapNode: mapTrade,
         }),
      holders: async (
         parent: any,
         args: { first?: number; after?: string },
         context: GraphQLContext
      ) => {
         const summaries =
            (await context.loaders.holdersByKeyLoader.load(parent.id)) ?? [];
         return holderListConnection(summaries, args);
      },
   },
   Holder: {
      trades: (parent: any, args: { first?: number; after?: string }) =>
         paginateConnection({
            query: args =>
               prisma.trade.findMany({
                  ...args,
                  where: { buyer: parent.walletAddress },
                  orderBy: { timestamp: 'desc', ledger: 'desc', id: 'desc' },
               }),
            count: () =>
               prisma.trade.count({ where: { buyer: parent.walletAddress } }),
            first: args.first,
            after: args.after,
            mapNode: mapTrade,
         }),
      keys: async (parent: any) => {
         // Keys held by this wallet: distinct creators from its trades, then the
         // key records themselves. Capped at 100 since holder key lists are not
         // the primary access path for this endpoint.
         const trades = await prisma.trade.findMany({
            where: { buyer: parent.walletAddress },
            select: { creatorId: true },
            take: 100,
            orderBy: { creatorId: 'asc' },
         });
         const keyIds = [...new Set(trades.map(trade => trade.creatorId))];
         const rows = await prisma.creatorProfile.findMany({
            where: { id: { in: keyIds } },
         });
         return buildConnection(
            rows.map(mapKey),
            rows.length,
            false,
            false,
            null
         );
      },
   },
   Trade: {
      key: (parent: any, _args: any, context: GraphQLContext) =>
         context.loaders.creatorLoader
            .load(parent.keyId)
            .then(row => (row ? mapKey(row) : null)),
      holder: (parent: any, _args: any, context: GraphQLContext) =>
         context.loaders.holderLoader
            .load(parent.buyer)
            .then(summary => (summary ? mapHolder(summary) : null)),
   },
};

function holderListConnection(
   summaries: HolderSummaryLike[],
   args: { first?: number; after?: string }
): ConnectionResult<HolderSummaryLike> {
   const firstSafe = parseFirst(args.first);
   const cursor = args.after ? decodeCursorSync(args.after) : null;
   const startIndex = cursor
      ? summaries.findIndex(s => s.walletAddress === cursor) + 1
      : 0;
   const sliceStart = Math.max(startIndex, 0);
   const page = summaries.slice(sliceStart, sliceStart + firstSafe + 1);
   const hasMore = page.length > firstSafe;
   const data = hasMore ? page.slice(0, firstSafe) : page;

   return buildConnection(
      data.map(mapHolder),
      summaries.length,
      Boolean(args.after),
      hasMore,
      data.length > 0 ? data[data.length - 1].walletAddress : null
   );
}

function decodeCursorSync(after: string): string | null {
   try {
      const decoded = decodeCursor(after);
      return typeof decoded === 'object' && decoded !== null
         ? ((decoded as { id?: string }).id ?? null)
         : null;
   } catch {
      return null;
   }
}

// Make `context` available on the exported resolvers type for consumers.
export type { GraphQLContext, GraphQLLoaders };
