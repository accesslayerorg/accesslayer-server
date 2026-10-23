import { Router } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-base';
import { reserveNonce, relaySignedTransaction } from './relay.service';

const relayRouter = Router();
const submitSchema = z.object({
   wallet: z.string().trim().refine(StrKey.isValidEd25519PublicKey),
   nonce: z
      .string()
      .max(19)
      .regex(/^(0|[1-9]\d*)$/),
   signature: z
      .string()
      .length(88)
      .regex(/^[A-Za-z0-9+/]{86}==$/),
   tx_params: z.string().min(1).max(100_000),
});

relayRouter.get('/nonce/:wallet', async (req, res) => {
   const wallet = req.params.wallet;
   if (!StrKey.isValidEd25519PublicKey(wallet)) {
      res.status(400).json({ error: 'A valid Stellar wallet is required' });
      return;
   }
   try {
      res.json({
         wallet: wallet.toUpperCase(),
         nonce: await reserveNonce(wallet),
      });
   } catch (error) {
      const failure = error as Error & { statusCode?: number };
      if (failure.statusCode === 429) res.setHeader('Retry-After', '60');
      res.status(failure.statusCode ?? 503).json({
         error: failure.statusCode
            ? failure.message
            : 'Nonce service is unavailable',
      });
   }
});

relayRouter.post('/submit', async (req, res) => {
   const parsed = submitSchema.safeParse(req.body);
   if (!parsed.success || !StrKey.isValidEd25519PublicKey(parsed.data.wallet)) {
      res.status(400).json({ error: 'Invalid relay payload' });
      return;
   }
   try {
      res.json(await relaySignedTransaction(parsed.data));
   } catch (error) {
      const failure = error as Error & {
         statusCode?: number;
         details?: unknown;
      };
      if (failure.statusCode === 429) res.setHeader('Retry-After', '60');
      res.status(failure.statusCode ?? 503).json({
         error: failure.statusCode
            ? failure.message
            : 'Relay service is unavailable',
         ...(failure.details ? { details: failure.details } : {}),
      });
   }
});

export default relayRouter;
