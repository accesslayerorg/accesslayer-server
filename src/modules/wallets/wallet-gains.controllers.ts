import { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream';
import { z } from 'zod';
import {
   WalletGainsParamsSchema,
   WalletGainsQuerySchema,
} from './wallet-gains.schemas';
import {
   GainsService,
   RealizedGainRow,
   RealizedGainsResult,
} from '../../services/gains.service';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';

export const GAINS_CSV_HEADER = [
   'date',
   'key',
   'quantity',
   'proceeds',
   'cost_basis',
   'gain',
] as const;

/** Quotes a field and neutralises spreadsheet formula injection. */
function csvField(value: string): string {
   const safe =
      /^[=+@\t\r]/.test(value) || /^-(?!\d)/.test(value) ? `'${value}` : value;
   return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvLine(row: RealizedGainRow): string {
   return (
      [row.date, row.keyId, row.quantity, row.proceeds, row.costBasis, row.gain]
         .map(csvField)
         .join(',') + '\r\n'
   );
}

function* csvLines(result: RealizedGainsResult): Generator<string> {
   yield GAINS_CSV_HEADER.join(',') + '\r\n';
   for (const row of result.rows) {
      yield csvLine(row);
   }
}

function validate(
   req: Request,
   res: Response
): { address: string; year: number } | null {
   const params = WalletGainsParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid wallet address',
         params.error.issues.map((issue: z.ZodIssue) => ({
            field: 'address',
            message: issue.message,
         }))
      );
      return null;
   }

   const query = WalletGainsQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         query.error.issues.map((issue: z.ZodIssue) => ({
            field: 'year',
            message: issue.message,
         }))
      );
      return null;
   }

   return { address: params.data.address, year: query.data.year };
}

/** GET /api/v1/wallets/:address/gains?year= */
export async function httpGetWalletGains(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const input = validate(req, res);
      if (!input) return;

      const result = await GainsService.computeRealizedGains(
         input.address,
         input.year
      );
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
}

/** GET /api/v1/wallets/:address/gains.csv?year= */
export async function httpGetWalletGainsCsv(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const input = validate(req, res);
      if (!input) return;

      // Compute before touching headers so a failure still yields a normal
      // JSON error response rather than a truncated CSV.
      const result = await GainsService.computeRealizedGains(
         input.address,
         input.year
      );

      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
         'Content-Disposition',
         `attachment; filename="gains-${input.address}-${input.year}.csv"`
      );
      res.setHeader('Cache-Control', 'private, no-store');

      pipeline(Readable.from(csvLines(result)), res, error => {
         if (error && !res.headersSent) next(error);
      });
   } catch (error) {
      next(error);
   }
}
