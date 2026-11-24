// src/modules/regions/geo.service.test.ts
//
// The last block runs against a real MaxMind database when GEOIP_TEST_DB
// points at one, e.g. MaxMind's published GeoIP2-Country-Test.mmdb from
// https://github.com/maxmind/MaxMind-DB/tree/main/test-data. No database
// file is committed to this repository.

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../utils/logger.utils';
import { GeoService } from './geo.service';

describe('GeoService', () => {
   beforeEach(() => jest.clearAllMocks());

   it('returns a null country without touching the disk when no path is configured', async () => {
      const opener = jest.fn();
      const geo = new GeoService(undefined, opener);
      await expect(geo.lookup('81.2.69.160')).resolves.toEqual({ country: null });
      expect(opener).not.toHaveBeenCalled();
   });

   it('returns a null country for missing or invalid addresses', async () => {
      const opener = jest.fn();
      const geo = new GeoService('/data/geo.mmdb', opener);
      await expect(geo.lookup(null)).resolves.toEqual({ country: null });
      await expect(geo.lookup('not-an-ip')).resolves.toEqual({ country: null });
      expect(opener).not.toHaveBeenCalled();
   });

   it('survives a missing database file and retries the open after five minutes', async () => {
      let now = 0;
      const opener = jest.fn().mockRejectedValue(new Error('ENOENT: no such file'));
      const geo = new GeoService('/missing/geo.mmdb', opener, () => now);

      await expect(geo.lookup('81.2.69.160')).resolves.toEqual({ country: null });
      await expect(geo.lookup('81.2.69.160')).resolves.toEqual({ country: null });
      expect(opener).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
         expect.objectContaining({ type: 'geoip_open_failed' }),
         expect.any(String)
      );

      now = 5 * 60 * 1000;
      await geo.lookup('81.2.69.160');
      expect(opener).toHaveBeenCalledTimes(2);
   });

   it('opens the database once, watches it for updates and upper-cases codes', async () => {
      const reader = { get: jest.fn(() => ({ country: { iso_code: 'gb' } })) };
      const opener = jest.fn().mockResolvedValue(reader);
      const geo = new GeoService('/data/geo.mmdb', opener);

      const [a, b] = await Promise.all([geo.lookup('81.2.69.160'), geo.lookup('81.2.69.160')]);
      expect(a).toEqual({ country: 'GB' });
      expect(b).toEqual({ country: 'GB' });
      expect(opener).toHaveBeenCalledTimes(1);
      expect(opener).toHaveBeenCalledWith(
         '/data/geo.mmdb',
         expect.objectContaining({ watchForUpdates: true, watchForUpdatesNonPersistent: true })
      );
   });

   it('falls back to the registered country and to null for unknown ranges', async () => {
      const reader = {
         get: jest
            .fn()
            .mockReturnValueOnce({ registered_country: { iso_code: 'DE' } })
            .mockReturnValueOnce(null),
      };
      const geo = new GeoService('/data/geo.mmdb', jest.fn().mockResolvedValue(reader));
      await expect(geo.lookup('89.160.20.112')).resolves.toEqual({ country: 'DE' });
      await expect(geo.lookup('10.0.0.1')).resolves.toEqual({ country: null });
   });
});

const describeRealDb = process.env.GEOIP_TEST_DB ? describe : describe.skip;

describeRealDb('GeoService against a real MaxMind database', () => {
   const geo = new GeoService(process.env.GEOIP_TEST_DB);

   it.each([
      ['81.2.69.160', 'GB'],
      ['::ffff:81.2.69.160', 'GB'],
      ['89.160.20.112', 'SE'],
      ['2001:218::', 'JP'],
      ['10.0.0.1', null],
   ])('resolves %s to %s', async (ip, country) => {
      await expect(geo.lookup(ip)).resolves.toEqual({ country });
   });
});
