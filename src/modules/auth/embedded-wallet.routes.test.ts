// src/modules/auth/embedded-wallet.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GABCDEF1234567890' };
      next();
   },
}));

jest.mock('./passkey.service', () => {
   const actual = jest.requireActual('./passkey.service');
   return {
      ...actual,
      signWithEmbeddedWallet: jest.fn(),
      requestEmbeddedWalletExportConfirmation: jest.fn(),
      exportEmbeddedWallet: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import embeddedWalletRouter from './embedded-wallet.routes';
import {
   signWithEmbeddedWallet,
   exportEmbeddedWallet,
   PasskeyServiceError,
} from './passkey.service';

describe('embedded-wallet.routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/embedded-wallet', embeddedWalletRouter);

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('POST /v1/embedded-wallet/sign signs transaction', async () => {
      (signWithEmbeddedWallet as jest.Mock).mockResolvedValue({
         publicKey: 'GABCDEF1234567890',
         signedXdr: 'AAAA-signed',
      });

      const res = await request(app)
         .post('/v1/embedded-wallet/sign')
         .send({ transactionXdr: 'AAAA', amount: 50 });

      expect(res.status).toBe(200);
      expect(res.body.data.signedXdr).toBe('AAAA-signed');
   });

   it('POST /v1/embedded-wallet/sign returns 403 when assertion required', async () => {
      (signWithEmbeddedWallet as jest.Mock).mockRejectedValue(
         new PasskeyServiceError(
            403,
            'PASSKEY_ASSERTION_REQUIRED',
            'Transactions above 100 require a recent passkey assertion'
         )
      );

      const res = await request(app)
         .post('/v1/embedded-wallet/sign')
         .send({ transactionXdr: 'AAAA', amount: 500 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PASSKEY_ASSERTION_REQUIRED');
   });

   it('POST /v1/embedded-wallet/export returns secret when verified', async () => {
      (exportEmbeddedWallet as jest.Mock).mockResolvedValue({
         publicKey: 'GABCDEF1234567890',
         secretKey: 'SSECRET123',
      });

      const res = await request(app)
         .post('/v1/embedded-wallet/export')
         .send({ emailConfirmationCode: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.data.publicKey).toBe('GABCDEF1234567890');
   });
});
