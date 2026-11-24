import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.API_BASE_URL || 'http://localhost:3000';
const start = Date.now();
let lastOk = 0;
while (Date.now() - start < 70000) {
  try {
    const res = await fetch(`${base}/health`);
    if (res.status === 200 || res.status === 503) lastOk = Date.now();
  } catch {}
  await delay(1000);
}
assert.ok(lastOk > 0, 'service never responded during rpc outage window');
// Post-outage recovery probe
await delay(2000);
const res = await fetch(`${base}/health`);
assert.ok(res.status < 500, `health endpoint failed after outage: ${res.status}`);
console.log('rpc-outage scenario ok');
