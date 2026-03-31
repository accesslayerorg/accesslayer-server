import { DEFAULT_PAGE_SIZE } from '../../constants/pagination.constants';

/**
 * Resolve list limit for public creator list endpoints.
 *
 * Returns the shared default page size when the incoming page size is omitted.
 */
export function resolveCreatorListLimit(pageSize?: number): number {
   return pageSize ?? DEFAULT_PAGE_SIZE;
}
