// Uses PostgreSQL deliberately: jest.setup.ts otherwise replaces Prisma globally.
jest.unmock('@prisma/client');
jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../clients/soroban.client', () => ({
   ...jest.requireActual('../../clients/soroban.client'),
   defaultSorobanTransport: jest.fn(),
}));
jest.mock('../../utils/redis.utils', () => {
   const cache = new Map<string, { value: unknown; expires: number }>();
   return {
      cacheGetJson: jest.fn(async (key: string) => {
         const item = cache.get(key);
         return item && item.expires > Date.now() ? item.value : null;
      }),
      cacheSetJson: jest.fn(
         async (key: string, value: unknown, ttl: number) => {
            cache.set(key, { value, expires: Date.now() + ttl * 1000 });
         }
      ),
      cacheInvalidate: jest.fn(async (...keys: string[]) => {
         keys.forEach(key => cache.delete(key));
      }),
      getRedisClient: () => null,
      getRedis: () => null,
      redis: () => null,
      cacheGet: async () => null,
      cacheGetRaw: async () => null,
      cacheSetRaw: async () => {},
      disconnectRedis: async () => {},
   };
});

import request from 'supertest';
import type { IndexedLedger, InvoiceProtocolCursor } from '@prisma/client';
import {
   Account,
   Address,
   Contract,
   Keypair,
   StrKey,
   TransactionBuilder,
   nativeToScVal,
   scValToNative,
} from '@stellar/stellar-base';
import app from '../../app';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { defaultSorobanTransport } from '../../clients/soroban.client';
import { processIndexerEvents } from '../../modules/indexer/indexer-pipeline.service';
import { processInvoiceProtocolEvents } from '../../modules/indexer/invoice-protocol-indexer.service';
import { processInvoiceProtocolRpcPage } from '../../modules/indexer/invoice-protocol-rpc.service';
import {
   decodeInvoiceProtocolRpcEvent,
   InvoiceProtocolRpcEvent,
} from '../../modules/indexer/invoice-protocol.events';
import {
   invoiceNetwork,
   checkInvoiceTransfer,
   transferCacheKey,
   getIssuerScore,
   issuerCacheKey,
} from '../../modules/invoice/invoice-protocol.contract';
import { submitContractCall } from '../../modules/contracts/contract.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const seller = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const restricted = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const unknownWallet = Keypair.fromRawEd25519Seed(
   Buffer.alloc(32, 4)
).publicKey();
const contract = StrKey.encodeContract(Buffer.alloc(32, 5));
const invoiceId = '9200001';
const otherInvoiceId = '9200002';
const rpc = defaultSorobanTransport as jest.Mock;
let chainScore = 710;
let failSimulation = false;
const calls: string[] = [];
const submitted = new Set<string>();
const rejectedHashes = new Set<string>();
let checkpoints:
   | { ledger: IndexedLedger | null; cursor: InvoiceProtocolCursor | null }
   | undefined;
const prefix = 'invoice-protocol-test-';
const timestamp = new Date('2026-10-19T12:00:00Z');
const auth = (wallet: Keypair) =>
   `Bearer ${signWalletAccessToken(wallet.publicKey())}`;

