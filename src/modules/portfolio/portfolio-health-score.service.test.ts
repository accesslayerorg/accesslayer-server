import {
   HealthScoreUnavailableError,
   parseHealthScoreResult,
} from './portfolio-health-score.service';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

const validRow = {
   score: 742,
   concentration_score: 80,
   maturity_distribution_score: 70,
   issuer_diversity_score: 65,
   default_exposure_score: 90,
};

describe('parseHealthScoreResult', () => {
   it('returns null score and factors for a wallet with no portfolio', () => {
      expect(parseHealthScoreResult(null)).toEqual({ score: null, factors: null });
      expect(parseHealthScoreResult(undefined)).toEqual({
         score: null,
         factors: null,
      });
   });

   it('maps the composite score and all four factor scores', () => {
      expect(parseHealthScoreResult(validRow)).toEqual({
         score: 742,
         factors: {
            concentration_score: 80,
            maturity_distribution_score: 70,
            issuer_diversity_score: 65,
            default_exposure_score: 90,
         },
      });
   });

   it('accepts bigint values from the XDR decoder', () => {
      const parsed = parseHealthScoreResult({
         ...validRow,
         score: BigInt(742),
      });

      expect(parsed.score).toBe(742);
   });

   it('treats a response missing a factor as unavailable', () => {
      expect(() =>
         parseHealthScoreResult({ ...validRow, default_exposure_score: undefined })
      ).toThrow(HealthScoreUnavailableError);
   });

   it('treats a negative score as unavailable', () => {
      expect(() =>
         parseHealthScoreResult({ ...validRow, score: -1 })
      ).toThrow(HealthScoreUnavailableError);
   });
});
