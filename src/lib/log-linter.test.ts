import pino from 'pino';
import { lintLogLines } from './log-linter';
import { createPinoScrubHooks, createScrubRules, createWalletHasher } from './scrub';

const WALLET = 'G' + 'A'.repeat(55);
const SEED = 'S' + 'C'.repeat(55);

/**
 * Sample log calls covering the shapes the server actually emits: request
 * context, auth failures, trades, webhook delivery and an error with a stack.
 * Every line is produced through the scrub hooks, so the linter must pass.
 */
function captureScrubbedLogs(): string[] {
   const lines: string[] = [];
   const stream = {
      write(chunk: string) {
         lines.push(chunk.trimEnd());
      },
   };
   const rules = createScrubRules({
      walletHasher: createWalletHasher({ secret: 'lint-secret', rotationMs: 60_000, now: () => 0 }),
   });
   const logger = pino({ hooks: createPinoScrubHooks(rules) }, stream as unknown as pino.DestinationStream);

   logger.info({ route: '/api/v1/auth/login', email: 'jane@example.com' }, 'login attempt');
   logger.warn(
      { headers: { authorization: 'Bearer abcdefghijklmnopqrstuv' }, token: 'tok-123' },
      'rejected request'
   );
   logger.info({ actor: WALLET, creatorId: 'c_1', amount: 3 }, `KEY_BOUGHT by ${WALLET}`);
   logger.error(
      { err: new Error('webhook failed for https://hooks.example.com/x?api_key=supersecretvalue') },
      'webhook delivery failed'
   );
   logger.info({ seed: SEED, note: 'should never be logged' }, 'diagnostic');

   return lines;
}

describe('log linter', () => {
   it('reports no findings for logs emitted through the scrub hooks', () => {
      const lines = captureScrubbedLogs();

      expect(lines.length).toBeGreaterThan(0);
      expect(lintLogLines(lines)).toEqual([]);
   });

   it('fails a log line that carries an unredacted email', () => {
      const findings = lintLogLines([
         '{"level":30,"msg":"welcome jane@example.com"}',
      ]);

      expect(findings).toEqual([
         expect.objectContaining({ line: 1, rule: 'email' }),
      ]);
   });

   it('fails a log line with an unredacted secret-named JSON field', () => {
      const findings = lintLogLines(['{"level":30,"apiKey":"live-abcdef123456"}']);

      expect(findings.map(f => f.rule)).toContain('secret-field');
   });

   it('fails a log line with a bearer token, JWT, API key or Stellar seed', () => {
      const findings = lintLogLines([
         'Authorization: Bearer abcdefghijklmnop',
         'token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
         'key sk_live_ABCDEFGH12345678',
         `seed ${SEED}`,
      ]);

      expect(findings.map(f => f.rule)).toEqual(
         expect.arrayContaining(['bearer-token', 'jwt', 'api-key', 'stellar-seed'])
      );
   });

   it('flags raw wallet addresses so they are hashed instead', () => {
      const findings = lintLogLines([`buyer ${WALLET}`]);
      expect(findings).toEqual([expect.objectContaining({ rule: 'wallet-address', line: 1 })]);
   });

   it('does not echo full secret values in its report', () => {
      const findings = lintLogLines(['{"password":"hunter2-very-long-secret-value"}']);

      for (const finding of findings) {
         expect(finding.match).not.toContain('hunter2-very-long-secret-value');
      }
   });

   it('reports the 1-based line number of each violation', () => {
      const findings = lintLogLines(['clean line', 'mail a@b.co', 'clean again']);
      expect(findings).toEqual([expect.objectContaining({ line: 2, rule: 'email' })]);
   });
});
