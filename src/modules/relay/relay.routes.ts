import { Router } from 'express';
import { z } from 'zod';
import { isValidStellarAddress } from '../../modules/wallet/wallet.utils';
import { reserveNonce, relaySignedTransaction } from './relay.service';

const relayRouter = Router();
const submitSchema = z.object({
   wallet: z.string().trim().min(1),
   nonce: z.string().regex(/^\d+$/),
   signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
   tx_params: z.string().min(1),
});

relayRouter.get('/nonce/:wallet', async (req, res) => {
   const wallet = req.params.wallet;
   if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ error: 'A valid Stellar wallet is required' });
      return;
   }
   try {
      res.json({ wallet: wallet.toUpperCase(), nonce: await reserveNonce(wallet) });
   } catch (error) {
      const failure = error as Error & { statusCode?: number };
      res.status(failure.statusCode ?? 502).json({ error: failure.message });
   }
});

relayRouter.post('/submit', async (req, res) => {
   const parsed = submitSchema.safeParse(req.body);
   if (!parsed.success || !isValidStellarAddress(parsed.data.wallet)) {
      res.status(400).json({ error: 'Invalid relay payload' });
      return;
   }
   try {
      res.json(await relaySignedTransaction(parsed.data));
   } catch (error) {
      const failure = error as Error & { statusCode?: number; details?: unknown };
      res.status(failure.statusCode ?? 502).json({
         error: failure.message,
         ...(failure.details ? { details: failure.details } : {}),
      });
   }
});

export default relayRouter;
