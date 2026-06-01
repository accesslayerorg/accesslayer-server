import { generateSlug, generateSlugWithSuffix, resolveSlugCollision } from '../slug.utils';

describe('slug.utils', () => {
   describe('generateSlug', () => {
      it('should convert to lowercase', () => {
         expect(generateSlug('John Doe')).toBe('john-doe');
      });

      it('should replace spaces and underscores with hyphens', () => {
         expect(generateSlug('hello world_test')).toBe('hello-world-test');
      });

      it('should collapse consecutive hyphens', () => {
         expect(generateSlug('hello---world')).toBe('hello-world');
      });

      it('should trim leading and trailing hyphens', () => {
         expect(generateSlug('--hello-world--')).toBe('hello-world');
      });

      it('should strip non-alphanumeric characters', () => {
         expect(generateSlug('café & créme!')).toBe('caf-crme');
      });

      it('should handle empty or whitespace input', () => {
         expect(generateSlug('')).toBe('');
         expect(generateSlug('   ')).toBe('');
      });
   });

   describe('generateSlugWithSuffix', () => {
      it('should append suffix if greater than 0', () => {
         expect(generateSlugWithSuffix('John Doe', 2)).toBe('john-doe-2');
      });

      it('should not append suffix if 0 or less', () => {
         expect(generateSlugWithSuffix('John Doe', 0)).toBe('john-doe');
         expect(generateSlugWithSuffix('John Doe', -1)).toBe('john-doe');
      });
   });

   describe('resolveSlugCollision', () => {
      it('should return base slug if it is unique', async () => {
         const isUnique = jest.fn().mockResolvedValue(true);
         const result = await resolveSlugCollision('John Doe', isUnique);
         expect(result).toBe('john-doe');
         expect(isUnique).toHaveBeenCalledWith('john-doe');
         expect(isUnique).toHaveBeenCalledTimes(1);
      });

      it('should append incremental suffixes until unique', async () => {
         const isUnique = jest
            .fn()
            .mockResolvedValueOnce(false) // john-doe taken
            .mockResolvedValueOnce(false) // john-doe-1 taken
            .mockResolvedValueOnce(true); // john-doe-2 available

         const result = await resolveSlugCollision('John Doe', isUnique);
         expect(result).toBe('john-doe-2');
         expect(isUnique).toHaveBeenCalledWith('john-doe');
         expect(isUnique).toHaveBeenCalledWith('john-doe-1');
         expect(isUnique).toHaveBeenCalledWith('john-doe-2');
         expect(isUnique).toHaveBeenCalledTimes(3);
      });

      it('should throw error if limit is reached', async () => {
         const isUnique = jest.fn().mockResolvedValue(false);
         await expect(resolveSlugCollision('John Doe', isUnique)).rejects.toThrow(
            'Failed to resolve slug collision for "John Doe" after 1000 attempts.'
         );
      });
   });
});
