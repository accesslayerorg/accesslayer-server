import pino from 'pino';
import {
   createPinoScrubHooks,
   createScrubRules,
   createScrubRulesFromEnv,
   createSentryBeforeSend,
   createWalletHasher,
   REDACTED,
   scrub,
   scrubString,
} from './scrub';

const WALLET_A = 'G' + 'A'.repeat(55);
const WALLET_B = 'G' + 'B'.repeat(55);
const SEED = 'S' + 'C'.repeat(55);

function rulesAt(nowMs: number, secret = 'test-secret', extraFields: string[] = []) {
   return createScrubRules({
      extraFields,
      walletHasher: createWalletHasher({
         secret,
         rotationMs: 1000,
         now: () => nowMs,
      }),
   });
}

describe('scrub — sensitive field names', () => {
   it('redacts known sensitive keys regardless of case, dashes or underscores', () => {
      const rules = rulesAt(0);
      const out = scrub(
         {
            password: 'p1',
            api_key: 'k1',
            'API-KEY': 'k2',
            accessToken: 't1',
            Authorization: 'Bearer x',
            cookie: 'sid=1',
            keep: 'visible',
         },
         rules
      );

      expect(out).toEqual({
         password: REDACTED,
         api_key: REDACTED,
         'API-KEY': REDACTED,
         accessToken: REDACTED,
         Authorization: REDACTED,
         cookie: REDACTED,
         keep: 'visible',
      });
   });

   it('redacts sensitive keys nested inside objects and arrays', () => {
      const rules = rulesAt(0);
      const out = scrub(
         {
            request: {
               headers: { authorization: 'Bearer abc', 'x-trace': 'ok' },
            },
            items: [{ secret: 's1' }, { name: 'n', passkeyCredential: 'pk' }],
         },
         rules
      );

      expect(out).toEqual({
         request: { headers: { authorization: REDACTED, 'x-trace': 'ok' } },
         items: [{ secret: REDACTED }, { name: 'n', passkeyCredential: REDACTED }],
      });
   });

   it('honours deployment-specific extra fields', () => {
      const rules = rulesAt(0, 'test-secret', ['internalRef']);
      expect(scrub({ internalRef: 'abc', nested: { INTERNAL_REF: 'x' } }, rules)).toEqual({
         internalRef: REDACTED,
         nested: { INTERNAL_REF: REDACTED },
      });
   });

   it('parses SCRUB_EXTRA_FIELDS from the environment', () => {
      const rules = createScrubRulesFromEnv({
         SCRUB_EXTRA_FIELDS: ' vatNumber , , shipping_code ',
         SCRUB_WALLET_HASH_SECRET: 'env-secret',
      } as NodeJS.ProcessEnv);

      expect(scrub({ vatNumber: '123', shippingCode: 'abc' }, rules)).toEqual({
         vatNumber: REDACTED,
         shippingCode: REDACTED,
      });
   });
});

describe('scrub — string content', () => {
   it('redacts emails, bearer tokens, JWTs, API keys and inline secrets', () => {
      const rules = rulesAt(0);
      const text = [
         'contact jane.doe@example.com',
         'Authorization: Bearer abcdefghijklmnop.qrstuv',
         'jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
         'key sk_live_ABCDEFGH12345678',
         'api_key=supersecretvalue',
      ].join(' | ');

      const out = scrubString(text, rules);

      expect(out).not.toContain('jane.doe@example.com');
      expect(out).toContain('[REDACTED:email]');
      expect(out).not.toContain('abcdefghijklmnop');
      expect(out).toContain('Bearer [REDACTED:token]');
      expect(out).toContain('[REDACTED:jwt]');
      expect(out).not.toContain('sk_live_ABCDEFGH12345678');
      expect(out).toContain('[REDACTED:api-key]');
      expect(out).not.toContain('supersecretvalue');
      expect(out).toContain('api_key=[REDACTED:secret]');
    });

   it('never echoes a Stellar secret seed', () => {
      const rules = rulesAt(0);
      expect(scrubString(`seed ${SEED} leaked`, rules)).toBe('seed [REDACTED:seed] leaked');
   });

   it('hashes Stellar wallet addresses found inside free text', () => {
      const rules = rulesAt(0);
      const out = scrubString(`buyer ${WALLET_A} bought`, rules);

      expect(out).not.toContain(WALLET_A);
      expect(out).toMatch(/buyer wallet_[0-9a-f]{16} bought/);
   });
});

