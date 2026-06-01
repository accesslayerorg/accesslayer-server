import fs from 'fs';
import { verifyMigrationChecksums } from '../migration-checksum.utils';
import { prisma } from '../prisma.utils';
import { logger } from '../logger.utils';

jest.mock('fs');
jest.mock('../prisma.utils', () => ({
   prisma: {
      $queryRawUnsafe: jest.fn(),
   },
}));
jest.mock('../logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('migration-checksum.utils', () => {
   const mockFs = fs as jest.Mocked<typeof fs>;
   const mockPrisma = prisma as jest.Mocked<any>;

   beforeEach(() => {
      jest.clearAllMocks();
      mockFs.existsSync.mockReturnValue(true);
   });

   it('should skip if migrations directory does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      await verifyMigrationChecksums();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
   });

   it('should skip if migrations table does not exist', async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('Table not found'));
      await verifyMigrationChecksums();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('table not found'));
   });

   it('should pass if checksums match', async () => {
      mockPrisma.$queryRawUnsafe
         .mockResolvedValueOnce([{}]) // Table check
         .mockResolvedValueOnce([
            { migration_name: '20240101_init', checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } // SHA256 of empty string (normalized)
         ]);

      mockFs.readdirSync.mockReturnValue([
         { name: '20240101_init', isDirectory: () => true }
      ] as any);
      mockFs.readFileSync.mockReturnValue('');

      await verifyMigrationChecksums();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Verified checksums'));
   });

   it('should throw error if checksum mismatch detected', async () => {
      mockPrisma.$queryRawUnsafe
         .mockResolvedValueOnce([{}]) // Table check
         .mockResolvedValueOnce([
            { migration_name: '20240101_init', checksum: 'wrong-checksum' }
         ]);

      mockFs.readdirSync.mockReturnValue([
         { name: '20240101_init', isDirectory: () => true }
      ] as any);
      mockFs.readFileSync.mockReturnValue('some content');

      await expect(verifyMigrationChecksums()).rejects.toThrow('Migration checksum mismatch');
      expect(logger.error).toHaveBeenCalled();
   });

   it('should ignore unapplied migrations (new migrations)', async () => {
      mockPrisma.$queryRawUnsafe
         .mockResolvedValueOnce([{}]) // Table check
         .mockResolvedValueOnce([]); // No migrations in DB

      mockFs.readdirSync.mockReturnValue([
         { name: '20240101_init', isDirectory: () => true }
      ] as any);
      mockFs.readFileSync.mockReturnValue('new content');

      await verifyMigrationChecksums();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Verified checksums for 0 migrations'));
   });
});