function event(
   eventType: string,
   payload: object,
   sequence: number,
   overrides: object = {}
): IndexerChainEvent {
   return {
      contractId: contract,
      eventType,
      payload,
      ledger: 900,
      transactionIndex: sequence,
      eventIndex: 0,
      txHash: `${prefix}${sequence}`,
      timestamp: timestamp.toISOString(),
      ...overrides,
   };
}
function signedPurchase(
   wallet: Keypair,
   sequence: number,
   id = invoiceId,
   from = seller.publicKey()
) {
   const tx = new TransactionBuilder(
      new Account(wallet.publicKey(), String(sequence)),
      { fee: '100', networkPassphrase: invoiceNetwork() }
   )
      .addOperation(
         new Contract(contract).call(
            'test_purchase',
            new Address(from).toScVal(),
            new Address(wallet.publicKey()).toScVal(),
            nativeToScVal(BigInt(id), { type: 'u64' }),
            nativeToScVal(100n, { type: 'i128' })
         )
      )
      .setTimeout(3600)
      .build();
   tx.sign(wallet);
   return tx.toXDR();
}
function wire(input: IndexerChainEvent): InvoiceProtocolRpcEvent {
   return {
      id: `${(BigInt(input.ledger!) << 32n) + (BigInt(input.transactionIndex) << 12n)}-${input.eventIndex}`,
      contractId: input.contractId,
      txHash: input.txHash,
      ledger: input.ledger!,
      ledgerClosedAt: String(input.timestamp),
      topic: [
         nativeToScVal(input.eventType, { type: 'symbol' }).toXDR('base64'),
      ],
      value: nativeToScVal(input.payload).toXDR('base64'),
      inSuccessfulContractCall: true,
   };
}
async function clean() {
   await prisma.invoiceLimitOrder.deleteMany({
      where: { invoiceId: { in: [invoiceId, otherInvoiceId] } },
   });
   await prisma.transferRestrictionEvent.deleteMany({
      where: { invoiceId: { in: [invoiceId, otherInvoiceId] } },
   });
   await prisma.fraudReport.deleteMany({
      where: { invoiceId: { in: [invoiceId, otherInvoiceId] } },
   });
   await prisma.timelockChange.deleteMany({
      where: { proposalId: { in: ['9300001', '9300002', '9300003'] } },
   });
   await prisma.issuerScore.deleteMany({
      where: { wallet: seller.publicKey() },
   });
   await prisma.invoiceProtocolEvent.deleteMany({
      where: { txHash: { startsWith: prefix } },
   });
   await prisma.invoice.deleteMany({
      where: { id: { in: [invoiceId, otherInvoiceId] } },
   });
   await prisma.contractTransaction.deleteMany({
      where: {
         submitterWallet: { in: [buyer.publicKey(), restricted.publicKey()] },
      },
   });
   await prisma.sessionActivity.deleteMany({
      where: {
         wallet: {
            in: [seller.publicKey(), buyer.publicKey(), restricted.publicKey()],
         },
      },
   });
}

const describeDatabase =
   process.env.RUN_INVOICE_PROTOCOL_INTEGRATION === '1'
      ? describe
      : describe.skip;
