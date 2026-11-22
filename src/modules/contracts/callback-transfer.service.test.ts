// src/modules/contracts/callback-transfer.service.test.ts (#1274)
import {
  isContractAddress,
  recordCallbackTransfers,
  encodeTransferCursor,
  decodeTransferCursor,
} from './callback-transfer.service';
import { prisma } from '../../utils/prisma.utils';

describe('callback-transfer service (#1274)', () => {
  it('isContractAddress labels S/C-prefixed Stellar addresses as contracts', () => {
    expect(isContractAddress('S' + 'A'.repeat(55))).toBe(true);
    expect(isContractAddress('C' + 'B'.repeat(55))).toBe(true);
    expect(isContractAddress('G' + 'A'.repeat(55))).toBe(false);
    expect(isContractAddress('M' + 'A'.repeat(55))).toBe(false);
    expect(isContractAddress('')).toBe(false);
  });

  it('encodeTransferCursor/decodeTransferCursor round-trips', () => {
    const raw = encodeTransferCursor({
      c: '2026-11-21T00:00:00.000Z',
      h: 'ABC123',
    });
    expect(decodeTransferCursor(raw)).toEqual({
      c: '2026-11-21T00:00:00.000Z',
      h: 'ABC123',
    });
  });

  it('recordCallbackTransfers returns { count: 0 } for an empty batch', async () => {
    await expect(recordCallbackTransfers([])).resolves.toEqual({ count: 0 });
  });
});

describe('callback-transfer service — prisma wiring (#1274)', () => {
  it('recordCallbackTransfers forwards skipDuplicates to createMany', async () => {
    const spy = jest
      .spyOn(prisma.callbackTransfer, 'createMany')
      .mockResolvedValue({ count: 2 } as never);
    try {
      await recordCallbackTransfers([
        {
          from: 'G' + 'A'.repeat(55),
          toContract: 'S' + 'A'.repeat(55),
          keyId: 'K' + 'A'.repeat(20),
          amount: '1',
          dataHash: 'abc',
          ledger: 1,
          txHash: 'tx',
          eventIndex: 0,
        },
      ]);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      );
    } finally {
      spy.mockRestore();
    }
  });
});

