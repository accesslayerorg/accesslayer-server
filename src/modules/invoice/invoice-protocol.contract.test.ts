import {
   Account,
   Address,
   Contract,
   Keypair,
   StrKey,
   TransactionBuilder,
   nativeToScVal,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import {
   invoiceNetwork,
   parseIssuerScore,
   parseTransferDecision,
} from './invoice-protocol.contract';
import { inspectInvoicePurchase } from './invoice-market.service';
import {
   decodeInvoiceProtocolRpcEvent,
   parseInvoiceProtocolEvent,
} from '../indexer/invoice-protocol.events';

const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10));
const contract = StrKey.encodeContract(Buffer.alloc(32, 11));

beforeAll(() => {
   envConfig.INVOICE_MARKET_CONTRACT_ID = contract;
   envConfig.INVOICE_MARKET_ABI = JSON.stringify({
      function: 'fixture_buy',
      from: 1,
      to: 0,
      invoice: 2,
      limitPrice: 3,
   });
});

it.each([
   null,
   false,
   '',
   ' ',
   undefined,
   -1,
   1.2,
   '1e2',
   Infinity,
   2147483648,
])('rejects malformed issuer score %p', score => {
   expect(() => parseIssuerScore({ score, tier: 'GOLD' })).toThrow(
      'Invalid issuer score'
   );
});
it('preserves legitimate zero and large string score values', () => {
   expect(parseIssuerScore({ score: 0, tier: 'NEW' })).toEqual({
      score: 0,
      tier: 'NEW',
   });
   expect(parseIssuerScore({ score: '2147483647', tier: 'GOLD' }).score).toBe(
      2147483647
   );
});
it.each([
   false,
   null,
   {},
   { allowed: 'true' },
   { allowed: false },
   { allowed: false, reason: 'Blocked' },
])('does not treat malformed decisions as allowance: %p', value => {
   expect(() => parseTransferDecision(value)).toThrow();
});
it('requires an explicit reason and restriction type for blocked results', () => {
   expect(
      parseTransferDecision({
         allowed: false,
         reason: 'Frozen',
         restriction_type: 'FREEZE',
      })
   ).toEqual({ allowed: false, reason: 'Frozen', restriction_type: 'FREEZE' });
   expect(parseTransferDecision(true).allowed).toBe(true);
});

function purchase(
   method = 'fixture_buy',
   recipient = wallet.publicKey(),
   twoOperations = false
) {
   const op = new Contract(contract).call(
      method,
      new Address(recipient).toScVal(),
      new Address(other.publicKey()).toScVal(),
      nativeToScVal(18446744073709551615n, { type: 'u64' }),
      nativeToScVal(999999999999999999999n, { type: 'i128' })
   );
   const builder = new TransactionBuilder(
      new Account(wallet.publicKey(), '1'),
      { fee: '100', networkPassphrase: invoiceNetwork() }
   ).addOperation(op);
   if (twoOperations) builder.addOperation(op);
   const tx = builder.setTimeout(300).build();
   tx.sign(wallet);
   return tx.toXDR();
}
it('uses configured argument positions and preserves full-width invoice/price integers', () => {
   expect(inspectInvoicePurchase(purchase(), wallet.publicKey())).toMatchObject(
      {
         from: other.publicKey(),
         to: wallet.publicKey(),
         invoiceId: '18446744073709551615',
         limitPrice: '999999999999999999999',
      }
   );
});
it('rejects mismatched recipient, unknown methods, multi-operation envelopes and invalid XDR', () => {
   expect(() =>
      inspectInvoicePurchase(
         purchase('fixture_buy', other.publicKey()),
         wallet.publicKey()
      )
   ).toThrow('recipient');
   expect(() =>
      inspectInvoicePurchase(purchase('unknown_buy'), wallet.publicKey())
   ).toThrow('configured');
   expect(() =>
      inspectInvoicePurchase(
         purchase('fixture_buy', wallet.publicKey(), true),
         wallet.publicKey()
      )
   ).toThrow('single-operation');
   expect(() => inspectInvoicePurchase('invalid', wallet.publicKey())).toThrow(
      'Invalid signed'
   );
});
it('rejects overlapping ABI argument positions', () => {
   const config = envConfig.INVOICE_MARKET_ABI;
   envConfig.INVOICE_MARKET_ABI = JSON.stringify({
      function: 'fixture_buy',
      from: 0,
      to: 0,
      invoice: 2,
   });
   expect(() => inspectInvoicePurchase(purchase(), wallet.publicKey())).toThrow(
      'not configured'
   );
   envConfig.INVOICE_MARKET_ABI = config;
});
it('preserves byte evidence hashes and event identity within a transaction', () => {
   const raw = {
      eventType: 'ReportSubmitted',
      contractId: contract,
      txHash: 'same-transaction',
      ledger: 10,
      transactionIndex: 1,
      eventIndex: 0,
      timestamp: '2026-10-19T12:00:00Z',
      payload: {
         report_id: 1n,
         invoice_id: 2n,
         reporter: wallet.publicKey(),
         evidence_hash: Buffer.alloc(32, 3),
      },
   };
   const first = parseInvoiceProtocolEvent(raw);
   const second = parseInvoiceProtocolEvent({ ...raw, eventIndex: 1 });
   expect(first.payload.evidence_hash).toBe('03'.repeat(32));
   expect(second.id).not.toBe(first.id);
   expect(() =>
      parseInvoiceProtocolEvent({ ...raw, transactionIndex: undefined })
   ).toThrow();
});
it('ignores unsuccessful contract events and rejects cursor/ledger mismatches', () => {
   const raw = {
      id: `${(10n << 32n) + (1n << 12n)}-0`,
      contractId: contract,
      txHash: 'tx',
      ledger: 11,
      ledgerClosedAt: '2026-10-19T12:00:00Z',
      topic: [
         nativeToScVal('IssuerScoreUpdated', { type: 'symbol' }).toXDR(
            'base64'
         ),
      ],
      value: nativeToScVal({
         wallet: wallet.publicKey(),
         score: 1,
         tier: 'NEW',
      }).toXDR('base64'),
   };
   expect(
      decodeInvoiceProtocolRpcEvent({ ...raw, inSuccessfulContractCall: false })
   ).toBeNull();
   expect(() => decodeInvoiceProtocolRpcEvent(raw)).toThrow('ledger mismatch');
});
