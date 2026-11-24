import assert from 'node:assert/strict';
import { createAccessLayerClient } from '../dist/index.js';

const baseUrl = process.env.SDK_CONTRACT_BASE_URL || 'http://localhost:3000';
const client = createAccessLayerClient({ baseUrl, apiKey: process.env.SDK_CONTRACT_API_KEY });

const keys = await client.GET('/creators/keys');
assert.ok([200,401,403].includes(keys.response.status));
console.log('sdk contract smoke ok');
