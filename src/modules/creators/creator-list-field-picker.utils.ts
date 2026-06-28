import { CreatorListItem } from './creator-list-item.mapper';

export const CREATOR_LIST_PUBLIC_FIELDS = [
   'id',
   'name',
   'avatar',
   'followers',
   'createdAt',
   'updatedAt',
   'currentPrice',
   'price24hAgo',
   'priceChange24h',
] as const;

export type CreatorListPublicField = (typeof CREATOR_LIST_PUBLIC_FIELDS)[number];

/**
 * Returns true if `field` is a recognised creator list public field.
 */
export function isCreatorListPublicField(field: string): field is CreatorListPublicField {
   return (CREATOR_LIST_PUBLIC_FIELDS as readonly string[]).includes(field);
}

/**
 * Picks only the allowed public fields from a creator list item.
 *
 * Provide a subset via `fields` to return a partial shape; omit it to get
 * all public fields. Only keys declared in `CREATOR_LIST_PUBLIC_FIELDS`
 * are ever returned, so internal fields cannot leak into public responses.
 *
 * @param item - A mapped creator list item
 * @param fields - Which fields to include; defaults to all public fields
 * @returns An object containing only the requested fields
 *
 * @example
 * pickCreatorListFields(item, ['id', 'name']);
 * // => { id: '...', name: '...' }
 */
export function pickCreatorListFields(
   item: CreatorListItem,
   fields: readonly CreatorListPublicField[] = CREATOR_LIST_PUBLIC_FIELDS,
): Pick<CreatorListItem, CreatorListPublicField> {
   const result = {} as Pick<CreatorListItem, CreatorListPublicField>;
   for (const field of fields) {
      (result as Record<string, unknown>)[field] = item[field];
   }
   return result;
}
