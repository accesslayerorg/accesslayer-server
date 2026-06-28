# Adding a New Route to the Creator API

This guide walks through the complete process of adding a new route to the creator API, from registration to deployment readiness. Follow these steps to ensure your endpoint integrates properly with the existing architecture.

## Overview

The creator API follows a consistent pattern for route registration, validation, middleware, and testing. This guide provides a step-by-step approach and a minimal working example.

## Step-by-Step Guide

### 1. Define Route Name Constant

Add your route name to the shared route constants in `src/constants/creator-public-routes.constants.ts`:

```typescript
export const CREATOR_PUBLIC_ROUTE_NAMES = {
   LIST: 'creators:list',
   GET_PROFILE: 'creators:profile:get',
   UPSERT_PROFILE: 'creators:profile:upsert',
   GET_STATS: 'creators:stats:get',
   // Add your new route here
   YOUR_NEW_ROUTE: 'creators:your-route:name',
} as const;
```

This provides a stable identifier for your route across controllers, tests, and cache configurations.

### 2. Define Cache Configuration

Add cache settings for your route in `src/constants/creator-public-cache.constants.ts`:

```typescript
export const CREATOR_PUBLIC_ROUTE_CACHE_PRESETS = {
   [CREATOR_PUBLIC_ROUTE_NAMES.LIST]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   [CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   [CREATOR_PUBLIC_ROUTE_NAMES.GET_PROFILE]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   // Add your new route cache preset here
   [CREATOR_PUBLIC_ROUTE_NAMES.YOUR_NEW_ROUTE]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
} as const;
```

For public read endpoints, use `publicReadSeconds` (defined as `PUBLIC_ENDPOINT_CACHE_SECONDS.short`). For sensitive or dynamic data, consider using `noStore: true` or shorter TTLs.

### 3. Create Query Validation Schema

Define your query parameter validation schema in `src/modules/creators/creators.schemas.ts` (or create a new `.schemas.ts` file if your route is in a different module):

```typescript
import { z } from 'zod';
import { safeIntParam, safeBooleanQueryParam } from '../../utils/query.utils';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

/**
 * Validation schema for your new route query parameters.
 */
export const YourNewRouteQuerySchema = z
  .object({
    // Pagination parameters (if needed)
    limit: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
    }),
    offset: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Offset',
    }),
    
    // Your custom query parameters
    customParam: z.string().optional(),
    anotherParam: safeBooleanQueryParam({
      paramName: 'anotherParam',
    }),
  })
  .strict();

export type YourNewRouteQueryType = z.infer<typeof YourNewRouteQuerySchema>;
```

**Key points:**
- Use `.strict()` to reject unknown query parameters
- Use helper functions like `safeIntParam` and `safeBooleanQueryParam` for type-safe parsing
- Provide default values where appropriate
- Import pagination constants if your endpoint supports pagination

### 4. Create Controller Handler

Create your controller handler in `src/modules/creators/creators.controllers.ts` (or a new `.controllers.ts` file):

```typescript
import { AsyncController } from '../../types/auth.types';
import { YourNewRouteQuerySchema } from './creators.schemas';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';

/**
 * Controller for GET /api/v1/creators/your-new-route
 *
 * Returns [describe what your endpoint returns].
 * Validates query parameters and applies caching via middleware.
 */
export const httpYourNewRoute: AsyncController = async (req, res, next) => {
   try {
      // Validate query parameters
      const parsed = parsePublicQuery(
         YourNewRouteQuerySchema,
         req.query,
         { debugContext: 'your-new-route-query' }
      );
      
      if (!parsed.ok) {
         return sendValidationError(res, 'Invalid query parameters', parsed.details);
      }
      
      const validatedQuery = parsed.data;

      // Your business logic here
      // Fetch data from services, databases, etc.
      const data = await yourBusinessLogic(validatedQuery);

      attachTimestampHeader(res);
      sendSuccess(res, data);
   } catch (error) {
      next(error);
   }
};
```

**Key points:**
- Use `AsyncController` type for async handlers
- Always use `parsePublicQuery` for validation
- Use `sendValidationError` for validation errors
- Use `sendSuccess` for successful responses
- Call `attachTimestampHeader` before sending response
- Pass errors to `next()` for error handling middleware

### 5. Register Route

Add your route to `src/modules/creators/creators.routes.ts`:

```typescript
import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats, httpYourNewRoute } from './creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';

const creatorsRouter = Router();

/**
 * GET /api/v1/creators/your-new-route
 *
 * [Description of what this endpoint does]
 * Public endpoint with [cache duration] cache.
 */
creatorsRouter.get(
   '/your-new-route',
   createCreatorReadMetricsMiddleware('your-route'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.YOUR_NEW_ROUTE]),
   httpYourNewRoute
);

export default creatorsRouter;
```

