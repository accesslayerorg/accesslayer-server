import {
   SOULBOUND_BADGE_EVENT_TYPES,
   soulboundBadgeEventKey,
} from './soulbound-badge-events.utils';

describe('soulbound badge events (#1330)', () => {
   it('recognizes the three lifecycle event types', () => {
      expect(SOULBOUND_BADGE_EVENT_TYPES.has('badge_awarded')).toBe(true);
      expect(SOULBOUND_BADGE_EVENT_TYPES.has('badge_revoked')).toBe(true);
      expect(SOULBOUND_BADGE_EVENT_TYPES.has('badge_renounced')).toBe(true);
   });

   it('derives a stable idempotency key from txHash and eventIndex', () => {
      expect(soulboundBadgeEventKey('0xabc', 2)).toBe('0xabc:2');
   });
});
