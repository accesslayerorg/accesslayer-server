/**
 * ## Optional fields in public creator responses (null vs absent)
 *
 * Success bodies are sent with Express `res.json()`. In JSON output:
 *
 * - **`null`** — the key is present and the value is JSON `null`.
 * - **Absent** — the key is omitted when the JavaScript value is `undefined`
 *   (standard `JSON.stringify` behavior).
 *
 * Clients should treat **`null` and absent differently** only where documented below;
 * elsewhere, assume the key is always present when listed.
 *
 * ### Creator list (`GET /api/v1/creators`)
 *
 * Items use {@link CreatorListItem} from `creator-list-item.mapper.ts`
 * (`serializeCreatorList` → `mapCreatorListItem`).
 *
 * | Field | When empty / unknown |
 * |-------|----------------------|
 * | `id`, `followers`, `createdAt`, `updatedAt` | Always present (`followers` is a number, currently `0`; timestamps use ISO 8601 UTC strings). |
 * | `name`, `avatar` | **Always present**; use JSON **`null`** when display name or avatar URL is missing (`?? null` in the mapper). |
 *
 * List envelope (`items`, `meta`) always includes both keys. Offset `meta` always
 * includes `limit`, `offset`, `total`, and `hasMore`.
 *
 * **Deviations**
 *
 * - **Cursor list `meta.nextCursor`**: JSON **`null`** when there is no next page
 *   (`serializeCreatorListCursorMeta`), not omitted.
 * - **`CreatorSummary` / `serializeCreatorSummary`**: not used by the active list
 *   route today; if reused, `avatarUrl` would be **omitted** when `undefined`
 *   (optional property), unlike `CreatorListItem.avatar` which uses **`null`**.
 *
 * ### Creator detail (`GET /api/v1/creators/:creatorId/profile`)
 *
 * Shape: `CreatorProfileReadResponse` in `creator-profile.schemas.ts`,
 * built by `getCreatorProfile` in `creator-profile.service.ts`.
 *
 * | Field | When empty / unknown |
 * |-------|----------------------|
 * | `creatorId`, `metadata` | Always present. |
 * | `createdAt`, `updatedAt` | Always present; ISO 8601 UTC strings for database records, JSON **`null`** for placeholder responses. |
 * | `displayName`, `bio`, `avatarUrl` | **Always present**; JSON **`null`** when unset (Zod `.nullable()`; placeholder fallback uses explicit `null`). |
 * | `links` | **Always present** as an array; use **`[]`** when there are no links (never `null`, never omitted). |
 * | `perks` | **Always present** as an array in current handlers (`[]` when none). The read schema marks `perks` optional, but the service always includes the key. |
 *
 * When adding new optional creator response fields, pick one strategy deliberately:
 * nullable keys for “known empty”, omitted keys only when the field is truly
 * inapplicable, and empty arrays for “none yet” collections.
 */

import { CreatorProfile } from '../../types/profile.types';
import type { CursorPaginationMeta } from '../../types/cursor.types';
import type { OffsetPaginationMeta } from '../../utils/pagination.utils';
import {
   type PublicCreatorListEnvelope,
   wrapPublicCreatorListResponse,
} from './public-creator-list-envelope.utils';
import {
   CreatorListItem,
   mapCreatorListItem,
} from './creator-list-item.mapper';
import { safeRead } from '../../utils/safe-nested-read.utils';

/**
 * Creator summary shape for list responses.
 *
 * Keeps full profile fields out of the list serializer to reduce payload size.
 * Only includes essential information needed for creator listings.
 */
export interface CreatorSummary {
   id: string;
   handle: string;
   displayName: string;
   avatarUrl?: string;
   isVerified: boolean;
}

/**
 * Serializes a full CreatorProfile into a CreatorSummary for list responses.
 *
 * Centralizes list serialization logic and keeps it reusable across endpoints.
 *
 * @param profile - Full creator profile from database
 * @returns Creator summary suitable for list responses
 *
 * @example
 * const summary = serializeCreatorSummary(creatorProfile);
 * // Returns: { id, handle, displayName, avatarUrl, isVerified }
 */
export function serializeCreatorSummary(
   profile: CreatorProfile
): CreatorSummary {
   return {
      id: profile.id,
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl: safeRead(profile, 'avatarUrl', undefined),
      isVerified: profile.isVerified,
   };
}

/**
 * Normalizes a potentially-null or undefined profile list to a safe empty array.
 * Guards serialization against edge cases where the data layer returns null.
 *
 * @param profiles - Raw profiles array that may be null or undefined
 * @returns A guaranteed non-null array
 */
export function normalizeCreatorListItems(
   profiles: CreatorProfile[] | null | undefined
): CreatorProfile[] {
   return profiles ?? [];
}

/**
 * Serializes multiple creator profiles for list responses.
 * Accepts null/undefined and coerces it to an empty array before mapping,
 * so the items field in the response envelope is always an array.
 *
 * @param profiles - Array of full creator profiles (null/undefined treated as empty)
 * @returns Array of creator list items
 */
export function serializeCreatorList(
   profiles: CreatorProfile[] | null | undefined
): CreatorListItem[] {
   return normalizeCreatorListItems(profiles).map(mapCreatorListItem);
}

/**
 * Serializes cursor pagination metadata for creator list responses.
 *
 * Keeps cursor metadata shaping in one place so cursor-aware routes can
 * return a consistent public response body without rebuilding metadata inline.
 *
 * @param meta - Raw cursor pagination metadata
 * @returns Cursor pagination metadata normalized for public list responses
 */
export function serializeCreatorListCursorMeta(
   meta: CursorPaginationMeta
): CursorPaginationMeta {
   return {
      nextCursor: meta.nextCursor ?? null,
      hasMore: Boolean(meta.hasMore),
   };
}

/**
 * Serializes offset pagination metadata for creator list responses.
 *
 * Ensures consistency of metadata shape across offset-paginated endpoints.
 *
 * @param meta - Raw offset pagination metadata
 * @returns Offset pagination metadata normalized for public list responses
 */
export function serializeCreatorListOffsetMeta(
   meta: OffsetPaginationMeta
): OffsetPaginationMeta {
   return {
      limit: meta.limit,
      offset: meta.offset,
      total: meta.total,
      hasMore: meta.hasMore,
   };
}

/**
 * Paginated creator list response body (offset pagination metadata).
 */
export type CreatorListResponse = PublicCreatorListEnvelope<
   CreatorListItem,
   OffsetPaginationMeta
>;

/**
 * Cursor-aware creator list response body.
 */
export type CreatorCursorListResponse = PublicCreatorListEnvelope<
   CreatorListItem,
   CursorPaginationMeta
>;

/**
 * Serializes a standard offset-paginated creator list response.
 *
 * This centralizes the wrapping of creators and metadata to ensure
 * a consistent public response shape (envelope).
 */
export function serializeCreatorListResponse(
   profiles: CreatorProfile[],
   meta: OffsetPaginationMeta
): CreatorListResponse {
   return wrapPublicCreatorListResponse(
      serializeCreatorList(profiles),
      serializeCreatorListOffsetMeta(meta)
   );
}

/**
 * Serializes a cursor-aware creator list response.
 *
 * This keeps cursor metadata and creator summary shaping out of route handlers
 * while reusing the existing public list envelope shape.
 */
export function serializeCursorAwareCreatorListResponse(
   profiles: CreatorProfile[],
   meta: CursorPaginationMeta
): CreatorCursorListResponse {
   return wrapPublicCreatorListResponse(
      serializeCreatorList(profiles),
      serializeCreatorListCursorMeta(meta)
   );
}
