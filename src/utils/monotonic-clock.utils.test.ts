import { strict as assert } from 'assert';
import { startTimer, elapsedMs, elapsedMsFormatted } from './monotonic-clock.utils';

async function run() {
   // elapsedMs returns a non-negative number
   const t = startTimer();
   const ms = elapsedMs(t);
   assert.ok(typeof ms === 'number', 'elapsedMs should return a number');
   assert.ok(ms >= 0, 'elapsed time should be non-negative');

   // elapsedMs grows over time
   const t2 = startTimer();
   await new Promise((r) => setTimeout(r, 20));
   const elapsed = elapsedMs(t2);
   assert.ok(elapsed >= 15, `expected >= 15ms, got ${elapsed}ms`);

   // elapsedMsFormatted returns a string ending in "ms" with 3 decimal places
   const t3 = startTimer();
   const formatted = elapsedMsFormatted(t3);
   assert.ok(typeof formatted === 'string', 'should return a string');
   assert.ok(formatted.endsWith('ms'), 'should end with "ms"');
   assert.ok(/^\d+\.\d{3}ms$/.test(formatted), `unexpected format: ${formatted}`);

   console.log('monotonic-clock.utils tests passed');
}

run().catch((err) => {
   console.error(err);
   process.exit(1);
});
