import { z } from 'zod';

export const CreateSubscriptionSchema = z
   .object({
      topics: z
         .array(
            z.enum(['key_buy', 'key_sell', 'follower_added'], {
               errorMap: () => ({
                  message:
                     'Topic must be one of: key_buy, key_sell, follower_added',
               }),
            })
         )
         .min(1, 'At least one topic is required'),
   })
   .strict();

export type CreateSubscriptionInput = z.infer<typeof CreateSubscriptionSchema>;
