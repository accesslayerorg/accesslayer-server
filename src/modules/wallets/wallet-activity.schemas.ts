import { z } from "zod";
import { StellarAddressSchema } from "../wallet/wallet.schemas";
import { safeIntParam } from "../../utils/query.utils";

export const WalletActivityParamsSchema = z.object({
   address: StellarAddressSchema,
});

export const WalletActivityQuerySchema = z
   .object({
      limit: safeIntParam({
         defaultValue: 20,
         min: 1,
         max: 100,
         label: "Limit",
      }),
      offset: safeIntParam({
         defaultValue: 0,
         min: 0,
         max: Number.MAX_SAFE_INTEGER,
         label: "Offset",
      }),
      type: z
         .enum([
            "buy",
            "sell",
            "transfer_in",
            "transfer_out",
            "burn",
            "dividend",
         ])
         .optional(),
      creator_id: z.string().optional(),
      cursor: z.string().optional(),
      from: z
         .string()
         .datetime({ message: "from must be an ISO 8601 datetime string" })
         .optional(),
      to: z
         .string()
         .datetime({ message: "to must be an ISO 8601 datetime string" })
         .optional(),
   })
   .strict();

export type WalletActivityQueryType = z.infer<typeof WalletActivityQuerySchema>;

export const UnifiedActivityTypeSchema = z.enum([
   "buy",
   "sell",
   "transfer_in",
   "transfer_out",
   "burn",
   "dividend",
]);

export type UnifiedActivityType = z.infer<typeof UnifiedActivityTypeSchema>;

export const WalletActivityItemSchema = z.object({
   id: z.string(),
   type: UnifiedActivityTypeSchema,
   keyId: z.string().optional(),
   creatorName: z.string().nullable().optional(),
   creator_id: z.string().optional(),
   creator_handle: z.string().nullable().optional(),
   amount: z.any(),
   price_at_trade: z.any().optional(),
   fee_paid: z.any().optional(),
   xlm_delta: z.string().nullable().optional(),
   ledger_sequence: z.number().nullable().optional(),
   timestamp: z.any(),
   txHash: z.string().nullable().optional(),
});

export type WalletActivityItem = z.infer<typeof WalletActivityItemSchema>;
