import { StrKey } from '@stellar/stellar-base';
import {
   AllowlistFileTooLargeError,
   AllowlistRowLimitExceededError,
   importAllowlistCsv,
   MAX_ALLOWLIST_FILE_BYTES,
   MAX_ALLOWLIST_ROWS,
   parseAllowlistCsv,
} from './key-allowlist.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyAllowlistEntry: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
      $transaction: jest.fn(),
   },
}));

const { prisma } = require('../../utils/prisma.utils') as {
   prisma: {
      keyAllowlistEntry: {
         findMany: jest.Mock;
         upsert: jest.Mock;
      };
      $transaction: jest.Mock;
   };
};

const CREATOR_ID = 'key-123';

function address(seed: number): string {
   const bytes = Buffer.alloc(32, 0);
   bytes.writeUInt32BE(seed, 28);
   return StrKey.encodeEd25519PublicKey(bytes);
}

describe('key allowlist CSV import', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      prisma.keyAllowlistEntry.findMany.mockResolvedValue([]);
      prisma.keyAllowlistEntry.upsert.mockImplementation(async (args: any) => ({
         id: 'entry',
         ...args.create,
      }));
      prisma.$transaction.mockImplementation(async (ops: any) =>
         Promise.all(ops)
      );
   });

   describe('parseAllowlistCsv', () => {
      it('parses valid rows with an optional cap', () => {
         const a1 = address(1);
         const a2 = address(2);
         const csv = `address,cap\n${a1},10\n${a2},\n`;

         const result = parseAllowlistCsv(csv);

         expect(result.totalRows).toBe(2);
         expect(result.errors).toEqual([]);
         expect(result.rows).toEqual([
            { row: 2, address: a1, cap: 10 },
            { row: 3, address: a2, cap: null },
         ]);
      });

      it('reports invalid addresses, invalid caps and duplicate rows by line number', () => {
         const valid = address(1);
         const csv = [
            'address,cap',
            'not-an-address,1',
            `${valid},0`,
            `${valid},5`,
            `${valid},5`,
            `${address(2)},abc`,
         ].join('\n');

         const result = parseAllowlistCsv(csv);

         expect(result.totalRows).toBe(5);
         expect(result.rows).toEqual([{ row: 4, address: valid, cap: 5 }]);
         expect(result.errors).toEqual([
            { row: 2, message: 'invalid Stellar address: not-an-address' },
            { row: 3, message: 'cap must be a positive integer' },
            {
               row: 5,
               message: `duplicate address ${valid} (first seen at row 4)`,
            },
            { row: 6, message: 'cap must be a positive integer' },
         ]);
      });

      it('rejects a CSV without an address column', () => {
         expect(() => parseAllowlistCsv('wallet,cap\nabc,1\n')).toThrow(
            /address/
         );
      });
   });

   describe('importAllowlistCsv', () => {
      it('creates new rows, updates existing rows and reports counts', async () => {
         const a1 = address(1);
         const a2 = address(2);
         const a3 = address(3);
         prisma.keyAllowlistEntry.findMany.mockResolvedValue([{ address: a2 }]);
         const csv = `address,cap\n${a1},1\n${a2},2\n${a3},\n`;

         const report = await importAllowlistCsv(CREATOR_ID, csv);

         expect(report).toEqual({
            dryRun: false,
            totalRows: 3,
            created: 2,
            updated: 1,
            skipped: 0,
            errors: [],
         });
         expect(prisma.$transaction).toHaveBeenCalledTimes(1);
         expect(prisma.keyAllowlistEntry.upsert).toHaveBeenCalledTimes(3);
         expect(prisma.keyAllowlistEntry.upsert).toHaveBeenCalledWith({
            where: {
               creatorId_address: { creatorId: CREATOR_ID, address: a2 },
            },
            create: { creatorId: CREATOR_ID, address: a2, cap: 2 },
            update: { cap: 2 },
         });
      });

      it('imports valid rows and reports invalid ones with row numbers', async () => {
         const valid = address(1);
         const csv = `address,cap\nbad,1\n${valid},7\n`;

         const report = await importAllowlistCsv(CREATOR_ID, csv);

         expect(report.created).toBe(1);
         expect(report.skipped).toBe(1);
         expect(report.errors).toEqual([
            { row: 2, message: 'invalid Stellar address: bad' },
         ]);
         expect(prisma.keyAllowlistEntry.upsert).toHaveBeenCalledTimes(1);
      });

      it('does not write anything on a dry run', async () => {
         const csv = `address,cap\n${address(1)},1\n${address(2)},2\n`;

         const report = await importAllowlistCsv(CREATOR_ID, csv, {
            dryRun: true,
         });

         expect(report).toMatchObject({
            dryRun: true,
            totalRows: 2,
            created: 2,
            updated: 0,
            skipped: 0,
         });
         expect(prisma.$transaction).not.toHaveBeenCalled();
         expect(prisma.keyAllowlistEntry.upsert).not.toHaveBeenCalled();
      });

      it('surfaces a database failure from the transaction', async () => {
         prisma.$transaction.mockRejectedValue(new Error('database down'));
         const csv = `address\n${address(1)}\n`;

         await expect(importAllowlistCsv(CREATOR_ID, csv)).rejects.toThrow(
            'database down'
         );
      });

      it('rejects files larger than 2 MB', async () => {
         const csv = Buffer.alloc(MAX_ALLOWLIST_FILE_BYTES + 1, 'a');

         await expect(
            importAllowlistCsv(CREATOR_ID, csv)
         ).rejects.toBeInstanceOf(AllowlistFileTooLargeError);
         expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('rejects files with more than 5000 rows', async () => {
         const header = 'address\n';
         const row = `${address(1)}\n`;
         const csv = header + row.repeat(MAX_ALLOWLIST_ROWS + 1);

         await expect(
            importAllowlistCsv(CREATOR_ID, csv)
         ).rejects.toBeInstanceOf(AllowlistRowLimitExceededError);
         expect(prisma.$transaction).not.toHaveBeenCalled();
      });
   });
});
