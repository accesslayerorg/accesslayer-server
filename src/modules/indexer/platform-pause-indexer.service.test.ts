// src/modules/indexer/platform-pause-indexer.service.test.ts

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn().mockResolvedValue(null),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheSetRaw: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { processPlatformPauseEvents } from './platform-pause-indexer.service';
import {
   getCachedKeyPauseState,
   getPlatformPauseState,
   isKeyPaused,
   resetPlatformPauseCache,
} from '../platform/platform-pause.service';

const baseEvent = {
   txHash: 'tx-1',
   eventIndex: 0,
   ledger: 100,
};

beforeEach(() => {
   resetPlatformPauseCache();
   jest.clearAllMocks();
});

describe('processPlatformPauseEvents', () => {
   it('caches platform pause state and metadata on PLATFORM_PAUSED', async () => {
      await processPlatformPauseEvents([
         {
            ...baseEvent,
            eventType: 'PLATFORM_PAUSED',
            actor: 'GADMIN',
            pausedAt: '2026-09-28T12:00:00.000Z',
         },
      ]);

      const state = await getPlatformPauseState();
      expect(state.paused).toBe(true);
      expect(state.actor).toBe('GADMIN');
      expect(state.pausedAt).toBe('2026-09-28T12:00:00.000Z');
   });

   it('clears platform pause state on PLATFORM_RESUMED', async () => {
      await processPlatformPauseEvents([
         { ...baseEvent, eventType: 'PLATFORM_PAUSED', actor: 'GADMIN' },
      ]);
      await processPlatformPauseEvents([
         { ...baseEvent, eventType: 'PLATFORM_RESUMED' },
      ]);

      const state = await getPlatformPauseState();
      expect(state.paused).toBe(false);
      expect(state.pausedAt).toBeNull();
      expect(state.actor).toBeNull();
   });

   it('caches per-key pause state independently', async () => {
      await processPlatformPauseEvents([
         {
            ...baseEvent,
            eventType: 'TRADING_PAUSED',
            creatorId: 'key-1',
            actor: 'GADMIN',
         },
      ]);

      const keyState = await getCachedKeyPauseState('key-1');
      expect(keyState?.paused).toBe(true);
      expect(await isKeyPaused('key-1')).toBe(true);
      expect(await isKeyPaused('key-2')).toBe(false);
   });

   it('clears per-key pause state on resume', async () => {
      await processPlatformPauseEvents([
         { ...baseEvent, eventType: 'KEY_PAUSED', keyId: 'key-1' },
      ]);
      await processPlatformPauseEvents([
         {
            ...baseEvent,
            eventType: 'KEY_TRADING_RESUMED',
            keyId: 'key-1',
         },
      ]);

      expect(await isKeyPaused('key-1')).toBe(false);
   });

   it('ignores unrelated events', async () => {
      await processPlatformPauseEvents([
         { ...baseEvent, eventType: 'KEY_BOUGHT', creatorId: 'key-1' },
      ]);

      expect((await getPlatformPauseState()).paused).toBe(false);
      expect(await isKeyPaused('key-1')).toBe(false);
   });
});
