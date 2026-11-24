// src/modules/regions/geo.service.ts
// Country lookup over a local GeoLite2-Country database (#1354).
//
// The .mmdb file is opened lazily on first lookup and re-read automatically
// when the file changes (scripts/refresh-geoip-db.ts replaces it monthly).
// A missing or unreadable database never fails a request: lookups return a
// null country and the open is retried after OPEN_RETRY_MS.

import maxmind, { CountryResponse, Reader } from 'maxmind';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';

const OPEN_RETRY_MS = 5 * 60 * 1000;

export interface GeoLookup {
   country: string | null;
}

type Opener = (path: string, opts: Parameters<typeof maxmind.open>[1]) => Promise<Reader<CountryResponse>>;

export class GeoService {
   private reader: Reader<CountryResponse> | null = null;
   private opening: Promise<Reader<CountryResponse> | null> | null = null;
   private failedAt: number | null = null;

   constructor(
      private readonly dbPath: string | undefined = envConfig.GEOIP_DB_PATH,
      private readonly opener: Opener = (path, opts) => maxmind.open<CountryResponse>(path, opts),
      private readonly now: () => number = Date.now
   ) {}

   private async getReader(): Promise<Reader<CountryResponse> | null> {
      if (this.reader) return this.reader;
      if (!this.dbPath) return null;
      if (this.failedAt !== null && this.now() - this.failedAt < OPEN_RETRY_MS) return null;
      if (!this.opening) {
         this.opening = this.opener(this.dbPath, {
            watchForUpdates: true,
            watchForUpdatesNonPersistent: true,
            watchForUpdatesErrorHook: error =>
               logger.warn({ type: 'geoip_reload_failed', error: error.message }, 'GeoIP database reload failed'),
         })
            .then(reader => {
               this.reader = reader;
               this.failedAt = null;
               return reader;
            })
            .catch((error: unknown) => {
               this.failedAt = this.now();
               logger.warn(
                  { type: 'geoip_open_failed', error: error instanceof Error ? error.message : String(error) },
                  'GeoIP database unavailable; country detection disabled'
               );
               return null;
            })
            .finally(() => {
               this.opening = null;
            });
      }
      return this.opening;
   }

   /** ISO 3166-1 alpha-2 country for `ip`, or null when unknown. */
   async lookup(ip: string | null | undefined): Promise<GeoLookup> {
      if (!ip || !maxmind.validate(ip)) return { country: null };
      const reader = await this.getReader();
      if (!reader) return { country: null };
      try {
         const record = reader.get(ip);
         const code = record?.country?.iso_code ?? record?.registered_country?.iso_code;
         return { country: code ? code.toUpperCase() : null };
      } catch {
         return { country: null };
      }
   }
}

export const geoService = new GeoService();
