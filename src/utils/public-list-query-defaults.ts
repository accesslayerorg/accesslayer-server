import {
   DEFAULT_OFFSET,
   DEFAULT_PAGE,
   DEFAULT_PAGE_SIZE,
} from '../constants/pagination.constants';

/**
 * Shared default query values for offset-based public list endpoints.
 * Keeps defaults centralized without introducing validation behavior.
 */
export const PUBLIC_OFFSET_PAGINATION_DEFAULTS = {
   limit: DEFAULT_PAGE_SIZE,
   offset: DEFAULT_OFFSET,
} as const;

/**
 * Shared default query values for page-based public list endpoints.
 * Keeps defaults centralized without introducing validation behavior.
 */
export const PUBLIC_PAGE_PAGINATION_DEFAULTS = {
   page: DEFAULT_PAGE,
   limit: DEFAULT_PAGE_SIZE,
} as const;
