// src/modules/creators/creator-feed-filter-combinator.utils.ts
// Centralises creator-feed WHERE clause composition so feed handlers don't duplicate combinator logic.

import { CreatorFilterInput } from './creators.filter';
import { normalizeCreatorListSearchTerm } from './creators.search-term.utils';

export type CreatorFeedWhere = {
  isVerified?: boolean;
  OR?: Array<{
    handle?: { contains: string; mode: 'insensitive' };
    displayName?: { contains: string; mode: 'insensitive' };
  }>;
};

/**
 * Composes a Prisma `where` clause for creator feed queries from a parsed filter input.
 *
 * Keeps filter semantics identical to the creator list endpoint while giving
 * feed handlers a single call-site instead of inline combinator branches.
 *
 * @param filters - Parsed creator filter input (verified, search)
 * @returns A Prisma-compatible where object ready for `prisma.creatorProfile.findMany`
 *
 * @example
 * const where = buildCreatorFeedWhere({ verified: true, search: 'jazz' });
 * // => { isVerified: true, OR: [{ handle: ... }, { displayName: ... }] }
 *
 * @example
 * const where = buildCreatorFeedWhere({});
 * // => {}
 */
export function buildCreatorFeedWhere(filters: CreatorFilterInput): CreatorFeedWhere {
  const where: CreatorFeedWhere = {};

  if (filters.verified !== undefined) {
    where.isVerified = filters.verified;
  }

  const normalizedSearch = normalizeCreatorListSearchTerm(filters.search);
  if (normalizedSearch) {
    where.OR = [
      { handle: { contains: normalizedSearch, mode: 'insensitive' } },
      { displayName: { contains: normalizedSearch, mode: 'insensitive' } },
    ];
  }

  return where;
}
