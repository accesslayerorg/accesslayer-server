import supertest from 'supertest';
import app from '../../app';
import {
   Keypair,
   TransactionBuilder,
   Transaction,
   Networks,
   Operation,
} from '@stellar/stellar-base';

describe('POST /api/v1/auth/challenge — wallet auth challenge integration', () => {
   const clientKeypair = Keypair.random();
   const validAddress = clientKeypair.publicKey();

   it('returns 200 with valid base64 XDR transaction on valid wallet address', async () => {
      const res = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: validAddress });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.transaction).toBeDefined();
      expect(typeof res.body.data.transaction).toBe('string');

      // Assert decoding base64 XDR yields valid transaction
      const tx = TransactionBuilder.fromXDR(
         res.body.data.transaction,
         Networks.TESTNET
      ) as Transaction;
      expect(tx).toBeDefined();
   });

   it('contains web_auth_domain operation in decoded transaction', async () => {
      const res = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: validAddress });

      expect(res.status).toBe(200);

      const tx = TransactionBuilder.fromXDR(
         res.body.data.transaction,
         Networks.TESTNET
      ) as Transaction;

      const manageDataOp = tx.operations.find(
         (op): op is Operation.ManageData => op.type === 'manageData'
      );
      expect(manageDataOp).toBeDefined();
      expect(manageDataOp?.name).toContain('web_auth_domain');
   });

   it('generates non-empty nonce memo unique across consecutive calls', async () => {
      const res1 = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: validAddress });

      const res2 = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: validAddress });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const tx1 = TransactionBuilder.fromXDR(
         res1.body.data.transaction,
         Networks.TESTNET
      ) as Transaction;
      const tx2 = TransactionBuilder.fromXDR(
         res2.body.data.transaction,
         Networks.TESTNET
      ) as Transaction;

      expect(tx1.memo).toBeDefined();
      expect(tx2.memo).toBeDefined();

      const memo1 = tx1.memo.value ? tx1.memo.value.toString() : '';
      const memo2 = tx2.memo.value ? tx2.memo.value.toString() : '';

      expect(memo1.length).toBeGreaterThan(0);
      expect(memo2.length).toBeGreaterThan(0);
      expect(memo1).not.toBe(memo2);
   });

   it('returns 422 for invalid wallet address', async () => {
      const res = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: 'invalid-stellar-address-123' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('INVALID_ADDRESS');
      expect(res.body.error.field).toBe('address');
   });

   it('transaction is signed by the server keypair', async () => {
      const res = await supertest(app)
         .post('/api/v1/auth/challenge')
         .send({ address: validAddress });

      expect(res.status).toBe(200);

      const tx = TransactionBuilder.fromXDR(
         res.body.data.transaction,
         Networks.TESTNET
      ) as Transaction;

      expect(tx.signatures.length).toBeGreaterThan(0);

      const serverPublicKey = tx.source;
      const serverKeypair = Keypair.fromPublicKey(serverPublicKey);

      const signature = tx.signatures[0].signature();
      const verified = serverKeypair.verify(tx.hash(), signature);
      expect(verified).toBe(true);
   });
});
