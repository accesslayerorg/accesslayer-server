# Creator List Projection Constants

## Overview

This document describes the centralized default field projection constants for creator list reads, implemented to eliminate duplication and improve maintainability.

## Problem

Previously, creator list queries had duplicated or missing field projections:

- `src/modules/creators/creators.utils.ts` - No `select` clause (fetched all fields)
- `src/modules/creator/creator.service.ts` - Had an `include` clause with user relation

This led to:

- Inconsistent data fetching across endpoints
- Potential performance issues from over-fetching
- Maintenance burden when field requirements change

## Solution

Created a centralized constant `CREATOR_LIST_DEFAULT_SELECT` in `src/constants/creator-list-projection.constants.ts` that defines the minimal fields needed for creator list responses:

```typescript
export const CREATOR_LIST_DEFAULT_SELECT = {
   id: true,
   handle: true,
   displayName: true,
   avatarUrl: true,
   isVerified: true,
} as const;
```

## Benefits

1. **Single Source of Truth**: All creator list queries use the same field projection
2. **Performance**: Only fetches necessary fields, reducing database load and network payload
3. **Maintainability**: Changes to required fields only need to be made in one place
4. **Type Safety**: TypeScript ensures consistent usage across the codebase
5. **Consistency**: All creator list endpoints return the same data shape

## Files Modified

### Created

- `src/constants/creator-list-projection.constants.ts` - New constant definition

### Updated

- `src/modules/creators/creators.utils.ts` - Added `select` clause using the constant
- `src/modules/creator/creator.service.ts` - Replaced `include` with `select` using the constant
- `src/modules/creator/creator.service.test.ts` - Updated test expectations and mock data

## Response Shape

The response shape remains unchanged. The serializers (`creator-list-item.mapper.ts` and `creators.serializers.ts`) continue to work as before, mapping the selected fields to the public API response format.

## Usage Example

```typescript
import { CREATOR_LIST_DEFAULT_SELECT } from '../../constants/creator-list-projection.constants';

const creators = await prisma.creatorProfile.findMany({
   where: { isVerified: true },
   select: CREATOR_LIST_DEFAULT_SELECT,
});
```

## Testing

The test suite has been updated to verify that:

- The correct fields are selected in database queries
- Mock data matches the projection shape
- All existing functionality continues to work as expected

## Future Considerations

If additional fields are needed for creator list responses:

1. Add the field to `CREATOR_LIST_DEFAULT_SELECT`
2. Update the corresponding TypeScript types if needed
3. Update serializers if the field should be exposed in the API response
4. Run tests to ensure no regressions

## Related Constants

This follows the same pattern as:

- `CREATOR_DETAIL_DEFAULT_SELECT` in `src/constants/creator-detail-include.constants.ts`