**Key points:**
- Add JSDoc comments describing the route
- Apply middleware in order: metrics → cache → handler
- Use the route name constant for cache configuration
- Use `createCreatorReadMetricsMiddleware` for read operations to track usage

### 6. Add Middleware (If Needed)

If your route requires additional middleware:

**For authentication/authorization:**
```typescript
import { requireCreatorProfileOwnership } from '../../middlewares/wallet-ownership.middleware';

router.put(
   '/:creatorId/your-route',
   requireCreatorProfileOwnership('creatorId'),
   yourHandler
);
```

**For other custom middleware:**
- Create middleware in `src/middlewares/` or module-specific middleware files
- Follow the Express middleware signature: `(req, res, next) => void`

### 7. Write Tests

Create comprehensive tests for your new route. Follow the existing test patterns in `src/modules/creators/`.

#### Unit Tests for Schema

Create `src/modules/creators/your-route.schemas.test.ts`:

```typescript
import { YourNewRouteQuerySchema } from './creators.schemas';

describe('YourNewRouteQuerySchema', () => {
   it('validates correct query parameters', () => {
      const result = YourNewRouteQuerySchema.safeParse({
         limit: 20,
         offset: 0,
         customParam: 'value',
      });
      expect(result.success).toBe(true);
   });

   it('rejects unknown parameters', () => {
      const result = YourNewRouteQuerySchema.safeParse({
         limit: 20,
         unknownParam: 'value',
      });
      expect(result.success).toBe(false);
   });

   it('applies default values', () => {
      const result = YourNewRouteQuerySchema.safeParse({});
      if (result.success) {
         expect(result.data.limit).toBeDefined();
         expect(result.data.offset).toBe(0);
      }
   });
});
```

#### Integration Tests for Route

Create `src/modules/creators/your-route.integration.test.ts`:

```typescript
import { httpYourNewRoute } from './creators.controllers';

// Lightweight request/response mocks
function makeReq(query: Record<string, string> = {}): any {
   return { query };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

describe('GET /api/v1/creators/your-new-route', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns 200 with valid query parameters', async () => {
      const req = makeReq({ limit: '20' });
      const res = makeRes();
      await httpYourNewRoute(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
   });

   it('returns 400 with invalid query parameters', async () => {
      const req = makeReq({ limit: 'invalid' });
      const res = makeRes();
      await httpYourNewRoute(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', false);
   });
});
```

**Key points:**
- Test both success and error cases
- Test validation edge cases
- Use lightweight mocks for req/res
- Clean up mocks in `afterEach`
- Follow the existing test naming convention

### 8. Run Tests

Ensure all tests pass:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- your-route.integration.test.ts

# Run tests in watch mode
npm test -- --watch
```

### 9. Update Documentation

If your route adds significant functionality, consider updating:
- Module README (`src/modules/creators/README.md`)
- API inventory (`docs/api-inventory.md`)
- Any relevant architecture documentation

## Minimal Working Example

Here's a complete minimal example for a new read-only route `GET /api/v1/creators/featured` that returns featured creators.

### 1. Add Route Name Constant

`src/constants/creator-public-routes.constants.ts`:
```typescript
export const CREATOR_PUBLIC_ROUTE_NAMES = {
   LIST: 'creators:list',
   GET_PROFILE: 'creators:profile:get',
   UPSERT_PROFILE: 'creators:profile:upsert',
   GET_STATS: 'creators:stats:get',
   FEATURED: 'creators:featured',
} as const;
```

### 2. Add Cache Configuration

`src/constants/creator-public-cache.constants.ts`:
```typescript
export const CREATOR_PUBLIC_ROUTE_CACHE_PRESETS = {
   [CREATOR_PUBLIC_ROUTE_NAMES.LIST]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   [CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   [CREATOR_PUBLIC_ROUTE_NAMES.GET_PROFILE]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
   [CREATOR_PUBLIC_ROUTE_NAMES.FEATURED]: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
      staleIfError: 86400,
   },
} as const;
```

### 3. Add Schema

`src/modules/creators/creators.schemas.ts`:
```typescript
export const FeaturedCreatorsQuerySchema = z
  .object({
    limit: safeIntParam({
      defaultValue: 10,
      min: 1,
      max: 50,
      label: 'Limit',
    }),
  })
  .strict();

