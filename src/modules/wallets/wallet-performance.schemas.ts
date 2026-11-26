import { z } from 'zod';
import { PERFORMANCE_RANGES } from '../portfolio/returns.service';

export const WalletPerformanceQuerySchema = z.object({
   range: z.enum(PERFORMANCE_RANGES).default('30d'),
});
