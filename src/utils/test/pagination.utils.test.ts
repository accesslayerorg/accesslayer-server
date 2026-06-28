import { paginateQuery } from '../pagination.utils';

describe('paginateQuery', () => {
    const mockData = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Charlie' },
        { id: 4, name: 'David' },
        { id: 5, name: 'Eve' }
    ];

    const mockQueryFn = jest.fn().mockImplementation(async ({ take, skip, cursor }) => {
        let startIndex = 0;
        if (cursor) {
            startIndex = mockData.findIndex(item => item.id === cursor);
            if (startIndex === -1) return [];
        }
        if (skip) startIndex += skip;
        
        return mockData.slice(startIndex, startIndex + take);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('returns first page with no cursor', async () => {
        const result = await paginateQuery(mockQueryFn, { limit: 2 });
        
        expect(mockQueryFn).toHaveBeenCalledWith({ take: 3 });
        expect(result.data).toHaveLength(2);
        expect(result.data).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe(2);
    });

    it('returns subsequent page with cursor', async () => {
        const result = await paginateQuery(mockQueryFn, { cursor: 2, limit: 2 });
        
        expect(mockQueryFn).toHaveBeenCalledWith({ take: 3, skip: 1, cursor: 2 });
        expect(result.data).toHaveLength(2);
        expect(result.data).toEqual([{ id: 3, name: 'Charlie' }, { id: 4, name: 'David' }]);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe(4);
    });

    it('returns last page where hasMore is false', async () => {
        const result = await paginateQuery(mockQueryFn, { cursor: 4, limit: 2 });
        
        expect(mockQueryFn).toHaveBeenCalledWith({ take: 3, skip: 1, cursor: 4 });
        expect(result.data).toHaveLength(1);
        expect(result.data).toEqual([{ id: 5, name: 'Eve' }]);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeUndefined();
    });
});
