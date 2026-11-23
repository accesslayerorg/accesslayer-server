import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';

const PolDecimal = Prisma.Decimal.clone({ precision: 100 });

export interface PolSummary { balance: string; deployedAmount: string; repaidAmount: string }
export async function getPolSummary(): Promise<PolSummary> {
   const cached = await cacheGetJson<PolSummary>('protocol:pol');
   if (cached !== null) return cached;
   const reserve = await prisma.polReserve.findUnique({ where: { id: 'default' } });
   const summary = { balance: reserve?.balance.toFixed(0) ?? '0',
      deployedAmount: reserve?.deployedAmount.toFixed(0) ?? '0',
      repaidAmount: reserve?.repaidAmount.toFixed(0) ?? '0' };
   await cacheSetJson('protocol:pol', summary, 30);
   return summary;
}

export async function getKeyBackstops(key: string, limit: number, offset: number) {
   const keyId = (await resolveCreatorId(key)) ?? key;
   const where = { keyId, type: { in: ['applied', 'repaid'] } };
   const [rows, totals] = await Promise.all([
      prisma.backstop.findMany({ where, orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }, { id: 'desc' }],
         take: limit, skip: offset }),
      prisma.backstop.groupBy({ by: ['type'], where, _sum: { amount: true } }),
   ]);
   const total = (type: string) => new PolDecimal(
      totals.find(row => row.type === type)?._sum.amount ?? 0);
   const appliedAmount = total('applied');
   const repaidAmount = total('repaid');
   const outstanding = appliedAmount.minus(repaidAmount);
   const repaymentStatus = appliedAmount.isZero() ? 'none' :
      outstanding.lte(0) ? 'repaid' : repaidAmount.gt(0) ? 'partial' : 'outstanding';
   return { keyId, appliedAmount: appliedAmount.toFixed(0), repaidAmount: repaidAmount.toFixed(0),
      outstandingAmount: outstanding.toFixed(0), repaymentStatus, limit, offset,
      items: rows.map(row => ({ id: row.id, type: row.type, amount: row.amount.toFixed(0),
         ledger: row.ledger, eventIndex: row.eventIndex, txHash: row.txHash,
         timestamp: row.timestamp.toISOString() })) };
}