describeDatabase('invoice protocol against PostgreSQL', () => {
   beforeAll(async () => {
      // All addresses and function names are deterministic fixtures, not deployment ABI claims.
      Object.assign(envConfig, {
         ISSUER_REPUTATION_CONTRACT_ID: contract,
         INVOICE_TRANSFER_CONTRACT_ID: contract,
         INVOICE_MARKET_CONTRACT_ID: contract,
         INVOICE_FRAUD_CONTRACT_ID: contract,
         INVOICE_TIMELOCK_CONTRACT_ID: contract,
         INVOICE_MARKET_ABI: JSON.stringify({
            function: 'test_purchase',
            from: 0,
            to: 1,
            invoice: 2,
            limitPrice: 3,
         }),
      });
      await prisma.$queryRaw`SELECT 1`; // fails if the actual PostgreSQL connection is unavailable
      const [ledger, cursor] = await Promise.all([
         prisma.indexedLedger.findUnique({ where: { id: 1 } }),
         prisma.invoiceProtocolCursor.findUnique({ where: { id: 1 } }),
      ]);
      checkpoints = { ledger, cursor };
      await clean();
      await prisma.invoice.createMany({
         data: [invoiceId, otherInvoiceId].map(id => ({
            id,
            sellerWallet: seller.publicKey(),
            amount: '100',
         })),
      });
      rpc.mockImplementation(async (_url: string, body: any) => {
         calls.push(body.method);
         if (body.method === 'simulateTransaction') {
            if (failSimulation)
               return { result: { error: 'temporary simulation failure' } };
            const decoded = TransactionBuilder.fromXDR(
               body.params.transaction,
               invoiceNetwork()
            );
            const tx =
               'innerTransaction' in decoded
                  ? decoded.innerTransaction
                  : decoded;
            const op = tx.operations[0];
            if (op.type !== 'invokeHostFunction')
               throw new Error('Unexpected operation');
            const invocation = op.func.invokeContract();
            const method = invocation.functionName().toString();
            const args = invocation.args().map(scValToNative);
            const value =
               method === 'get_issuer_score'
                  ? { score: chainScore, tier: 'GOLD' }
                  : args[1] === restricted.publicKey()
                    ? {
                         allowed: false,
                         reason: 'Investor is not accredited',
                         restriction_type: 'ACCREDITATION',
                      }
                    : { allowed: true };
            return {
               result: {
                  results: [{ xdr: nativeToScVal(value).toXDR('base64') }],
               },
            };
         }
         if (body.method === 'sendTransaction') {
            const tx = TransactionBuilder.fromXDR(
               body.params.transaction,
               invoiceNetwork()
            );
            const hash = tx.hash().toString('hex');
            if (rejectedHashes.has(hash))
               return {
                  result: { status: 'ERROR', errorResultXdr: 'tx_bad_auth' },
               };
            submitted.add(hash);
            return { result: { status: 'PENDING', hash } };
         }
         if (body.method === 'getTransaction')
            // `latestLedger` is part of a real getTransaction response and is
            // what the #724 ledger-depth gate reads: report the network head
            // two ledgers past inclusion so buys/sells confirm immediately.
            return { result: { status: 'SUCCESS', ledger: 901, latestLedger: 903 } };
         throw new Error(`Unexpected RPC method ${body.method}`);
      });
   });
   afterAll(async () => {
      await clean();
      if (checkpoints) {
         if (checkpoints.ledger)
            await prisma.indexedLedger.upsert({
               where: { id: 1 },
               create: checkpoints.ledger,
               update: checkpoints.ledger,
            });
         else await prisma.indexedLedger.deleteMany({ where: { id: 1 } });
         if (checkpoints.cursor)
            await prisma.invoiceProtocolCursor.upsert({
               where: { id: 1 },
               create: checkpoints.cursor,
               update: checkpoints.cursor,
            });
         else
            await prisma.invoiceProtocolCursor.deleteMany({ where: { id: 1 } });
      }
      await prisma.$disconnect();
      process.stdout.write('INVOICE_PROTOCOL_DATABASE_VERIFIED\n');
   });

   it('indexes concurrent score deliveries once, exposes chain score, paginates history, and invalidates its 60s cache', async () => {
      const first = event(
         'IssuerScoreUpdated',
         { wallet: seller.publicKey(), score: 700, tier: 'GOLD' },
         1
      );
      await Promise.all([
         processInvoiceProtocolEvents([first, first]),
         processInvoiceProtocolEvents([first]),
      ]);
      const base = `/api/v1/issuers/${seller.publicKey()}/reputation`;
      const start = calls.length;
      const one = await request(app).get(base);
      expect(one.status).toBe(200);
      expect(one.body.data).toEqual({
         score: 710,
         tier: 'GOLD',
         history_count: 1,
         last_updated: timestamp.toISOString(),
      });
      expect((await request(app).get(base)).body.data.score).toBe(710);
      expect(calls.slice(start)).toEqual(['simulateTransaction']);
      expect(cacheSetJson).toHaveBeenCalledWith(
         expect.any(String),
         { score: 710, tier: 'GOLD' },
         60
      );
      chainScore = 820;
      const second = event(
         'IssuerScoreUpdated',
         { wallet: seller.publicKey(), score: 800, tier: 'GOLD' },
         2
      );
      await processIndexerEvents([second, second]);
      await processInvoiceProtocolEvents([first]); // old replay must not roll back current state
      expect(
         (
            await prisma.issuerScore.findUniqueOrThrow({
               where: { wallet: seller.publicKey() },
            })
         ).score
      ).toBe(800);
      expect((await request(app).get(base)).body.data).toMatchObject({
         score: 820,
         history_count: 2,
      });
      expect(cacheInvalidate).toHaveBeenCalled();
      const history = await request(app).get(`${base}/history?page=1&limit=1`);
      expect(history.body.data).toHaveLength(1);
      expect(history.body.data[0]).toMatchObject({
         score: 800,
         event_type: 'IssuerScoreUpdated',
         timestamp: timestamp.toISOString(),
      });
      expect(history.body.meta).toMatchObject({
         totalCount: 2,
         hasNextPage: true,
      });
      expect(
         (await request(app).get(`${base}/history?page=2&limit=1`)).body.data[0]
            .score
      ).toBe(700);
      expect(
         (await request(app).get(`/api/v1/issuers/${unknownWallet}/reputation`))
            .status
      ).toBe(404);
      expect(
         (
            await request(app).get(
               `/api/v1/issuers/${unknownWallet}/reputation/history`
            )
         ).status
      ).toBe(404);
      expect((await request(app).get(`${base}/history?limit=-1`)).status).toBe(
         400
      );
   });

   it('projects fraud reports replay-safely, scopes report detail and updates under_review', async () => {
      const submittedEvent = event(
         'ReportSubmitted',
         {
            report_id: '9400001',
            invoice_id: invoiceId,
            reporter: buyer.publicKey(),
            evidence_hash: 'ab'.repeat(32),
            notes: 'Duplicated receivable',
         },
         10
      );
      await processIndexerEvents([submittedEvent, submittedEvent]);
      expect(
         (await request(app).get(`/api/v1/invoices/${invoiceId}`)).body.data
            .under_review
      ).toBe(true);
      expect(
         (
            await request(app).get(
               `/api/v1/invoices/${otherInvoiceId}/reports/9400001`
            )
         ).status
      ).toBe(404);
      const detail = await request(app).get(
         `/api/v1/invoices/${invoiceId}/reports/9400001`
      );
      expect(detail.body.data).toMatchObject({
         evidence_hash: 'ab'.repeat(32),
         notes: 'Duplicated receivable',
         status: 'OPEN',
      });
      await processIndexerEvents([
         event(
            'ReportResolved',
            {
               report_id: '9400001',
               invoice_id: invoiceId,
               resolution: 'DISMISSED',
               resolution_notes: 'Documents verified',
            },
            11
         ),
      ]);
      await processInvoiceProtocolEvents([submittedEvent]);
      const page = await request(app).get(
         `/api/v1/invoices/${invoiceId}/reports?limit=1`
      );
      expect(page.body.meta.totalCount).toBe(1);
      expect(page.body.data[0]).toMatchObject({
         status: 'RESOLVED',
         resolution_notes: 'Documents verified',
      });
      expect(
         (await request(app).get(`/api/v1/invoices/${invoiceId}`)).body.data
            .under_review
      ).toBe(false);
      // An orphan resolution remains durable until the earlier submission arrives.
      await processInvoiceProtocolEvents([
         event(
            'ReportResolved',
            {
               report_id: '9400002',
               invoice_id: invoiceId,
               resolution: 'CONFIRMED',
            },
            13
         ),
      ]);
      await processInvoiceProtocolEvents([
         event(
            'ReportSubmitted',
            {
               report_id: '9400002',
               invoice_id: invoiceId,
               reporter: buyer.publicKey(),
               evidence_hash: 'cd'.repeat(32),
            },
            12
         ),
      ]);
      expect(
         (
            await request(app).get(
               `/api/v1/invoices/${invoiceId}/reports/9400002`
            )
         ).body.data.status
      ).toBe('RESOLVED');
      expect((await request(app).get('/api/v1/invoices/unknown')).status).toBe(
         404
      );
      // Static compare route remains ahead of invoice detail.
      expect(
         (
            await request(app).get(
               `/api/v1/invoices/compare?ids=${invoiceId},${otherInvoiceId}`
            )
         ).status
      ).toBe(200);
   });

   it('indexes timelock lifecycles and recomputes pending countdown on each HTTP request', async () => {
      const eta = Math.floor(Date.now() / 1000) + 120;
      const proposed = (id: string, sequence: number) =>
         event(
            'ChangeProposed',
            {
               proposal_id: id,
               target: contract,
               function: 'set_fee',
               params: ['100'],
               eta,
            },
            sequence
         );
      await processIndexerEvents([
         proposed('9300001', 20),
         proposed('9300002', 21),
         proposed('9300003', 22),
      ]);
      await Promise.all([
         processInvoiceProtocolEvents([
            event(
               'ChangeExecuted',
               { proposal_id: '9300002', outcome: 'Fee changed' },
               23
            ),
         ]),
         processInvoiceProtocolEvents([
            event(
               'ChangeCancelled',
               { proposal_id: '9300003', outcome: 'Withdrawn' },
               24
            ),
         ]),
      ]);
      await processInvoiceProtocolEvents([proposed('9300002', 21)]);
      const first = await request(app).get(
         '/api/v1/governance/timelock/pending'
      );
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body.data).toHaveLength(1);
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 10000);
      const later = await request(app).get(
         '/api/v1/governance/timelock/pending'
      );
      clock.mockRestore();
      expect(
         first.body.data[0].countdown_seconds -
            later.body.data[0].countdown_seconds
      ).toBeGreaterThanOrEqual(9);
      expect(
         (await request(app).get('/api/v1/governance/timelock/history?limit=1'))
            .body.meta
      ).toMatchObject({ totalCount: 2, hasNextPage: true });
      expect(
         (await request(app).get('/api/v1/governance/timelock/9300002')).body
            .data
      ).toMatchObject({
         target: contract,
         function: 'set_fee',
         params: ['100'],
         status: 'EXECUTED',
         outcome: 'Fee changed',
         countdown_seconds: 0,
      });
      expect(
         (await request(app).get('/api/v1/governance/timelock/unknown')).status
      ).toBe(404);
   });

   it('decodes real ScVal events and checkpoints complete RPC pages without skipping failed events', async () => {
      const raw = wire(
         event(
            'IssuerScoreUpdated',
            { wallet: seller.publicKey(), score: 830, tier: 'GOLD' },
            30
         )
      );
      expect(decodeInvoiceProtocolRpcEvent(raw)).toMatchObject({
         eventType: 'IssuerScoreUpdated',
         transactionIndex: 30,
      });
      const before = await prisma.indexedLedger.findUnique({
         where: { id: 1 },
      });
      await processInvoiceProtocolRpcPage({
         events: [raw, raw],
         cursor: raw.id,
         latestLedger: 999,
      });
      expect(
         await prisma.invoiceProtocolCursor.findUnique({ where: { id: 1 } })
      ).toMatchObject({ cursor: raw.id, ledger: 900 });
      expect(
         await prisma.indexedLedger.findUnique({ where: { id: 1 } })
      ).toEqual(before);
      const malformed = {
         ...raw,
         value: nativeToScVal({
            wallet: seller.publicKey(),
            tier: 'GOLD',
         }).toXDR('base64'),
      };
      await expect(
         processInvoiceProtocolRpcPage({
            events: [malformed],
            cursor: 'bad-page',
            latestLedger: 999,
         })
      ).rejects.toThrow();
      expect(
         (
            await prisma.invoiceProtocolCursor.findUniqueOrThrow({
               where: { id: 1 },
            })
         ).cursor
      ).toBe(raw.id);
      await expect(
         processInvoiceProtocolEvents([
            event(
               'IssuerScoreUpdated',
               { wallet: seller.publicKey(), score: 1, tier: 'BAD' },
               31,
               { contractId: 'untrusted' }
            ),
         ])
      ).rejects.toThrow('Unexpected contract');
   });

   it('blocks invoice buys with reason/type, allows valid buys and cannot bypass checks via generic submission metadata', async () => {
      const blockedXdr = signedPurchase(restricted, 40);
      const blocked = await request(app)
         .post(`/api/v1/invoices/${invoiceId}/buy`)
         .set('Authorization', auth(restricted))
         .send({ transaction_xdr: blockedXdr });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toMatchObject({
         code: 'TransferBlocked',
         message: 'Investor is not accredited',
         details: expect.arrayContaining([
            { field: 'restriction_type', message: 'ACCREDITATION' },
         ]),
      });
      expect(submitted.size).toBe(0);
      const start = calls.length;
      await expect(
         submitContractCall(
            {
               operation: 'claim',
               submitterWallet: restricted.publicKey(),
               transactionXdr: blockedXdr,
            },
            {}
         )
      ).rejects.toMatchObject({ code: 'TransferBlocked' });
      expect(calls.length).toBe(start); // identical pair hits the decision cache
      const allowed = await request(app)
         .post(`/api/v1/invoices/${invoiceId}/buy`)
         .set('Authorization', auth(buyer))
         .send({ transaction_xdr: signedPurchase(buyer, 41) });
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.status).toBe('CONFIRMED');
      expect(submitted.size).toBe(1);
      expect(
         (
            await request(app)
               .post(`/api/v1/invoices/${otherInvoiceId}/buy`)
               .set('Authorization', auth(buyer))
               .send({ transaction_xdr: signedPurchase(buyer, 42) })
         ).status
      ).toBe(400);
      expect(
         (
            await request(app)
               .post(`/api/v1/invoices/${invoiceId}/buy`)
               .send({ transaction_xdr: signedPurchase(buyer, 43) })
         ).status
      ).toBe(401);
   });

   it('uses exact pair/invoice cache keys, expires after 60s, and fails closed on simulation errors', async () => {
      await cacheInvalidate(
         transferCacheKey(buyer.publicKey(), seller.publicKey(), invoiceId)
      );
      const start = calls.length;
      await checkInvoiceTransfer(
         buyer.publicKey(),
         seller.publicKey(),
         invoiceId
      );
      await checkInvoiceTransfer(
         buyer.publicKey(),
         seller.publicKey(),
         invoiceId
      );
      expect(calls.length - start).toBe(1);
      await checkInvoiceTransfer(
         buyer.publicKey(),
         seller.publicKey(),
         otherInvoiceId
      );
      expect(calls.length - start).toBe(2);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
      await checkInvoiceTransfer(
         buyer.publicKey(),
         seller.publicKey(),
         invoiceId
      );
      clock.mockRestore();
      expect(calls.length - start).toBe(3);
      failSimulation = true;
      await cacheInvalidate(
         transferCacheKey(seller.publicKey(), buyer.publicKey(), otherInvoiceId)
      );
      const sent = submitted.size;
      const response = await request(app)
         .post(`/api/v1/invoices/${otherInvoiceId}/buy`)
         .set('Authorization', auth(buyer))
         .send({ transaction_xdr: signedPurchase(buyer, 44, otherInvoiceId) });
      failSimulation = false;
      expect(response.status).toBe(503);
      expect(submitted.size).toBe(sent);
   });

   it('stores signed limit orders durably and concurrent matching skips restricted pairs while filling eligible orders once', async () => {
      for (const [wallet, seq] of [
         [restricted, 50],
         [buyer, 51],
      ] as const) {
         const result = await request(app)
            .post(`/api/v1/invoices/${invoiceId}/limit-orders`)
            .set('Authorization', auth(wallet))
            .send({ transaction_xdr: signedPurchase(wallet, seq) });
         expect(result.status).toBe(201);
         expect(result.body.data.limit_price).toBe('100');
      }
      const before = submitted.size;
      const sendCount = calls.filter(
         method => method === 'sendTransaction'
      ).length;
      const match = () =>
         request(app)
            .post(`/api/v1/invoices/${invoiceId}/limit-orders/match`)
            .set('Authorization', auth(seller))
            .send({});
      const responses = await Promise.all([match(), match()]);
      responses.forEach(response => expect(response.status).toBe(200));
      const results = responses.flatMap(response => response.body.data);
      expect(results).toEqual(
         expect.arrayContaining([
            expect.objectContaining({
               status: 'SKIPPED',
               restriction_type: 'ACCREDITATION',
            }),
            expect.objectContaining({ status: 'FILLED' }),
         ])
      );
      expect(submitted.size - before).toBe(1);
      expect(
         calls.filter(method => method === 'sendTransaction').length - sendCount
      ).toBe(1);
      expect(
         await prisma.invoiceLimitOrder.count({
            where: { invoiceId, status: 'FILLED' },
         })
      ).toBe(1);
      expect(
         await prisma.invoiceLimitOrder.count({
            where: { invoiceId, status: 'PENDING' },
         })
      ).toBe(1);
   });

   it('indexes TransferBlocked audit records once and invalidates the matching restriction cache', async () => {
      const audit = event(
         'TransferBlocked',
         {
            invoice_id: invoiceId,
            from: seller.publicKey(),
            to: restricted.publicKey(),
            reason: 'Investor is not accredited',
            restriction_type: 'ACCREDITATION',
         },
         60
      );
      await Promise.all([
         processInvoiceProtocolEvents([audit]),
         processInvoiceProtocolEvents([audit]),
      ]);
      const response = await request(app).get(
         `/api/v1/invoices/${invoiceId}/transfer-audit?limit=1`
      );
      expect(response.status).toBe(200);
      expect(response.body.meta.totalCount).toBe(1);
      expect(response.body.data[0]).toMatchObject({
         event_type: 'TransferBlocked',
         reason: 'Investor is not accredited',
         restriction_type: 'ACCREDITATION',
         event_index: 0,
      });
      expect(cacheInvalidate).toHaveBeenCalledWith(
         transferCacheKey(seller.publicKey(), restricted.publicKey(), invoiceId)
      );
   });

   it('requires configured ABI and refreshes issuer cache at its TTL boundary', async () => {
      const config = envConfig.INVOICE_MARKET_ABI;
      envConfig.INVOICE_MARKET_ABI = undefined;
      const response = await request(app)
         .post(`/api/v1/invoices/${invoiceId}/buy`)
         .set('Authorization', auth(buyer))
         .send({ transaction_xdr: signedPurchase(buyer, 70) });
      envConfig.INVOICE_MARKET_ABI = config;
      expect(response.status).toBe(503);
      const record = await prisma.issuerScore.findUniqueOrThrow({
         where: { wallet: seller.publicKey() },
      });
      await cacheInvalidate(
         issuerCacheKey(seller.publicKey(), record.lastEventId)
      );
      const start = calls.length;
      await getIssuerScore(seller.publicKey(), record.lastEventId);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
      await getIssuerScore(seller.publicKey(), record.lastEventId);
      clock.mockRestore();
      expect(calls.length - start).toBe(2);
   });
   it('continues beyond 100 restricted orders, retires user errors, and recovers expired submission leases', async () => {
      const startAt = Date.now() - 10000;
      const rows = Array.from({ length: 102 }, (_, index) => {
         const wallet = index < 100 ? restricted : buyer;
         const transactionXdr = signedPurchase(
            wallet,
            100 + index,
            otherInvoiceId
         );
         const txHash = TransactionBuilder.fromXDR(
            transactionXdr,
            invoiceNetwork()
         )
            .hash()
            .toString('hex');
         if (index === 100) rejectedHashes.add(txHash);
         return {
            invoiceId: otherInvoiceId,
            fromWallet: seller.publicKey(),
            buyerWallet: wallet.publicKey(),
            limitPrice: '100',
            transactionXdr,
            txHash,
            createdAt: new Date(startAt + index),
            status: index === 101 ? 'SUBMITTING' : 'PENDING',
            leaseUntil: index === 101 ? new Date(startAt) : null,
         };
      });
      await prisma.invoiceLimitOrder.createMany({ data: rows });
      const result = await request(app)
         .post(`/api/v1/invoices/${otherInvoiceId}/limit-orders/match`)
         .set('Authorization', auth(seller))
         .send({});
      expect(result.status).toBe(200);
      expect(
         result.body.data.filter(
            (row: { status: string }) => row.status === 'SKIPPED'
         )
      ).toHaveLength(100);
      expect(
         result.body.data.filter(
            (row: { status: string }) => row.status === 'FAILED'
         )
      ).toHaveLength(1);
      expect(
         result.body.data.filter(
            (row: { status: string }) => row.status === 'FILLED'
         )
      ).toHaveLength(1);
      expect(
         await prisma.invoiceLimitOrder.count({
            where: { invoiceId: otherInvoiceId, status: 'FAILED' },
         })
      ).toBe(1);
      expect(
         await prisma.invoiceLimitOrder.count({
            where: { invoiceId: otherInvoiceId, status: 'FILLED' },
         })
      ).toBe(1);
   });

   it('keeps equal report IDs on different invoices independent', async () => {
      await processInvoiceProtocolEvents([
         event(
            'ReportSubmitted',
            {
               report_id: '9400001',
               invoice_id: otherInvoiceId,
               reporter: seller.publicKey(),
               evidence_hash: 'other-invoice-evidence',
            },
            80
         ),
      ]);
      expect(
         (
            await request(app).get(
               `/api/v1/invoices/${otherInvoiceId}/reports/9400001`
            )
         ).body.data
      ).toMatchObject({
         status: 'OPEN',
         evidence_hash: 'other-invoice-evidence',
      });
      expect(
         (
            await request(app).get(
               `/api/v1/invoices/${invoiceId}/reports/9400001`
            )
         ).body.data.status
      ).toBe('RESOLVED');
      expect(
         (await request(app).get(`/api/v1/invoices/${otherInvoiceId}`)).body
            .data.under_review
      ).toBe(true);
   });
});
