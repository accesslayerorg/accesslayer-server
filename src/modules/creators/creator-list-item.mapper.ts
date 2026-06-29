import { CreatorProfile } from '../../types/profile.types';
import { requestContextStorage } from '../../utils/als.utils';
import { formatIsoTimestamp } from '../../utils/iso-timestamp.utils';
import { logger } from '../../utils/logger.utils';
import { safeRead } from '../../utils/safe-nested-read.utils';
import { compute24hPriceChange } from '../../utils/price.utils';

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
   /** Current key price in stroops. null when no trade has occurred. */
   currentPrice: string | null;
   /** Price 24 hours ago in stroops. null when no trade has occurred. */
   price24hAgo: string | null;
   /** Computed percentage change: ((current - 24h) / 24h) * 100. null when no baseline. */
   priceChange24h: number | null;
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

   const snapshot = safeRead(creator, 'priceSnapshot', null) as {
      currentPrice: bigint;
      price24hAgo: bigint;
      lastTradeAt: Date | null;
   } | null;
   const currentPrice = snapshot?.currentPrice ?? null;
   const price24hAgo = snapshot?.price24hAgo ?? null;

   let priceChange24h: number | null = null;
   if (currentPrice !== null && price24hAgo !== null) {
      priceChange24h = compute24hPriceChange(currentPrice, price24hAgo);
   }

   return {
      id: creator.id,
      name: safeRead(creator, 'displayName', null),
      avatar: safeRead(creator, 'avatarUrl', null),
      followers: 0,
      createdAt: formatIsoTimestamp(creator.createdAt),
      updatedAt: formatIsoTimestamp(creator.updatedAt),
      currentPrice: currentPrice !== null ? currentPrice.toString() : null,
      price24hAgo: price24hAgo !== null ? price24hAgo.toString() : null,
      priceChange24h,
   };
};
