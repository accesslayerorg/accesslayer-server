// src/modules/creator/creator.controller.ts
import { RequestHandler } from 'express';

// API response helpers
import {
  sendSuccess,
  sendError,
  sendValidationError,
  ErrorCode,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { getPaginatedCreators } from './creator.service';
import { parseCreatorSortOptions } from './creator.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { wrapPublicCreatorListResponse } from '../creators/public-creator-list-envelope.utils';
import { buildCreatorListRequestContext } from '../creators/creator-list-context.utils';
import { normalizeCreatorListPage } from './creator-list-page.guard';

// Legacy query schema
import { LegacyCreatorQuerySchema } from '../creators/creators.schemas';

const ALLOWED_CREATOR_SELECT_FIELDS = [
  'id',
  'handle',
  'displayName',
  'bio',
  'avatarUrl',
  'bannerUrl',
  'isVerified',
  'keysSupply',
  'floorPrice',
  'createdAt',
  'updatedAt',
] as const;

type AllowedCreatorSelectField = (typeof ALLOWED_CREATOR_SELECT_FIELDS)[number];

function parseSelectFields(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function getInvalidSelectFields(fields: string[]): string[] {
  return fields.filter(
    (field) =>
      !ALLOWED_CREATOR_SELECT_FIELDS.includes(field as AllowedCreatorSelectField)
  );
}

function pickFields<T extends Record<string, unknown>>(
  item: T,
  fields: string[]
): Partial<T> {
  if (!fields.length) {
    return item;
  }

  return Object.fromEntries(
    Object.entries(item).filter(([key]) => fields.includes(key))
  ) as Partial<T>;
}

// Typed Express handler
export const listCreators: RequestHandler = async (req, res) => {
  try {
    // Build request context
    const ctx = buildCreatorListRequestContext(req);

    // Parse query using legacy schema
    const parsed = parsePublicQuery(LegacyCreatorQuerySchema, ctx.query);

    if (!parsed.ok) {
      return sendValidationError(res, 'Invalid query parameters', parsed.details);
    }

    const selectedFields = parseSelectFields(ctx.query['select-fields']);
    const invalidFields = getInvalidSelectFields(selectedFields);

    if (invalidFields.length > 0) {
      return sendValidationError(res, 'Invalid query parameters', [
        {
          field: 'select-fields',
          message: `Invalid select-fields: ${invalidFields.join(', ')}`,
        },
      ]);
    }

    // Destructure using schema fields
    const { offset, limit, sort, order: sortOrder } = parsed.data;

    // Convert offset to page number
    const page = normalizeCreatorListPage(offset);

    // Build sort options
    const sortOptions = parseCreatorSortOptions(sort, sortOrder);

    // Fetch paginated creators
    const { creators, meta } = await getPaginatedCreators({
      page,
      limit,
      sort: sortOptions,
    });

    const response = wrapPublicCreatorListResponse(creators, meta);
    attachTimestampHeader(res);
    const filteredItems = Array.isArray(response.items)
      ? response.items.map((item) =>
          pickFields(item as Record<string, unknown>, selectedFields)
        )
      : response.items;

    return sendSuccess(
      res,
      {
        ...response,
        items: filteredItems,
      },
      200,
      'Creators retrieved successfully'
    );
  } catch (error) {
    console.error('Error listing creators:', error);
    return sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve creators');
  }
};
