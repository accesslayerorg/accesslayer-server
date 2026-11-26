import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
   buildErrorCatalogFile,
   ErrorCatalogFile,
   listUndocumentedErrors,
   ScannedContractError,
} from './error-catalog.builder';
import {
   decodeContractError,
   ERROR_CATALOG_PATH,
   ErrorCatalogNotFoundError,
   ErrorCatalogUnavailableError,
   findCatalogVersion,
   getErrorCatalogView,
   humanizeErrorName,
   loadErrorCatalog,
   parseContractErrorCode,
} from './error-catalog.service';

const scanned = (
   crate: string,
   enumName: string,
   name: string,
   code: number,
   message: string | null = null
): ScannedContractError => ({
   crate,
   enum: enumName,
   name,
   code,
   message,
   explicitAction: null,
});

function fixture(): ErrorCatalogFile {
   const first = buildErrorCatalogFile({
      scanned: [
         scanned('creator-keys', 'FeatureError', 'Unauthorized', 1, 'Caller is not the creator.'),
         scanned('creator-keys', 'FeatureError', 'NotRegistered', 3),
      ],
      existing: null,
      sourceCommit: 'sha-1',
   });
   return buildErrorCatalogFile({
      scanned: [
         scanned('creator-keys', 'FeatureError', 'Unauthorized', 1, 'Caller is not the creator.'),
         scanned('creator-keys', 'FeatureError', 'NotRegistered', 3),
         scanned('creator-keys', 'FeatureError', 'ProtocolPaused', 4, 'Protocol is paused.'),
      ],
      existing: first,
      sourceCommit: 'sha-2',
      wasmHashes: { 'creator-keys': 'a1b2' },
   });
}

describe('loadErrorCatalog', () => {
   it('throws when the catalog file is missing', () => {
      expect(() =>
         loadErrorCatalog(path.join(__dirname, 'does-not-exist.json'))
      ).toThrow(ErrorCatalogUnavailableError);
   });
});

describe('committed error-catalog.json', () => {
   it('is present and passes the schema and ratchet invariants', () => {
      expect(existsSync(ERROR_CATALOG_PATH)).toBe(true);
      const file = loadErrorCatalog();
      expect(file.schemaVersion).toBe(1);
      expect(Object.keys(file.contracts).length).toBeGreaterThan(0);

      for (const contract of Object.values(file.contracts)) {
         expect(contract.versions.length).toBeGreaterThan(0);
         for (const version of contract.versions) {
            for (const error of version.errors) {
               expect(error.suggestedAction.trim().length).toBeGreaterThan(0);
            }
         }
      }

      const baselinePath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'error-catalog-baseline.json');
      const baseline = new Set(
         (JSON.parse(readFileSync(baselinePath, 'utf8')) as { undocumented: string[] }).undocumented
      );
      for (const key of listUndocumentedErrors(file)) {
         expect(baseline.has(key)).toBe(true);
      }
   });
});

describe('findCatalogVersion', () => {
   it('returns the latest version by default', () => {
      const file = fixture();
      const latest = findCatalogVersion(file, 'creator-keys');
      expect(latest.wasmHash).toBe('a1b2');
      expect(latest.errors).toHaveLength(3);
   });

   it('resolves older versions by version id and by wasm hash', () => {
      const file = fixture();
      const [oldest] = file.contracts['creator-keys'].versions;
      expect(findCatalogVersion(file, 'creator-keys', oldest.version)).toBe(oldest);
      expect(findCatalogVersion(file, 'creator-keys', 'a1b2').wasmHash).toBe('a1b2');
   });

   it('throws not-found for unknown contracts, versions and prototype keys', () => {
      const file = fixture();
      expect(() => findCatalogVersion(file, 'missing')).toThrow(ErrorCatalogNotFoundError);
      expect(() => findCatalogVersion(file, 'creator-keys', 'nope')).toThrow(ErrorCatalogNotFoundError);
      expect(() => findCatalogVersion(file, 'constructor')).toThrow(ErrorCatalogNotFoundError);
   });
});

describe('getErrorCatalogView', () => {
   it('returns the version body with a quoted ETag that changes with content', () => {
      const file = fixture();
      const latest = getErrorCatalogView({ contract: 'creator-keys' }, file);
      expect(latest.body).toMatchObject({
         contract: 'creator-keys',
         wasmHash: 'a1b2',
         sourceCommit: 'sha-2',
         errorCount: 3,
      });
      expect(latest.etag).toMatch(/^"[0-9a-f]{32}"$/);

      const again = getErrorCatalogView({ contract: 'creator-keys' }, file);
      expect(again.etag).toBe(latest.etag);

      const older = getErrorCatalogView({ contract: 'creator-keys', version: file.contracts['creator-keys'].versions[0].version }, file);
      expect(older.etag).not.toBe(latest.etag);
      expect(older.body.errorCount).toBe(2);
   });
});

describe('parseContractErrorCode', () => {
   it('extracts codes from Soroban diagnostics and plain strings', () => {
      expect(parseContractErrorCode('HostError: Error(Contract, #7)')).toBe(7);
      expect(parseContractErrorCode('contract error 12 at invocation')).toBe(12);
      expect(parseContractErrorCode('failed with code: 5')).toBe(5);
      expect(parseContractErrorCode('network timeout')).toBeNull();
   });
});

describe('decodeContractError', () => {
   it('matches a known code and returns its entry', () => {
      const result = decodeContractError(fixture(), {
         contract: 'creator-keys',
         raw: 'HostError: Error(Contract, #1)',
      });
      expect(result).toEqual({
         matched: true,
         contract: 'creator-keys',
         version: 'a1b2',
         code: 1,
         error: {
            enum: 'FeatureError',
            name: 'Unauthorized',
            message: 'Caller is not the creator.',
            suggestedAction: expect.any(String),
            documented: true,
         },
         fallback: null,
      });
   });

   it('humanizes the name for undocumented errors', () => {
      const result = decodeContractError(fixture(), { contract: 'creator-keys', code: 3 });
      expect(result.matched).toBe(true);
      expect(result.error).toMatchObject({
         message: 'Not registered',
         documented: false,
      });
   });

   it('falls back when the code, contract or version is unknown', () => {
      const file = fixture();
      const unknownCode = decodeContractError(file, { contract: 'creator-keys', code: 99 });
      const unknownContract = decodeContractError(file, { contract: 'nope', code: 1 });
      const unknownVersion = decodeContractError(file, { contract: 'creator-keys', version: 'zzz', code: 1 });
      const noCode = decodeContractError(file, { contract: 'creator-keys', raw: 'network timeout' });

      for (const result of [unknownCode, unknownContract, unknownVersion, noCode]) {
         expect(result.matched).toBe(false);
         expect(result.error).toBeNull();
         expect(result.fallback?.message).toMatch(/does not describe/);
      }
   });
});

describe('humanizeErrorName', () => {
   it('splits camel case into a sentence', () => {
      expect(humanizeErrorName('InvalidCurveMilestones')).toBe('Invalid curve milestones');
   });
});
