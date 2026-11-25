import {
   buildErrorCatalogFile,
   deriveSuggestedAction,
   digestErrors,
   ErrorCatalogFile,
   listUndocumentedErrors,
   ScannedContractError,
} from './error-catalog.builder';

const scanned = (
   crate: string,
   enumName: string,
   name: string,
   code: number,
   message: string | null = null,
   explicitAction: string | null = null
): ScannedContractError => ({
   crate,
   enum: enumName,
   name,
   code,
   message,
   explicitAction,
});

const BASE: ScannedContractError[] = [
   scanned('creator-keys', 'FeatureError', 'Unauthorized', 1, 'Caller is not the creator.'),
   scanned('creator-keys', 'FeatureError', 'NotRegistered', 3),
   scanned('lp-reward', 'LpRewardError', 'PoolEmpty', 4, 'Pool is empty.', 'Wait for fees.'),
];

describe('deriveSuggestedAction', () => {
   it('maps well-known variant names to actions', () => {
      expect(deriveSuggestedAction('NotRegistered')).toMatch(/Confirm the referenced entity/);
      expect(deriveSuggestedAction('CooldownActive')).toMatch(/time window/);
      expect(deriveSuggestedAction('ArithmeticOverflow')).toMatch(/Reduce the amount/);
   });

   it('falls back to a generic action for unknown names', () => {
      expect(deriveSuggestedAction('Mystery')).toMatch(/^Review the error/);
   });
});

describe('buildErrorCatalogFile', () => {
   it('groups errors by crate and sorts them by enum, code and name', () => {
      const file = buildErrorCatalogFile({
         scanned: BASE,
         existing: null,
         sourceCommit: 'abc123',
      });
      expect(Object.keys(file.contracts)).toEqual(['creator-keys', 'lp-reward']);
      const errors = file.contracts['creator-keys'].versions[0].errors;
      expect(errors.map(e => `${e.enum}.${e.name}`)).toEqual([
         'FeatureError.Unauthorized',
         'FeatureError.NotRegistered',
      ]);
      expect(file.contracts['creator-keys'].versions[0]).toMatchObject({
         version: `src-${digestErrors(errors)}`,
         wasmHash: null,
         sourceCommit: 'abc123',
      });
   });

   it('records explicit actions and marks derived ones', () => {
      const file = buildErrorCatalogFile({ scanned: BASE, existing: null, sourceCommit: null });
      const pool = file.contracts['lp-reward'].versions[0].errors[0];
      expect(pool).toMatchObject({
         suggestedAction: 'Wait for fees.',
         actionSource: 'explicit',
      });
      const registered = file.contracts['creator-keys'].versions[0].errors[1];
      expect(registered.actionSource).toBe('derived');
   });

   it('does not append a version when the error set is unchanged', () => {
      const first = buildErrorCatalogFile({ scanned: BASE, existing: null, sourceCommit: 'one' });
      const second = buildErrorCatalogFile({ scanned: BASE, existing: first, sourceCommit: 'two' });
      expect(second).toEqual(first);
      expect(second.contracts['creator-keys'].versions).toHaveLength(1);
   });

   it('appends a new version when errors change and keeps the old one', () => {
      const first = buildErrorCatalogFile({ scanned: BASE, existing: null, sourceCommit: 'one' });
      const changed = [...BASE, scanned('creator-keys', 'FeatureError', 'Paused', 10, 'Paused.')];
      const next = buildErrorCatalogFile({ scanned: changed, existing: first, sourceCommit: 'two' });
      const versions = next.contracts['creator-keys'].versions;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toEqual(first.contracts['creator-keys'].versions[0]);
      expect(versions[1].sourceCommit).toBe('two');
    });

   it('uses the wasm hash as the version id when one is supplied', () => {
      const file = buildErrorCatalogFile({
         scanned: BASE,
         existing: null,
         sourceCommit: null,
         wasmHashes: { 'creator-keys': 'f00d' },
      });
      expect(file.contracts['creator-keys'].versions[0]).toMatchObject({
         version: 'f00d',
         wasmHash: 'f00d',
      });
   });

   it('keeps history for crates that no longer appear in the sources', () => {
      const first = buildErrorCatalogFile({ scanned: BASE, existing: null, sourceCommit: null });
      const withoutLp = buildErrorCatalogFile({
         scanned: BASE.filter(e => e.crate === 'creator-keys'),
         existing: first,
         sourceCommit: null,
      });
      expect(withoutLp.contracts['lp-reward']).toEqual(first.contracts['lp-reward']);
   });
});

describe('listUndocumentedErrors', () => {
   it('lists latest-version errors without a message, sorted', () => {
      const file: ErrorCatalogFile = buildErrorCatalogFile({
         scanned: BASE,
         existing: null,
         sourceCommit: null,
      });
      expect(listUndocumentedErrors(file)).toEqual([
         'creator-keys::FeatureError::NotRegistered',
      ]);
   });
});
