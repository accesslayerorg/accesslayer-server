import { classifyLaunchPhase } from './key-launch-auction.service';

describe('classifyLaunchPhase (#1328)', () => {
   it('puts a settled auction whose window has passed in "recent"', () => {
      const now = new Date('2026-01-10T00:00:00Z');
      const auction = {
         status: 'settled',
         startsAt: new Date('2026-01-01T00:00:00Z'),
         endsAt: new Date('2026-01-02T00:00:00Z'),
      };
      expect(classifyLaunchPhase(auction, now)).toBe('recent');
   });
});
