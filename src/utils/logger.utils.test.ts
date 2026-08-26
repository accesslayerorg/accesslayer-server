import pino from 'pino';
import { requestContextStorage } from './als.utils';

// Recreate the same mixin wiring as logger.utils.ts, pointed at a
// synchronous in-memory stream so we can assert on the actual emitted
// JSON line rather than re-deriving the ALS lookup separately.
function makeTestLogger() {
   const lines: Record<string, unknown>[] = [];
   const stream = {
      write(chunk: string) {
         lines.push(JSON.parse(chunk));
      },
   };
   const testLogger = pino(
      {
         mixin() {
            const traceId = requestContextStorage.getStore()?.traceId;
            return traceId ? { traceId } : {};
         },
      },
      stream as unknown as pino.DestinationStream
   );
   return { testLogger, lines };
}

describe('logger mixin — traceId propagation via AsyncLocalStorage', () => {
   it('omits traceId when logging outside of any request context', () => {
      const { testLogger, lines } = makeTestLogger();

      testLogger.info('no context');

      expect(lines[0]).not.toHaveProperty('traceId');
   });

   it('attaches the same traceId to every log call made within one request context', () => {
      const { testLogger, lines } = makeTestLogger();

      requestContextStorage.run(
         { path: '/x', method: 'GET', traceId: 'trace-abc-123' },
         () => {
            testLogger.info('middleware layer');
            (function serviceLayer() {
               testLogger.info('service layer');
            })();
            (function dbLayer() {
               testLogger.info('db layer');
            })();
         }
      );

      expect(lines).toHaveLength(3);
      for (const line of lines) {
         expect(line.traceId).toBe('trace-abc-123');
      }
   });

   it('does not leak the traceId between concurrent requests', async () => {
      const { testLogger, lines } = makeTestLogger();

      const run = (traceId: string, delayMs: number) =>
         requestContextStorage.run(
            { path: '/x', method: 'GET', traceId },
            async () => {
               await new Promise(resolve => setTimeout(resolve, delayMs));
               testLogger.info('concurrent request log');
            }
         );

      await Promise.all([run('trace-req-1', 20), run('trace-req-2', 5)]);

      expect(lines).toHaveLength(2);
      const traceIds = lines.map(l => l.traceId);
      expect(traceIds).toContain('trace-req-1');
      expect(traceIds).toContain('trace-req-2');
      expect(traceIds[0]).not.toBe(traceIds[1]);
   });
});
