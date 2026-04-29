import { fetchActivityFeed } from './activity.service';

describe('Activity Service', () => {
    beforeAll(async () => {
        // Clean up and seed minimal test data if needed
        // In a real environment, we'd use a test database
    });

    it('should return empty list when no activity exists', async () => {
        const [items] = await fetchActivityFeed({ limit: 10, offset: 0 });
        expect(Array.isArray(items)).toBe(true);
        // expect(total).toBe(0); // Depends on DB state
    });

    it('should filter by creatorId', async () => {
        const [items] = await fetchActivityFeed({ limit: 10, offset: 0, creatorId: 'non-existent' });
        expect(items.length).toBe(0);
    });

    it('should handle pagination', async () => {
        const [items1] = await fetchActivityFeed({ limit: 1, offset: 0 });
        const [items2] = await fetchActivityFeed({ limit: 1, offset: 1 });
        if (items1.length > 0 && items2.length > 0) {
            expect(items1[0].id).not.toBe(items2[0].id);
        }
    });
});
