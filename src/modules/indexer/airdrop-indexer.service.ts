import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { eventOccurredAt } from '../../utils/indexer-event-fields.utils';
import { AirdropAddressSchema, AirdropAmountSchema } from '../airdrops/airdrop.schemas';

export const AIRDROP_CLAIMED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'airdrop_claimed', 'AirdropClaimed', 'AIRDROP_CLAIMED',
]);

const ClaimSchema = z.object({
   keyId: z.string().min(1).max(128),
   root: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(root => root.toLowerCase()),
   address: AirdropAddressSchema,
   amount: AirdropAmountSchema,
   ledger: z.number().int().nonnegative().max(2147483647),
   eventIndex: z.number().int().nonnegative().max(2147483647),
   txHash: z.string().min(1).max(128),
   claimedAt: z.date(),
});
type ParsedClaim = z.infer<typeof ClaimSchema>;

function parseInteger(value: unknown): number {
   if (typeof value === 'number') return value;
   if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
   return NaN;
}

/**
 * Normalized claim events identify an allocation by root + key + recipient.
 * The current contract only provides pure Merkle primitives, so no numerical
 * on-chain airdrop ID is guessed or confused with the API's CUID.
 */
export function parseAirdropClaimEvent(event: IndexerChainEvent):
   { ok: true; value: ParsedClaim } | { ok: false; reason: string } {
   const raw = event as Record<string, unknown>;
   const rawAmount = raw.amount;
   const amount = typeof rawAmount === 'bigint'
      ? rawAmount.toString()
      : typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount)
        ? String(rawAmount)
        : rawAmount;
   const rawRoot = raw.root ?? raw.merkleRoot ?? raw.merkle_root;
   const root = rawRoot instanceof Uint8Array
      ? Buffer.from(rawRoot).toString('hex')
      : typeof rawRoot === 'string' ? rawRoot.replace(/^0x/, '') : rawRoot;
   const rawDate = raw.claimedAt ?? raw.claimed_at ?? raw.timestamp ?? raw.ledgerClosedAt;
   let claimedAt: Date;
   try {
      claimedAt = rawDate instanceof Date
         ? rawDate
         : eventOccurredAt({ ...event, timestamp: rawDate });
   } catch (_error) {
      return { ok: false, reason: 'Invalid claim timestamp' };
   }
   const parsed = ClaimSchema.safeParse({
      keyId: raw.keyId ?? raw.key_id ?? raw.creatorId ?? raw.creator_id,
      root,
      address: raw.address ?? raw.recipient ?? raw.claimer ?? raw.wallet,
      amount,
      ledger: parseInteger(raw.ledger),
      eventIndex: parseInteger(event.eventIndex),
      txHash: event.txHash,
      claimedAt,
   });
   return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, reason: parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ') };
}

export async function processAirdropClaimEvent(event: IndexerChainEvent): Promise<boolean> {
   const parsed = parseAirdropClaimEvent(event);
   if (!parsed.ok) {
      logger.warn({ reason: parsed.reason, txHash: event.txHash }, 'Malformed airdrop claim moved to DLQ');
      await moveToDLQ({
         jobType: 'AIRDROP_CLAIMED',
         payload: JSON.parse(JSON.stringify(event, (_key, value) => typeof value === 'bigint' ? value.toString() : value)),
         retryCount: 0,
         failureReason: parsed.reason,
      });
      return false;
   }
   const value = parsed.value;
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: value.keyId }, { handle: value.keyId }] },
      select: { id: true },
   });
   const leaf = await prisma.airdropLeaf.findFirst({
      where: {
         address: value.address,
         airdrop: { keyId: creator?.id ?? value.keyId, root: value.root },
      },
      select: { id: true, amount: true },
   });
   // Retry an event delivered before its allocation tree is stored. Advancing
   // the cursor here would permanently lose the claim status.
   if (!leaf) throw new Error('Airdrop claim allocation is not yet indexed');
   if (!leaf.amount.eq(value.amount)) throw new Error('Airdrop claim amount does not match allocation');

   // Atomic conditional update preserves the original claim on replays and
   // concurrent delivery. Database failures propagate to the batch dispatcher.
   const updated = await prisma.airdropLeaf.updateMany({
      where: { id: leaf.id, claimedAt: null },
      data: {
         claimedAt: value.claimedAt,
         claimedLedger: value.ledger,
         claimedTxHash: value.txHash,
         claimedEventIndex: value.eventIndex,
      },
   });
   return updated.count > 0;
}

export async function processAirdropClaimEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (AIRDROP_CLAIMED_EVENT_TYPES.has(event.eventType)) await processAirdropClaimEvent(event);
   });
}