describe('scrub — wallet hashing', () => {
   it('is consistent within one salt period', () => {
      const hasher = createWalletHasher({ secret: 's', rotationMs: 1000, now: () => 100 });
      expect(hasher(WALLET_A)).toBe(hasher(WALLET_A));
      expect(hasher(WALLET_A)).not.toBe(hasher(WALLET_B));
   });

   it('changes after the salt rotates', () => {
      let clock = 100;
      const hasher = createWalletHasher({ secret: 's', rotationMs: 1000, now: () => clock });
      const before = hasher(WALLET_A);
      clock = 1500;
      expect(hasher(WALLET_A)).not.toBe(before);
   });

   it('hashes values under wallet-style field names', () => {
      const rules = rulesAt(0);
      const out = scrub({ actor: WALLET_A, owneraddress: WALLET_B, note: 'ok' }, rules) as Record<
         string,
         string
      >;

      expect(out.actor).toMatch(/^wallet_[0-9a-f]{16}$/);
      expect(out.owneraddress).toMatch(/^wallet_[0-9a-f]{16}$/);
      expect(out.note).toBe('ok');
   });
});

describe('scrub — structure handling', () => {
   it('does not mutate its input', () => {
      const rules = rulesAt(0);
      const input = { password: 'p', nested: { email: 'a@b.co' } };
      scrub(input, rules);
      expect(input).toEqual({ password: 'p', nested: { email: 'a@b.co' } });
   });

   it('handles circular references without recursing forever', () => {
      const rules = rulesAt(0);
      const node: Record<string, unknown> = { name: 'root' };
      node.self = node;

      const out = scrub(node, rules) as Record<string, unknown>;

      expect(out.name).toBe('root');
      expect(out.self).toBe('[Circular]');
   });

   it('converts errors to plain objects with scrubbed message and stack', () => {
      const rules = rulesAt(0);
      const error = new Error('failed for jane@example.com');

      const out = scrub(error, rules) as { message: string; stack: string; name: string };

      expect(out.name).toBe('Error');
      expect(out.message).toBe('failed for [REDACTED:email]');
      expect(out.stack).not.toContain('jane@example.com');
   });

   it('leaves dates and primitives unchanged', () => {
      const rules = rulesAt(0);
      const when = new Date('2026-01-01T00:00:00Z');
      expect(scrub({ when, count: 3, ok: true, none: null }, rules)).toEqual({
         when,
         count: 3,
         ok: true,
         none: null,
      });
   });
});

describe('scrub — pino integration', () => {
   function captureLogger(rules: ReturnType<typeof rulesAt>) {
      const lines: Record<string, unknown>[] = [];
      const stream = {
         write(chunk: string) {
            lines.push(JSON.parse(chunk));
         },
      };
      const logger = pino(
         { hooks: createPinoScrubHooks(rules) },
         stream as unknown as pino.DestinationStream
      );
      return { logger, lines };
   }

   it('scrubs the message and every field before output', () => {
      const { logger, lines } = captureLogger(rulesAt(0));

      logger.info(
         { password: 'hunter2', owner: 'jane@example.com', actor: WALLET_A },
         `reset mail sent to jane@example.com by ${WALLET_A}`
      );

      const raw = JSON.stringify(lines[0]);
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('jane@example.com');
      expect(raw).not.toContain(WALLET_A);
      expect(lines[0].password).toBe(REDACTED);
      expect(lines[0].msg).toMatch(/reset mail sent to \[REDACTED:email\]/);
   });

   it('passes printf-style interpolation arguments through the scrubber', () => {
      const { logger, lines } = captureLogger(rulesAt(0));
      logger.info('user %s logged in', 'jane@example.com');
      expect(JSON.stringify(lines[0])).not.toContain('jane@example.com');
    });
});

describe('scrub — Sentry beforeSend', () => {
   it('drops the user block, removes cookies, and scrubs the rest', () => {
      const beforeSend = createSentryBeforeSend(rulesAt(0));
      const event = beforeSend({
         message: 'boom for jane@example.com',
         user: { email: 'jane@example.com', id: 'u1' },
         request: {
            url: '/api/v1/x',
            cookies: { sid: 'abc' },
            headers: { authorization: 'Bearer abcdefghijklmnop' },
         },
         extra: { password: 'pw', wallet: WALLET_A },
      });

      expect(event).not.toHaveProperty('user');
      expect(event.request).not.toHaveProperty('cookies');
      expect(event.message).toBe('boom for [REDACTED:email]');
      expect(event.request?.headers).toEqual({ authorization: REDACTED });
      expect(event.extra).toEqual({ password: REDACTED, wallet: expect.stringMatching(/^wallet_/) });
   });
});
