import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.API_BASE_URL || 'http://localhost:3000';
await delay(6000); // toxic duration
for (let i=0;i<30;i++) {
  try {
    const res = await fetch(`${base}/health/ready`);
    if (res.status === 200) { console.log('db-disconnect recovered'); process.exit(0); }
  } catch {}
  await delay(1000);
}
assert.fail('readiness did not recover after db disconnect');
