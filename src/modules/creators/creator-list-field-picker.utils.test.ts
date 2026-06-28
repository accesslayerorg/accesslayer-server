import { CreatorListItem } from './creator-list-item.mapper';
import {
   CREATOR_LIST_PUBLIC_FIELDS,
   CreatorListPublicField,
   isCreatorListPublicField,
   pickCreatorListFields,
} from './creator-list-field-picker.utils';

const sampleItem: CreatorListItem = {
   id: 'creator-1',
   name: 'Alice',
   avatar: 'https://example.com/avatar.png',
   followers: 42,
   createdAt: '2024-01-01T00:00:00.000Z',
   updatedAt: '2024-06-01T00:00:00.000Z',
   currentPrice: '1000',
   price24hAgo: '900',
   priceChange24h: 11.11,
};

describe('CREATOR_LIST_PUBLIC_FIELDS', () => {
   it('contains all expected public fields', () => {
      const expected: CreatorListPublicField[] = [
         'id',
         'name',
         'avatar',
         'followers',
         'createdAt',
         'updatedAt',
         'currentPrice',
         'price24hAgo',
         'priceChange24h',
      ];
      for (const field of expected) {
         expect(CREATOR_LIST_PUBLIC_FIELDS).toContain(field);
      }
   });
});

describe('isCreatorListPublicField()', () => {
   it('returns true for known public fields', () => {
      expect(isCreatorListPublicField('id')).toBe(true);
      expect(isCreatorListPublicField('name')).toBe(true);
      expect(isCreatorListPublicField('priceChange24h')).toBe(true);
   });

   it('returns false for unknown or internal fields', () => {
      expect(isCreatorListPublicField('secret')).toBe(false);
      expect(isCreatorListPublicField('')).toBe(false);
      expect(isCreatorListPublicField('isVerified')).toBe(false);
   });
});

describe('pickCreatorListFields()', () => {
   it('returns all public fields when no fields arg is provided', () => {
      const picked = pickCreatorListFields(sampleItem);
      for (const field of CREATOR_LIST_PUBLIC_FIELDS) {
         expect(picked).toHaveProperty(field);
      }
      expect(Object.keys(picked)).toHaveLength(CREATOR_LIST_PUBLIC_FIELDS.length);
   });

   it('returns only the requested subset', () => {
      const subset: readonly CreatorListPublicField[] = ['id', 'name'];
      const picked = pickCreatorListFields(sampleItem, subset);
      expect(Object.keys(picked)).toHaveLength(2);
      expect(picked.id).toBe('creator-1');
      expect(picked.name).toBe('Alice');
   });

   it('preserves null values for nullable fields', () => {
      const nullItem: CreatorListItem = {
         ...sampleItem,
         currentPrice: null,
         price24hAgo: null,
         priceChange24h: null,
      };
      const picked = pickCreatorListFields(nullItem, ['currentPrice', 'price24hAgo', 'priceChange24h']);
      expect(picked.currentPrice).toBeNull();
      expect(picked.price24hAgo).toBeNull();
      expect(picked.priceChange24h).toBeNull();
   });

   it('preserves exact field values', () => {
      const picked = pickCreatorListFields(sampleItem, ['followers', 'priceChange24h']);
      expect(picked.followers).toBe(42);
      expect(picked.priceChange24h).toBe(11.11);
   });
});
