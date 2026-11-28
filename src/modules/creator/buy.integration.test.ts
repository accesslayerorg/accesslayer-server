import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { httpBuyCreatorKey, buySchema } from './buy.controller';
import { buyGateway } from './buy.service';
import { validateBody } from '../../middlewares/validate-body.middleware';
import { prisma } from '../../utils/prisma.utils';
import { computeWhitelistLeafHash, hashPair } from '../../utils/merkle';

jest.mock('../keys/key-trading.service', () => ({
   assertTradingActive: jest.fn().mockResolvedValue(undefined),
   TradingPausedError: class TradingPausedError extends Error {},
}));
jest.mock('../keys/key-freeze.service', () => ({
   assertPositionNotFrozen: jest.fn().mockResolvedValue(undefined),
   PositionFrozenError: class PositionFrozenError extends Error {},
}));
jest.mock('../indexer/flash-loan-guard-indexer.service', () => ({
   assertWalletNotSuspended: jest.fn().mockResolvedValue(undefined),
   WalletSuspendedError: class WalletSuspendedError extends Error {},
}));
jest.mock('../trading/liquidity-depth.service', () => ({
   getMaxAvailableDepth: jest.fn().mockResolvedValue(100n),
   LiquidityDepthUnavailableError: class LiquidityDepthUnavailableError extends Error {},
}));
jest.mock('../keys/key-cooldown.service', () => ({
   setBuyCooldownForWallet: jest.fn().mockResolvedValue(undefined),
}));

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

   function mockKey(overrides: Record<string, unknown> = {}) {
      jest.spyOn(prisma.creatorProfile, 'findFirst').mockResolvedValue({
         id: 'creator-1',
         whitelistEnabled: false,
         whitelistRoot: null,
         ...overrides,
      } as never);
   }

   it('returns 422 without submitting when the wallet is underfunded', async () => {
      mockKey();
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
      mockKey();
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

   it('blocks a gated key without a proof before checking the balance', async () => {
      mockKey({ whitelistEnabled: true, whitelistRoot: 'a'.repeat(64) });
      const balance = jest.spyOn(buyGateway, 'getXlmBalance');

      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .set(buildAuthHeaders(body, wallet))
         .send(body);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('whitelist_required');
      expect(balance).not.toHaveBeenCalled();
   });

   it('allows a gated key with a valid address proof', async () => {
      const sibling = 'b'.repeat(64);
      const leaf = computeWhitelistLeafHash(wallet.publicKey());
      const root = hashPair(leaf, sibling);
      mockKey({ whitelistEnabled: true, whitelistRoot: root });
      jest.spyOn(buyGateway, 'getXlmBalance').mockResolvedValue(11);
      const submit = jest
         .spyOn(buyGateway, 'submitBuy')
         .mockResolvedValue({ transactionHash: 'tx-proof' });

      const proofBody = {
         ...body,
         merkle_proof: [{ hash: sibling, side: 'right' }],
      };
      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .set(buildAuthHeaders(proofBody, wallet))
         .send(proofBody);

      expect(response.status).toBe(200);
      expect(submit).toHaveBeenCalledTimes(1);
   });

   it('rejects an invalid proof with whitelist_required', async () => {
      mockKey({ whitelistEnabled: true, whitelistRoot: 'a'.repeat(64) });

      const proofBody = {
         ...body,
         merkle_proof: [{ hash: 'b'.repeat(64), side: 'right' }],
      };
      const response = await request(app)
         .post('/api/v1/creators/creator-1/buy')
         .set(buildAuthHeaders(proofBody, wallet))
         .send(proofBody);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('whitelist_required');
   });
});
