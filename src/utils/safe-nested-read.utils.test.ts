// src/utils/safe-nested-read.utils.test.ts
// Unit tests for safe nested field reading helpers

import { safeNestedRead, safeRead } from './safe-nested-read.utils';

describe('safeNestedRead', () => {
   it('returns the field value when present', () => {
      const obj = { profile: { social: { twitter: '@user' } } };
      const result = safeNestedRead(
         obj,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('@user');
   });

   it('returns the default value when the field is null', () => {
      const obj = { profile: { social: { twitter: null } } };
      const result = safeNestedRead(
         obj,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('N/A');
   });

   it('returns the default value when the field is undefined', () => {
      const obj = { profile: { social: {} } };
      const result = safeNestedRead(
         obj,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('N/A');
   });

   it('returns the default value when an intermediate path is null', () => {
      const obj = { profile: null };
      const result = safeNestedRead(
         obj,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('N/A');
   });

   it('returns the default value when the object is null', () => {
      const result = safeNestedRead(
         null,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('N/A');
   });

   it('returns the default value when the object is undefined', () => {
      const result = safeNestedRead(
         undefined,
         ['profile', 'social', 'twitter'],
         'N/A'
      );
      expect(result).toBe('N/A');
   });

   it('returns the default value when the path is empty', () => {
      const obj = { profile: { social: { twitter: '@user' } } };
      const result = safeNestedRead(obj, [], 'N/A');
      expect(result).toBe('N/A');
   });

   it('handles numeric default values', () => {
      const obj = { stats: { followers: null } };
      const result = safeNestedRead(obj, ['stats', 'followers'], 0);
      expect(result).toBe(0);
   });

   it('handles boolean default values', () => {
      const obj = { settings: { enabled: undefined } };
      const result = safeNestedRead(obj, ['settings', 'enabled'], false);
      expect(result).toBe(false);
   });

   it('handles array default values', () => {
      const obj = { data: { items: null } };
      const result = safeNestedRead(obj, ['data', 'items'], []);
      expect(result).toEqual([]);
   });

   it('returns the field value when it is 0', () => {
      const obj = { stats: { count: 0 } };
      const result = safeNestedRead(obj, ['stats', 'count'], -1);
      expect(result).toBe(0);
   });

   it('returns the field value when it is false', () => {
      const obj = { settings: { enabled: false } };
      const result = safeNestedRead(obj, ['settings', 'enabled'], true);
      expect(result).toBe(false);
   });

   it('returns the field value when it is an empty string', () => {
      const obj = { profile: { bio: '' } };
      const result = safeNestedRead(obj, ['profile', 'bio'], 'No bio');
      expect(result).toBe('');
   });
});

describe('safeRead', () => {
   it('returns the field value when present', () => {
      const obj = { displayName: 'Alice' };
      const result = safeRead(obj, 'displayName', 'Unknown');
      expect(result).toBe('Alice');
   });

   it('returns the default value when the field is null', () => {
      const obj = { bio: null };
      const result = safeRead(obj, 'bio', 'No bio');
      expect(result).toBe('No bio');
   });

   it('returns the default value when the field is undefined', () => {
      const obj = { displayName: 'Alice' };
      const result = safeRead(obj, 'avatarUrl', 'default.png');
      expect(result).toBe('default.png');
   });

   it('returns the default value when the object is null', () => {
      const result = safeRead(null, 'displayName', 'Unknown');
      expect(result).toBe('Unknown');
   });

   it('returns the default value when the object is undefined', () => {
      const result = safeRead(undefined, 'displayName', 'Unknown');
      expect(result).toBe('Unknown');
   });

   it('handles numeric values', () => {
      const obj = { count: 42 };
      const result = safeRead(obj, 'count', 0);
      expect(result).toBe(42);
   });

   it('handles boolean values', () => {
      const obj = { isVerified: true };
      const result = safeRead(obj, 'isVerified', false);
      expect(result).toBe(true);
   });
});
