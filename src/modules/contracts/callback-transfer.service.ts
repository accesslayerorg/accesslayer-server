// src/modules/contracts/callback-transfer.service.ts
// CallbackTransfer indexing + read model for #1274: transfers whose
// execution invoked a callback on a contract.
import { prisma } from '../../utils/prisma.utils';

export interface CallbackTransferRecord {
  from: string;
  toContract: string;
  keyId: string;
  amount: string;
  dataHash: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  createdAt?: string;
}

/**
 * Stellar contract addresses start with 'S' (contract); account/wallet
 * addresses start with 'G' (or 'M' when muxed). 'C' is accepted as a
 * contract prefix defensively.
 */
export function isContractAddress(address: string): boolean {
  const a = String(address || '').trim();
  return a.length > 0 && (a.startsWith('S') || a.startsWith('C'));
}

/**
 * Idempotently index callback transfers from the chain. Writes use
 * `skipDuplicates` so replays of the same (txHash, eventIndex) — a replayed
 * indexer batch — store each transfer exactly once.
 */
export async function recordCallbackTransfers(
  records: CallbackTransferRecord[]
): Promise<{ count: number }> {
  if (records.length === 0) return { count: 0 };
  const res = await prisma.callbackTransfer.createMany({
    data: records.map(r => ({
      from: r.from,
      toContract: r.toContract,
      keyId: r.keyId,
      amount: r.amount,
      dataHash: r.dataHash,
      ledger: r.ledger,
      txHash: r.txHash,
      eventIndex: r.eventIndex,
    })),
    skipDuplicates: true,
  });
  return { count: res.count };
}

interface TransferCursor {
  c: string; // createdAt ISO of the last item
  h: string; // txHash tie-breaker
}

export function encodeTransferCursor(cursor: TransferCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeTransferCursor(raw: string): TransferCursor {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

/**
 * Transfers received by a contract, reverse chronological
 * (createdAt desc, txHash desc), cursor-paginated via `nextCursor`.
 */
export async function listReceivedTransfers(
  address: string,
  limit = 100,
  cursor?: string
): Promise<{ items: CallbackTransferRecord[]; nextCursor: string | null }> {
  let after: Date | null = null;
  let afterHash: string | null = null;
  if (cursor) {
    const parsed = decodeTransferCursor(cursor);
    after = new Date(parsed.c);
    afterHash = parsed.h;
  }

  const where: Record<string, unknown> = { toContract: address };
  if (after) {
    where.OR = [
      { createdAt: { lt: after } },
      { createdAt: after, txHash: { lt: afterHash } },
    ];
  }

  const rows = await prisma.callbackTransfer.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { txHash: 'desc' }],
    take: limit + 1,
    select: {
      from: true,
      toContract: true,
      keyId: true,
      amount: true,
      dataHash: true,
      ledger: true,
      txHash: true,
      eventIndex: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(r => ({
    from: r.from,
    toContract: r.toContract,
    keyId: r.keyId,
    amount: r.amount,
    dataHash: r.dataHash,
    ledger: r.ledger,
    txHash: r.txHash,
    eventIndex: r.eventIndex,
    createdAt: r.createdAt.toISOString(),
  }));

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTransferCursor({ c: last.createdAt, h: last.txHash })
      : null;

  return { items, nextCursor };
}
