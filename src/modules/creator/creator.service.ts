import { CreatorSortOptions, toPrismaOrderBy } from './creator.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';

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
         include: {
            user: {
               select: {
                  avatar: true,
                  firstName: true,
                  lastName: true,
               },
            },
         },
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
