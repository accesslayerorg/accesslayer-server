# List Response Helper

## Overview

The `buildListResponse` helper provides a consistent way to construct paginated list response envelopes across all endpoints. It ensures all list responses follow the same structure: `{ data, meta: { total, hasMore, nextCursor? } }`.

## Usage

### Basic Usage (Offset Pagination)

For offset-based pagination without a cursor:

```typescript
import { buildListResponse } from '../utils/list-response.utils';
import { buildOffsetPaginationMeta } from '../utils/pagination.utils';

// In your controller
const [items, total] = await fetchActivityFeed(parsed.data);

const response = buildListResponse(items, {
   total,
   hasMore: parsed.data.offset + parsed.data.limit < total,
});

sendSuccess(res, response);
```

### With Existing Offset Meta

When you already have offset pagination metadata:

```typescript
import { buildListResponse } from '../utils/list-response.utils';
import { buildOffsetPaginationMeta } from '../utils/pagination.utils';

const [items, total] = await service.fetchData(query);

const offsetMeta = buildOffsetPaginationMeta({
   limit: query.limit,
   offset: query.offset,
   total,
});

const response = buildListResponse(items, {
   total: offsetMeta.total,
   hasMore: offsetMeta.hasMore,
});

sendSuccess(res, response);
```

### Cursor Pagination

For cursor-based pagination with a nextCursor:

```typescript
import { buildListResponse } from '../utils/list-response.utils';

const [items, total, nextCursor] = await service.fetchCursorData(query);

const response = buildListResponse(items, {
   total,
   hasMore: nextCursor !== null,
   nextCursor: nextCursor ?? undefined, // Convert null to undefined to omit from output
});

sendSuccess(res, response);
```

### Empty Results

The helper correctly handles empty result sets:

```typescript
const response = buildListResponse([], {
   total: 0,
   hasMore: false,
});

// Returns: { data: [], meta: { total: 0, hasMore: false } }
```

## Response Shape

### Without Cursor (Offset Pagination)

```json
{
   "data": [
      { "id": "1", "...": "..." },
      { "id": "2", "...": "..." }
   ],
   "meta": {
      "total": 100,
      "hasMore": true
   }
}
```

### With Cursor (Cursor Pagination)

```json
{
   "data": [
      { "id": "1", "...": "..." },
      { "id": "2", "...": "..." }
   ],
   "meta": {
      "total": 100,
      "hasMore": true,
      "nextCursor": "eyJpZCI6M30="
   }
}
```

### Empty Results

```json
{
   "data": [],
   "meta": {
      "total": 0,
      "hasMore": false
   }
}
```

## Key Behaviors

1. **nextCursor Omission**: When `nextCursor` is `undefined`, it is completely omitted from the output (not serialized as `null`). This keeps the response clean for offset-paginated endpoints.

2. **Type Safety**: The helper is generic and preserves the type of your data array:

   ```typescript
   interface User {
      id: string;
      name: string;
   }
   const users: User[] = [...];
   const response: ListResponse<User> = buildListResponse(users, meta);
   ```

3. **Consistent Structure**: All paginated list responses use the same envelope structure, making it easier for clients to parse responses predictably.

## Migration Example

### Before

```typescript
export const httpGetActivityFeed: AsyncController = async (req, res, next) => {
   const [items, total] = await fetchActivityFeed(parsed.data);

   const response = {
      items,
      meta: buildOffsetPaginationMeta({
         limit: parsed.data.limit,
         offset: parsed.data.offset,
         total,
      }),
   };

   sendSuccess(res, response);
};
```

### After

```typescript
import { buildListResponse } from '../../utils/list-response.utils';

export const httpGetActivityFeed: AsyncController = async (req, res, next) => {
   const [items, total] = await fetchActivityFeed(parsed.data);

   const offsetMeta = buildOffsetPaginationMeta({
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      total,
   });

   const response = buildListResponse(items, {
      total: offsetMeta.total,
      hasMore: offsetMeta.hasMore,
   });

   sendSuccess(res, response);
};
```

## Benefits

1. **Consistency**: All list endpoints return the same envelope shape
2. **Type Safety**: Generic typing ensures correct data types
3. **Maintainability**: Changes to the envelope structure only require updating one place
4. **Clarity**: Explicit meta field requirements prevent missing fields
5. **Flexibility**: Supports both offset and cursor pagination patterns
