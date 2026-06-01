export type PaginationMeta = {
   page: number;
   pageSize: number;
   totalItems: number;
   totalPages: number;
   hasNextPage: boolean;
   hasPreviousPage: boolean;
};

export type PaginationMetaParams = {
   page: number;
   pageSize: number;
   totalItems: number;
};

export type OffsetPaginationMeta = {
   limit: number;
   offset: number;
   total: number;
   hasMore: boolean;
};

export type OffsetPaginationMetaParams = {
   limit: number;
   offset: number;
   total: number;
};

export const buildPaginationMeta = ({
   page,
   pageSize,
   totalItems,
}: PaginationMetaParams): PaginationMeta => {
   const safePageSize = Math.max(1, Math.floor(pageSize));
   const safeTotalItems = Math.max(0, Math.floor(totalItems));
   const totalPages = Math.ceil(safeTotalItems / safePageSize);
   const safePage =
      totalPages === 0
         ? 1
         : Math.min(totalPages, Math.max(1, Math.floor(page)));

   return {
      page: safePage,
      pageSize: safePageSize,
      totalItems: safeTotalItems,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPreviousPage: safePage > 1,
   };
};

export const buildOffsetPaginationMeta = ({
   limit,
   offset,
   total,
}: OffsetPaginationMetaParams): OffsetPaginationMeta => {
   const safeLimit = Math.max(1, Math.floor(limit));
   const safeOffset = Math.max(0, Math.floor(offset));
   const safeTotal = Math.max(0, Math.floor(total));

   return {
      limit: safeLimit,
      offset: safeOffset,
      total: safeTotal,
      hasMore: safeOffset + safeLimit < safeTotal,
   };
};
