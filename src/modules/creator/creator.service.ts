import { CreatorSortOptions, toPrismaOrderBy } from './creator.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { CREATOR_LIST_DEFAULT_SELECT } from '../../constants/creator-list-projection.constants';

export interface GetCreatorsParams {
   page: number;
   limit: number;
   sort: CreatorSortOptions;
}

export async function getPaginatedCreators(params: GetCreatorsParams) {
   const { page, limit, sort } = params;
   const skip = (page - 1) * limit;

   const [creators, totalCount] = await Promise.all([
      prisma.creatorProfile.findMany({
         skip,
         take: limit,
         orderBy: toPrismaOrderBy(sort),
         select: CREATOR_LIST_DEFAULT_SELECT,
      }),
      prisma.creatorProfile.count(),
   ]);

   const totalPages = Math.ceil(totalCount / limit);

   const meta: PaginationMetadata = {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
   };

   return { creators, meta };
}
