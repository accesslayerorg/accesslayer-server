import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { httpBuyCreatorKey, buySchema } from './buy.controller';
import { buyGateway } from './buy.service';
import { validateBody } from '../../middlewares/validate-body.middleware';

const app = express();
app.use(express.json());
app.post(
   '/api/v1/creators/:id/buy',
   requireStellarSignature(),
   validateBody(buySchema),
   httpBuyCreatorKey
);

describe('POST creator buy balance guard', () => {
   const wallet = Keypair.random();
   const body = { quantity: 1, key_cost_xlm: 10, fee_xlm: 1 };

   afterEach(() => jest.restoreAllMocks());

   it('returns 422 without submitting when the wallet is underfunded', async () => {
      jest.spyOn(buyGateway, 'getXlmBalance').mockResolvedValue(10.99);
      const submit = jest
         .spyOn(buyGateway, 'submitBuy')
         .mockResolvedValue({ transactionHash: 'unused' });

      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .set(buildAuthHeaders(body, wallet))
         .send(body);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('insufficient_balance');
      expect(submit).not.toHaveBeenCalled();
   });

   it('submits when the balance exactly equals cost plus fees', async () => {
      jest.spyOn(buyGateway, 'getXlmBalance').mockResolvedValue(11);
      const submit = jest
         .spyOn(buyGateway, 'submitBuy')
         .mockResolvedValue({ transactionHash: 'tx-1' });

      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .set(buildAuthHeaders(body, wallet))
         .send(body);

      expect(response.status).toBe(200);
      expect(response.body.data.transactionHash).toBe('tx-1');
      expect(submit).toHaveBeenCalledTimes(1);
   });

   it('returns 401 when signature authentication is missing', async () => {
      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .send(body);
      expect(response.status).toBe(401);
   });
});
