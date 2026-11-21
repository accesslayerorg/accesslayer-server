// src/modules/indexer/circuit-breaker-indexer.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      circuitBreakerTrip: { create: jest.fn() },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { processCircuitBreakerEvents } from './circuit-breaker-indexer.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   circuitBreakerTrip: { create: jest.Mock };
};

const baseEvent = {
   eventType: 'CIRCUIT_BREAKER_TRIPPED',
   keyId: 'key-1',
   creatorWallet: 'GCREATORWALLET',
   actualBps: 3500,
   maxBps: 3000,
   ledger: 1234,
   txHash: 'tx-1',
   eventIndex: 0,
   occurredAt: '2026-09-28T12:00:00.000Z',
};

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.creatorProfile.findFirst.mockResolvedValue({
      id: 'key-1',
      user: { stellarWallet: { address: 'GRESOLVEDWALLET' } },
   });
   mockPrisma.circuitBreakerTrip.create.mockResolvedValue({ id: 'trip-1' });
});

describe('processCircuitBreakerEvents', () => {
   it('indexes a trip with the correct actual bps and timestamp', async () => {
      await processCircuitBreakerEvents([baseEvent]);

      expect(mockPrisma.circuitBreakerTrip.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            creatorWallet: 'GCREATORWALLET',
            actualBps: 3500,
            maxBps: 3000,
            ledger: 1234,
            txHash: 'tx-1',
            eventIndex: 0,
            occurredAt: new Date('2026-09-28T12:00:00.000Z'),
         }),
      });
   });

   it('resolves the creator wallet from the profile when the event omits it', async () => {
      await processCircuitBreakerEvents([
         { ...baseEvent, creatorWallet: null },
      ]);

      expect(mockPrisma.circuitBreakerTrip.create).toHaveBeenCalledWith({
         data: expect.objectContaining({ creatorWallet: 'GRESOLVEDWALLET' }),
      });
   });

   it('does not double-index duplicate events in the same batch', async () => {
      await processCircuitBreakerEvents([baseEvent, { ...baseEvent }]);

      expect(mockPrisma.circuitBreakerTrip.create).toHaveBeenCalledTimes(1);
   });

   it('skips a replay that violates the unique constraint', async () => {
      mockPrisma.circuitBreakerTrip.create.mockRejectedValue({
         code: 'P2002',
      });

      await expect(
         processCircuitBreakerEvents([baseEvent])
      ).resolves.not.toThrow();
   });

   it('skips events missing required fields', async () => {
      await processCircuitBreakerEvents([
         { ...baseEvent, actualBps: undefined } as never,
      ]);

      expect(mockPrisma.circuitBreakerTrip.create).not.toHaveBeenCalled();
   });

   it('skips events for unknown keys', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

      await processCircuitBreakerEvents([baseEvent]);

      expect(mockPrisma.circuitBreakerTrip.create).not.toHaveBeenCalled();
   });

   it('ignores unrelated event types', async () => {
      await processCircuitBreakerEvents([
         { ...baseEvent, eventType: 'KEY_BOUGHT' },
      ]);

      expect(mockPrisma.circuitBreakerTrip.create).not.toHaveBeenCalled();
   });
});
