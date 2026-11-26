// scripts/refresh-geoip-db.ts
// Downloads the MaxMind GeoLite2-Country database into GEOIP_DB_PATH (#1354).
// Run monthly; see docs/region-restrictions.md.
//
// Usage:
//   MAXMIND_ACCOUNT_ID=... MAXMIND_LICENSE_KEY=... GEOIP_DB_PATH=./data/GeoLite2-Country.mmdb \
//     pnpm exec ts-node --transpile-only scripts/refresh-geoip-db.ts
//   pnpm exec ts-node --transpile-only scripts/refresh-geoip-db.ts --archive ./GeoLite2-Country.tar.gz
//
// The archive's SHA-256 is checked against MaxMind's published checksum, the
// extracted file is opened with the same reader the server uses, and only then
// is it renamed over the live file. A running server picks the new file up
// through its file watcher; a failed refresh leaves the old database in place.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Reader } from 'maxmind';

const DOWNLOAD_URL =
   'https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=';

function requireEnv(name: string): string {
   const value = process.env[name];
   if (!value) throw new Error(`${name} is required`);
   return value;
}

async function download(suffix: string): Promise<Buffer> {
   const auth = Buffer.from(
      `${requireEnv('MAXMIND_ACCOUNT_ID')}:${requireEnv('MAXMIND_LICENSE_KEY')}`
   ).toString('base64');
   const res = await fetch(DOWNLOAD_URL + suffix, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: 'follow',
   });
   if (!res.ok) throw new Error(`MaxMind download failed with HTTP ${res.status}`);
   return Buffer.from(await res.arrayBuffer());
}

/** Extracts the .mmdb from a GeoLite2 tar.gz and checks that it opens. */
export function extractDatabase(archive: Buffer, workDir: string): Buffer {
   const archivePath = path.join(workDir, 'db.tar.gz');
   writeFileSync(archivePath, archive);
   execFileSync('tar', ['-xzf', archivePath, '-C', workDir]);
   const mmdb = readdirSync(workDir, { recursive: true, encoding: 'utf8' }).find(file =>
      file.endsWith('.mmdb')
   );
   if (!mmdb) throw new Error('Archive does not contain an .mmdb file');
   const database = readFileSync(path.join(workDir, mmdb));
   new Reader(database); // throws on a corrupt or truncated database
   return database;
}

/** Writes `database` next to `dest` and renames it into place. */
export function installDatabase(database: Buffer, dest: string): void {
   mkdirSync(path.dirname(dest), { recursive: true });
   const temp = `${dest}.tmp-${process.pid}`;
   writeFileSync(temp, database);
   renameSync(temp, dest);
}

async function main(): Promise<void> {
   const dest = path.resolve(requireEnv('GEOIP_DB_PATH'));
   const archiveFlag = process.argv.indexOf('--archive');
   let archive: Buffer;

   if (archiveFlag !== -1) {
      archive = readFileSync(path.resolve(process.argv[archiveFlag + 1]));
   } else {
      archive = await download('tar.gz');
      const expected = (await download('tar.gz.sha256')).toString('utf8').split(/\s+/)[0];
      const actual = createHash('sha256').update(archive).digest('hex');
      if (expected !== actual) throw new Error('GeoLite2 archive checksum mismatch');
   }

   const workDir = mkdtempSync(path.join(tmpdir(), 'geoip-'));
   try {
      installDatabase(extractDatabase(archive, workDir), dest);
      console.log(`Installed GeoLite2-Country database at ${dest}`);
   } finally {
      rmSync(workDir, { recursive: true, force: true });
   }
}

if (require.main === module) {
   main().catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
   });
}
