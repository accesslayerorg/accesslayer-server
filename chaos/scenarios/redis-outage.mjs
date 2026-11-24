import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.API_BASE_URL || 'http://localhost:3000';
for (let i=0;i<20;i++) {
  try {
    const res = await fetch(`${base}/health`);
    // Redis outage should degrade but reads should not hard-fail (200/503 acceptable depending endpoint)
    assert.ok(res.status < 500, `health hard-failed during redis outage: ${res.status}`);
  } catch (e) {
    assert.fail(`health request failed during redis outage: ${e}`);
  }
  await delay(500);
}
console.log('redis-outage scenario ok');
