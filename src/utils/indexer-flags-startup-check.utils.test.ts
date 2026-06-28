jest.mock('../config', () => ({
   envConfig: {
      ENABLE_INDEXER_DEDUPE: true,
      ENABLE_INDEXER_DLQ: true,
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
      INDEXER_JITTER_FACTOR: 0.1,
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: 300_000,
   },
}));

import {
   IndexerFlagsConfig,
   IndexerFlagsConfigError,
   validateIndexerFeatureFlags,
} from './indexer-flags-startup-check.utils';

function makeConfig(overrides: Partial<IndexerFlagsConfig> = {}): IndexerFlagsConfig {
   return {
      ENABLE_INDEXER_DEDUPE: true,
      ENABLE_INDEXER_DLQ: true,
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
      INDEXER_JITTER_FACTOR: 0.1,
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: 300_000,
      ...overrides,
   };
}

describe('validateIndexerFeatureFlags()', () => {
   it('passes for the default configuration', () => {
      expect(() => validateIndexerFeatureFlags(makeConfig())).not.toThrow();
   });

   it('rejects a jitter factor below zero', () => {
      try {
         validateIndexerFeatureFlags(makeConfig({ INDEXER_JITTER_FACTOR: -0.5 }));
         fail('expected to throw');
      } catch (err) {
         expect(err).toBeInstanceOf(IndexerFlagsConfigError);
         expect((err as IndexerFlagsConfigError).issues[0]).toMatch(
            /INDEXER_JITTER_FACTOR/
         );
      }
   });

   it('rejects a jitter factor above one', () => {
      expect(() =>
         validateIndexerFeatureFlags(makeConfig({ INDEXER_JITTER_FACTOR: 1.5 }))
      ).toThrow(IndexerFlagsConfigError);
   });

   it('rejects a non-positive cursor stale-age threshold', () => {
      expect(() =>
         validateIndexerFeatureFlags(
            makeConfig({ INDEXER_CURSOR_STALE_AGE_WARNING_MS: 0 })
         )
      ).toThrow(IndexerFlagsConfigError);

      expect(() =>
         validateIndexerFeatureFlags(
            makeConfig({ INDEXER_CURSOR_STALE_AGE_WARNING_MS: -1 })
         )
      ).toThrow(IndexerFlagsConfigError);
   });

   it('rejects staleness warning enabled with too-small threshold', () => {
      try {
         validateIndexerFeatureFlags(
            makeConfig({
               ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
               INDEXER_CURSOR_STALE_AGE_WARNING_MS: 500,
            })
         );
         fail('expected to throw');
      } catch (err) {
         expect(err).toBeInstanceOf(IndexerFlagsConfigError);
         const issue = (err as IndexerFlagsConfigError).issues.find(i =>
            i.includes('ENABLE_INDEXER_CURSOR_STALENESS_WARNING')
         );
         expect(issue).toBeDefined();
      }
   });

   it('rejects DLQ enabled while dedupe is disabled', () => {
      try {
         validateIndexerFeatureFlags(
            makeConfig({
               ENABLE_INDEXER_DEDUPE: false,
               ENABLE_INDEXER_DLQ: true,
            })
         );
         fail('expected to throw');
      } catch (err) {
         expect(err).toBeInstanceOf(IndexerFlagsConfigError);
         expect((err as IndexerFlagsConfigError).issues[0]).toMatch(/DLQ/);
      }
   });

   it('passes when both DLQ and dedupe are disabled together', () => {
      expect(() =>
         validateIndexerFeatureFlags(
            makeConfig({
               ENABLE_INDEXER_DEDUPE: false,
               ENABLE_INDEXER_DLQ: false,
            })
         )
      ).not.toThrow();
   });

   it('aggregates multiple issues into a single error', () => {
      try {
         validateIndexerFeatureFlags(
            makeConfig({
               INDEXER_JITTER_FACTOR: 5,
               INDEXER_CURSOR_STALE_AGE_WARNING_MS: 0,
               ENABLE_INDEXER_DEDUPE: false,
               ENABLE_INDEXER_DLQ: true,
            })
         );
         fail('expected to throw');
      } catch (err) {
         expect(err).toBeInstanceOf(IndexerFlagsConfigError);
         expect((err as IndexerFlagsConfigError).issues.length).toBeGreaterThanOrEqual(3);
      }
   });

   it('error message lists every issue with bullet prefixes', () => {
      try {
         validateIndexerFeatureFlags(
            makeConfig({ INDEXER_JITTER_FACTOR: 9 })
         );
         fail('expected to throw');
      } catch (err) {
         expect((err as Error).message).toMatch(
            /Invalid indexer feature flag configuration/
         );
         expect((err as Error).message).toContain('  - ');
      }
   });
});
