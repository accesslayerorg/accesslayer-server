import { prisma } from '../../utils/prisma.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { parseAirdropClaimEvent, processAirdropClaimEvent, processAirdropClaimEvents } from './airdrop-indexer.service';
import { StrKey } from '@stellar/stellar-base';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      airdropLeaf: { findFirst: jest.fn(), updateMany: jest.fn() },
   },
}));
jest.mock('../../utils/indexer-dlq.utils', () => ({ moveToDLQ: jest.fn() }));
const { Prisma } = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');

const event = {
   eventType: 'airdrop_claimed',
   txHash: 'claim-tx',
   eventIndex: 0,
   ledger: 100,
   keyId: 'key',
   root: 'a'.repeat(64),
   address: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1)),
   amount: '10',
   claimedAt: '2026-11-21T00:00:00Z',
};

describe('airdrop claim indexing', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key' });
      (prisma.airdropLeaf.findFirst as jest.Mock).mockResolvedValue({
         id: 'leaf', amount: new Prisma.Decimal('10'),
      });
      (prisma.airdropLeaf.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
   });

   it('marks only the matching root/key/address allocation as claimed', async () => {
      expect(await processAirdropClaimEvent(event)).toBe(true);
      expect(prisma.airdropLeaf.findFirst).toHaveBeenCalledWith({
         where: { address: event.address, airdrop: { keyId: 'key', root: event.root } },
         select: { id: true, amount: true },
      });
      expect(prisma.airdropLeaf.updateMany).toHaveBeenCalledWith(expect.objectContaining({
         where: { id: 'leaf', claimedAt: null },
         data: expect.objectContaining({
            claimedAt: new Date(event.claimedAt), claimedTxHash: event.txHash,
            claimedLedger: 100, claimedEventIndex: 0,
         }),
      }));
   });

   it('makes a replay a no-op and deduplicates batch events', async () => {
      (prisma.airdropLeaf.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      expect(await processAirdropClaimEvent(event)).toBe(false);
      await processAirdropClaimEvents([event, event]);
      expect(prisma.airdropLeaf.updateMany).toHaveBeenCalledTimes(2);
   });

   it('quarantines malformed events instead of guessing an airdrop ID', async () => {
      expect(parseAirdropClaimEvent({ ...event, root: undefined }).ok).toBe(false);
      expect(await processAirdropClaimEvent({ ...event, root: undefined })).toBe(false);
      expect(moveToDLQ).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'AIRDROP_CLAIMED' }));
      expect(prisma.airdropLeaf.updateMany).not.toHaveBeenCalled();
   });

   it('does not advance past missing allocations or mismatched amounts', async () => {
      (prisma.airdropLeaf.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(processAirdropClaimEvent(event)).rejects.toThrow('allocation');
      (prisma.airdropLeaf.findFirst as jest.Mock).mockResolvedValue({
         id: 'leaf', amount: new Prisma.Decimal('11'),
      });
      await expect(processAirdropClaimEvent(event)).rejects.toThrow('amount');
      expect(prisma.airdropLeaf.updateMany).not.toHaveBeenCalled();
   });

   it.each([1795219200, '1795219200', 1795219200n])(
      'interprets numeric chain timestamp %s as Unix seconds', timestamp => {
         const parsed = parseAirdropClaimEvent({ ...event, claimedAt: undefined, timestamp });
         expect(parsed.ok).toBe(true);
         if (parsed.ok) expect(parsed.value.claimedAt.toISOString()).toBe('2026-11-21T00:00:00.000Z');
      }
   );

   it('preserves explicit Date/ISO timestamps and rejects invalid dates', () => {
      const date = new Date(event.claimedAt);
      const parsed = parseAirdropClaimEvent({ ...event, claimedAt: date });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.claimedAt.toISOString()).toBe(date.toISOString());
      expect(parseAirdropClaimEvent({ ...event, claimedAt: 'invalid' }).ok).toBe(false);
   });

   it('propagates database failures', async () => {
      (prisma.airdropLeaf.updateMany as jest.Mock).mockRejectedValue(new Error('database unavailable'));
      await expect(processAirdropClaimEvent(event)).rejects.toThrow('database unavailable');
   });
});
