import {
   crateNameForPath,
   isCatalogSourcePath,
   parseContractErrorEnums,
} from './contract-error-parser';

const SOURCE = `
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FeatureError {
    /// The \`caller\` is not the \`creator\` owning the key.
    Unauthorized = 1,
    /// Supply slope tiers are empty.
    /// Action: Provide at least one tier.
    InvalidCurveMilestones = 9,
    NotRegistered = 3,
}

pub enum NotAContractError {
    Ignored = 1,
}

#[contracterror]
pub enum LpRewardError {
    /// Pool is empty.
    PoolEmpty = 4, // trailing comment
}
`;

describe('parseContractErrorEnums', () => {
   it('extracts variants from every #[contracterror] enum in order', () => {
      const errors = parseContractErrorEnums(SOURCE);
      expect(errors.map(e => `${e.enum}.${e.name}=${e.code}`)).toEqual([
         'FeatureError.Unauthorized=1',
         'FeatureError.InvalidCurveMilestones=9',
         'FeatureError.NotRegistered=3',
         'LpRewardError.PoolEmpty=4',
      ]);
   });

   it('joins doc lines into the message and keeps Action: separate', () => {
      const [unauthorized, invalid] = parseContractErrorEnums(SOURCE);
      expect(unauthorized.message).toBe(
         'The `caller` is not the `creator` owning the key.'
      );
      expect(unauthorized.explicitAction).toBeNull();

      expect(invalid.message).toBe('Supply slope tiers are empty.');
      expect(invalid.explicitAction).toBe('Provide at least one tier.');
   });

   it('reports undocumented variants with null message and action', () => {
      const undocumented = parseContractErrorEnums(SOURCE).find(
         e => e.name === 'NotRegistered'
      );
      expect(undocumented).toEqual({
         enum: 'FeatureError',
         name: 'NotRegistered',
         code: 3,
         message: null,
         explicitAction: null,
      });
   });

   it('does not let docs from one variant leak into the next', () => {
      const source = `
#[contracterror]
pub enum E {
    /// Documented one.
    A = 1,
    B = 2,
}
`;
      const [a, b] = parseContractErrorEnums(source);
      expect(a.message).toBe('Documented one.');
      expect(b.message).toBeNull();
   });

   it('returns an empty list when the file has no contract errors', () => {
      expect(parseContractErrorEnums('pub enum Plain { A = 1 }')).toEqual([]);
   });
});

describe('isCatalogSourcePath', () => {
   it('accepts runtime Rust sources', () => {
      expect(isCatalogSourcePath('creator-keys/src/lib.rs')).toBe(true);
      expect(isCatalogSourcePath('common/src/guard.rs')).toBe(true);
   });

   it('rejects build output, VCS data, tests and non-Rust files', () => {
      expect(isCatalogSourcePath('target/debug/build/x.rs')).toBe(false);
      expect(isCatalogSourcePath('creator-keys/tests/flow.rs')).toBe(false);
      expect(isCatalogSourcePath('creator-keys/src/test_timelock.rs')).toBe(false);
      expect(isCatalogSourcePath('creator-keys/src/lib.md')).toBe(false);
   });
});

describe('crateNameForPath', () => {
   it('uses the first path segment as the crate name', () => {
      expect(crateNameForPath('creator-keys/src/events.rs')).toBe('creator-keys');
   });
});
