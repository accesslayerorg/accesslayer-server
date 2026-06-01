import { describeDatabasePoolConfig } from './db-pool-config.utils';

describe('describeDatabasePoolConfig', () => {
   it('parses pool params from the database URL', () => {
      const url =
         'postgresql://user:secret@db.example.com:5432/app?connection_limit=15&pool_timeout=20&connect_timeout=8';

      const config = describeDatabasePoolConfig(url, 5000);

      expect(config).toEqual({
         poolSize: 15,
         poolTimeoutSeconds: 20,
         connectTimeoutSeconds: 8,
         queryTimeoutMs: 5000,
      });
   });

   it('reports defaults when pool params are absent', () => {
      const config = describeDatabasePoolConfig(
         'postgresql://user:secret@db.example.com:5432/app',
         3000
      );

      expect(config).toEqual({
         poolSize: 'default',
         poolTimeoutSeconds: 'default',
         connectTimeoutSeconds: 'default',
         queryTimeoutMs: 3000,
      });
   });

   it('never leaks credentials or host details', () => {
      const url =
         'postgresql://admin:topsecret@db.internal:5432/app?connection_limit=5';

      const serialized = JSON.stringify(describeDatabasePoolConfig(url, 5000));

      expect(serialized).not.toContain('topsecret');
      expect(serialized).not.toContain('admin');
      expect(serialized).not.toContain('db.internal');
   });

   it('degrades to defaults on an unparseable URL', () => {
      const config = describeDatabasePoolConfig('not a url', 5000);
      expect(config.poolSize).toBe('default');
      expect(config.queryTimeoutMs).toBe(5000);
   });
});
