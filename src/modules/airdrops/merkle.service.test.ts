import { StrKey } from '@stellar/stellar-base';
import { MerkleService } from './merkle.service';

const allocations = [1, 2, 3].map(value => ({
   address: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, value)),
   amount: String(value * 10),
}));

describe('Merkle airdrop contract hashing', () => {
   it('matches the contract Address XDR + signed-i128 big-endian leaf fixture', () => {
      // ScVal address tag18, account tag0, ed25519 tag0, rawkey01*32, i128(10).
      expect(MerkleService.build([allocations[0]]).root).toBe(
         'cffab0d40712ea86ffc20cfd6586023b6806a0ebc9c8a1039f13edf805f61d38'
      );
   });

   it('matches a sorted-pair root with an odd promoted leaf', () => {
      const tree = MerkleService.build(allocations);
      expect(tree.root).toBe('c6fc689eecdca6620e4a6b8812971e2cb87553787115d2f4c1ea3d5a0e2177b5');
      expect(tree.leaves.map(leaf => leaf.proof.length)).toEqual([2, 2, 1]);
      tree.leaves.forEach(leaf => {
         expect(MerkleService.verify(leaf, leaf.proof, tree.root)).toBe(true);
      });
   });

   it('verifies first, middle, and last leaves without index-dependent sides', () => {
      const five = [...allocations, ...[4, 5].map(value => ({
         address: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, value)),
         amount: String(value * 10),
      }))];
      const tree = MerkleService.build(five);
      for (const index of [0, 2, 4]) {
         const leaf = tree.leaves[index];
         expect(MerkleService.verify(leaf, leaf.proof, tree.root)).toBe(true);
         expect(MerkleService.verify({ ...leaf, amount: String(Number(leaf.amount) + 1) }, leaf.proof, tree.root)).toBe(false);
      }
      expect(MerkleService.verify(tree.leaves[0], ['invalid'], tree.root)).toBe(false);
   });

   it('rejects empty, duplicate, and zero-amount lists and preserves inputs', () => {
      expect(() => MerkleService.build([])).toThrow();
      expect(() => MerkleService.build([allocations[0], allocations[0]])).toThrow();
      expect(() => MerkleService.build([{ ...allocations[0], amount: '0' }])).toThrow();
      const before = JSON.stringify(allocations);
      MerkleService.build(allocations);
      expect(JSON.stringify(allocations)).toBe(before);
   });
});
