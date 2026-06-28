import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const PAGE_SIZE = 20;
const TOTAL_HOLDERS = 50;

describe('GET /api/v1/creators/:id/holders pagination', () => {
   let creatorId: string;

   beforeAll(async () => {
      const user = await prisma.user.create({
         data: {
            id: 'holder-pag-test-user',
            email: 'holder-pag-test@example.com',
            passwordHash: 'dummy-hash',
            firstName: 'Holder',
            lastName: 'PagTest',
         }
      });

      const creator = await prisma.creatorProfile.create({
         data: {
            userId: user.id,
            handle: 'holder-pag-creator',
            displayName: 'Holder Pag Creator',
         }
      });
      creatorId = creator.id;

      await prisma.keyOwnership.createMany({
         data: Array.from({ length: TOTAL_HOLDERS }).map((_, i) => ({
            ownerAddress: `0xholder${String(i).padStart(6, '0')}`,
            creatorId: creator.id,
            balance: TOTAL_HOLDERS - i,
            createdAt: new Date(`2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
         }))
      });
   });

   afterAll(async () => {
      await prisma.keyOwnership.deleteMany({
         where: { creatorId }
      });
      await prisma.creatorProfile.delete({
         where: { id: creatorId }
      });
      await prisma.user.delete({
         where: { id: 'holder-pag-test-user' }
      });
      await prisma.$disconnect();
   });

   it('paginates correctly across multiple pages', async () => {
       const allPageItems: string[][] = [];
       let offset = 0;
       let hasMore = true;

       while (hasMore) {
          const res = await supertest(app)
             .get(`/api/v1/creators/${creatorId}/holders?limit=${PAGE_SIZE}&offset=${offset}`);

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);

          const items = res.body.data.items as Array<{ wallet_address: string }>;
          const meta = res.body.data.meta;

          allPageItems.push(items.map(i => i.wallet_address));
          hasMore = meta.hasMore;
          offset += items.length;
       }

       const seenAcrossAllPages = allPageItems.flat();

       const pageOneIds = allPageItems[0];
       const pageTwoIds = allPageItems[1];
       const pageThreeIds = allPageItems[2] ?? [];

       const overlapOneTwo = pageOneIds.filter((id: string) => pageTwoIds.includes(id));
       const overlapTwoThree = pageTwoIds.filter((id: string) => pageThreeIds.includes(id));
       const overlapOneThree = pageOneIds.filter((id: string) => pageThreeIds.includes(id));

       expect(overlapOneTwo).toHaveLength(0);
       expect(overlapTwoThree).toHaveLength(0);
       expect(overlapOneThree).toHaveLength(0);

       expect(seenAcrossAllPages).toHaveLength(TOTAL_HOLDERS);
       expect(new Set(seenAcrossAllPages).size).toBe(TOTAL_HOLDERS);
    });

   it('final page returns hasMore=false', async () => {
       const pages: number[] = [];
       let offset = 0;
       let hasMore = true;

       while (hasMore) {
          const res = await supertest(app)
             .get(`/api/v1/creators/${creatorId}/holders?limit=${PAGE_SIZE}&offset=${offset}`);

          expect(res.status).toBe(200);
          const meta = res.body.data.meta;
          hasMore = meta.hasMore;
          offset += PAGE_SIZE;
          pages.push(offset - 1);
       }

       const finalPage = pages.length - 1;
       const lastOffset = finalPage * PAGE_SIZE;
       
       const res = await supertest(app)
          .get(`/api/v1/creators/${creatorId}/holders?limit=${PAGE_SIZE}&offset=${lastOffset}`);

       expect(res.body.data.meta.hasMore).toBe(false);
    });
});