// src/modules/investor/dividend.service.ts
import { prisma } from '../../utils/prisma.utils';

export class DividendNotFoundError extends Error {}

export async function getInvestorDividends(
  wallet: string,
  cursor?: string,
  limit = 20
) {
  const where: any = { investorAddress: wallet };
  if (cursor) {
    where.id = { gt: cursor };
  }
  const items = await prisma.dividendDistribution.findMany({
    where,

    orderBy: { createdAt: 'desc' } as const,

    take: limit + 1,
  });
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? data[data.length - 1].id : null;
  return { data, nextCursor, hasMore };
}
