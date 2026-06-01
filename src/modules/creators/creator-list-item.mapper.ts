import { CreatorProfile } from '../../types/profile.types';
import { requestContextStorage } from '../../utils/als.utils';
import { formatIsoTimestamp } from '../../utils/iso-timestamp.utils';
import { logger } from '../../utils/logger.utils';
import { safeRead } from '../../utils/safe-nested-read.utils';

/**
 * Locked output shape for creator list items.
 * Keep this minimal and explicit to avoid leaking internal fields.
 */
export type CreatorListItem = {
   id: string;
   name: string | null;
   avatar: string | null;
   followers: number;
   createdAt: string;
   updatedAt: string;
};

type ExpectedFieldType = 'string' | 'boolean' | 'number' | 'Date';

// Runtime type expectations for fields projected by CREATOR_LIST_DEFAULT_SELECT.
// A mismatch here signals a DB migration changed a column type without updating the mapping.
const CREATOR_LIST_FIELD_EXPECTED_TYPES: Record<string, ExpectedFieldType> = {
   id: 'string',
   handle: 'string',
   displayName: 'string',
   avatarUrl: 'string',
   isVerified: 'boolean',
   createdAt: 'Date',
   updatedAt: 'Date',
};

function logIfFieldTypeMismatch(
   creator: CreatorProfile,
   fieldName: keyof typeof CREATOR_LIST_FIELD_EXPECTED_TYPES
): void {
   const value = (creator as unknown as Record<string, unknown>)[fieldName];

   if (value === null || value === undefined) return;

   const expectedType = CREATOR_LIST_FIELD_EXPECTED_TYPES[fieldName];
   const typeMatches =
      expectedType === 'Date' ? value instanceof Date : typeof value === expectedType;

   if (!typeMatches) {
      logger.error({
         msg: 'Creator list field type mismatch',
         fieldName,
         expectedType,
         receivedType: value instanceof Date ? 'Date' : typeof value,
         creatorId: creator.id,
         requestId: requestContextStorage.getStore()?.requestId ?? null,
      });
   }
}

function warnIfUnexpectedNullCreatorField(
   creator: CreatorProfile,
   fieldName: 'displayName'
): void {
   const rawCreator = creator as CreatorProfile & Record<string, unknown>;

   if (rawCreator[fieldName] !== null) {
      return;
   }

   logger.warn({
      msg: 'Unexpected null creator field in database result',
      fieldName,
      creatorId: creator.id,
      requestId: requestContextStorage.getStore()?.requestId ?? null,
   });
}

/**
 * Pure, dumb mapper from a full `CreatorProfile` to a `CreatorListItem`.
 * No filtering, no business logic — deterministic and predictable.
 */
export const mapCreatorListItem = (
   creator: CreatorProfile
): CreatorListItem => {
   warnIfUnexpectedNullCreatorField(creator, 'displayName');

   logIfFieldTypeMismatch(creator, 'id');
   logIfFieldTypeMismatch(creator, 'handle');
   logIfFieldTypeMismatch(creator, 'displayName');
   logIfFieldTypeMismatch(creator, 'avatarUrl');
   logIfFieldTypeMismatch(creator, 'isVerified');
   logIfFieldTypeMismatch(creator, 'createdAt');
   logIfFieldTypeMismatch(creator, 'updatedAt');

   return {
      id: creator.id,
      name: safeRead(creator, 'displayName', null),
      avatar: safeRead(creator, 'avatarUrl', null),
      followers: 0,
      createdAt: formatIsoTimestamp(creator.createdAt),
      updatedAt: formatIsoTimestamp(creator.updatedAt),
   };
};
