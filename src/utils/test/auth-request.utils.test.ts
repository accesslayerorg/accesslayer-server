import express from 'express';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthRequest } from './auth-request.utils';
import {
   requireStellarSignature,
   type StellarSignedRequest,
} from '../../middlewares/stellar-signature.middleware';

function createSignatureTestApp() {
   const app = express();
   app.use(express.json());

   app.post(
      '/protected',
      requireStellarSignature(),
      (req: StellarSignedRequest, res) => {
         res.status(200).json({ signatureVerified: req.signatureVerified });
      }
   );

   app.delete(
      '/protected',
      requireStellarSignature(),
      (req: StellarSignedRequest, res) => {
         res.status(200).json({ signatureVerified: req.signatureVerified });
      }
   );

   return app;
}

describe('buildAuthRequest', () => {
   it('builds a POST request whose auth headers pass Stellar signature verification', async () => {
      const walletKeypair = Keypair.random();
      const body = { displayName: 'Auth Helper POST' };

      const res = await buildAuthRequest(
         'POST',
         '/protected',
         body,
         walletKeypair,
         {
            app: createSignatureTestApp(),
         }
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ signatureVerified: true });
   });

   it('builds a DELETE request whose auth headers pass Stellar signature verification', async () => {
      const walletKeypair = Keypair.random();
      const body = { reason: 'cleanup' };

      const res = await buildAuthRequest(
         'DELETE',
         '/protected',
         body,
         walletKeypair,
         {
            app: createSignatureTestApp(),
         }
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ signatureVerified: true });
   });
});
