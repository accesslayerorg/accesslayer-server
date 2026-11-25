# @accesslayer/sdk

TypeScript SDK generated from `docs/openapi.json`.

## Quick start

```ts
import { createAccessLayerClient } from '@accesslayer/sdk';

const client = createAccessLayerClient({
   baseUrl: 'http://localhost:3000',
   apiKey: process.env.ACCESSLAYER_API_KEY,
});

const keys = await client.GET('/creators/keys');
const trades = await client.GET('/creators/{creatorId}/trades', {
   params: { path: { creatorId: 'creator_123' } },
});
```

## Generate

```bash
pnpm --filter @accesslayer/sdk run generate
```

## CI freshness check

```bash
pnpm --filter @accesslayer/sdk run check:generated
```
