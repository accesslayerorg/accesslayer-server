import { Keypair } from '@stellar/stellar-base';
import { CreateAirdropSchema } from './airdrop.schemas';

const address = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();

describe('creator-signed airdrop allocation validation', () => {
   it('accepts exact positive i128 amounts without number conversion', () => {
      const amount = '170141183460469231731687303715884105727';
      expect(CreateAirdropSchema.parse({
         keyId: 'key',
         allocations: [{ address, amount }],
      }).allocations[0].amount).toBe(amount);
   });

   it.each(['0', '-1', '1.5', '1e4', '170141183460469231731687303715884105728'])(
      'rejects invalid amount %s', amount => {
         expect(CreateAirdropSchema.safeParse({
            keyId: 'key', allocations: [{ address, amount }],
         }).success).toBe(false);
      }
   );

   it('rejects duplicate addresses, empty allocations, and bad checksums', () => {
      expect(CreateAirdropSchema.safeParse({
         keyId: 'key', allocations: [{ address, amount: '1' }, { address, amount: '2' }],
      }).success).toBe(false);
      expect(CreateAirdropSchema.safeParse({ keyId: 'key', allocations: [] }).success).toBe(false);
      expect(CreateAirdropSchema.safeParse({
         keyId: 'key', allocations: [{ address: 'G'.repeat(56), amount: '1' }],
      }).success).toBe(false);
   });
});