export type FeaturedCreatorsQueryType = z.infer<typeof FeaturedCreatorsQuerySchema>;
```

### 4. Add Controller

`src/modules/creators/creators.controllers.ts`:
```typescript
export const httpGetFeaturedCreators: AsyncController = async (req, res, next) => {
   try {
      const parsed = parsePublicQuery(
         FeaturedCreatorsQuerySchema,
         req.query,
         { debugContext: 'featured-creators-query' }
      );
      
      if (!parsed.ok) {
         return sendValidationError(res, 'Invalid query parameters', parsed.details);
      }
      
      const { limit } = parsed.data;

      // Placeholder: fetch featured creators from database
      const featuredCreators = await fetchFeaturedCreators(limit);

      attachTimestampHeader(res);
      sendSuccess(res, featuredCreators);
   } catch (error) {
      next(error);
   }
};
```

### 5. Register Route

`src/modules/creators/creators.routes.ts`:
```typescript
import { httpListCreators, httpGetCreatorStats, httpGetFeaturedCreators } from './creators.controllers';

/**
 * GET /api/v1/creators/featured
 *
 * Get a list of featured creators.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/featured',
   createCreatorReadMetricsMiddleware('featured'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.FEATURED]),
   httpGetFeaturedCreators
);
```

### 6. Add Tests

`src/modules/creators/featured-creators.integration.test.ts`:
```typescript
import { httpGetFeaturedCreators } from './creators.controllers';

function makeReq(query: Record<string, string> = {}): any {
   return { query };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   return res;
}

describe('GET /api/v1/creators/featured', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns 200 with default limit', async () => {
      const req = makeReq({});
      const res = makeRes();
      await httpGetFeaturedCreators(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
   });

   it('returns 200 with custom limit', async () => {
      const req = makeReq({ limit: '20' });
      const res = makeRes();
      await httpGetFeaturedCreators(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
   });
});
```

## Checklist

Before submitting your PR, ensure:

- [ ] Route name constant added to `creator-public-routes.constants.ts`
- [ ] Cache configuration added to `creator-public-cache.constants.ts`
- [ ] Query validation schema defined with `.strict()`
- [ ] Controller handler implements proper validation and error handling
- [ ] Route registered in module's `.routes.ts` file
- [ ] Middleware applied in correct order (metrics → cache → handler)
- [ ] Unit tests for schema validation
- [ ] Integration tests for the route
- [ ] All tests pass locally
- [ ] Documentation updated (if applicable)

## Common Patterns

### Pagination

For paginated endpoints, use the standard pagination schema:

```typescript
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

export const PaginatedQuerySchema = z.object({
   limit: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
   offset: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Offset',
   }),
}).strict();
```

### Filtering

For filtered endpoints, use boolean and include query helpers:

```typescript
import { creatorListSortDirectionQueryParam } from './creators.sort-direction.parse';
import { creatorListIncludeQueryParam } from './creators.include.parse';

export const FilteredQuerySchema = z.object({
   verified: safeBooleanQueryParam({ paramName: 'verified' }),
   search: z.string().optional(),
   sort: z.enum(['createdAt', 'name']).optional(),
   order: creatorListSortDirectionQueryParam(),
   include: creatorListIncludeQueryParam(),
}).strict();
```

### Path Parameters

For routes with path parameters (e.g., `/:creatorId`), validate in the controller:

```typescript
export const httpGetCreatorById: AsyncController = async (req, res, next) => {
   try {
      const { creatorId } = req.params;

      if (!creatorId || typeof creatorId !== 'string') {
         return sendValidationError(res, 'Invalid creator ID', [
            { field: 'creatorId', message: 'Creator ID must be a valid string' },
         ]);
      }

      // Rest of your logic
   } catch (error) {
      next(error);
   }
};
```

## Troubleshooting

### Route Not Accessible

- Verify the route is registered in the module's `.routes.ts` file
- Check that the module router is mounted in `src/modules/index.ts`
- Ensure the path matches the expected URL pattern

### Validation Errors

- Check that your schema uses `.strict()` to reject unknown parameters
- Verify you're using `parsePublicQuery` with the correct schema
- Ensure default values are properly configured

### Cache Issues

- Verify cache preset is defined in `creator-public-cache.constants.ts`
- Check that the route name constant matches between files
- Ensure `cacheControl` middleware is applied before the handler

### Test Failures

- Ensure mocks are properly cleaned up in `afterEach`
- Verify the test is using the correct controller import
- Check that test data matches schema validation rules

## Additional Resources

- [Creator Request Lifecycle](./creator-request-lifecycle.md)
- [Query Normalization Debug](./query-normalization-debug.md)
- [Error Code Registry](./ERROR_CODE_REGISTRY.md)
- [API Versioning](../api/api-versioning.md)
