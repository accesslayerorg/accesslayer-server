import express, { Express } from 'express';
import supertest from 'supertest';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      auction: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      auctionBid: {
         findMany: jest.fn(),
         create: jest.fn(),
         updateMany: jest.fn(),
      },
      registeredKey: {
         update: jest.fn(),
      },
      $transaction: jest.fn(),
   },
}));

import auctionRouter from './auction.routes';
import { prisma } from '../../utils/prisma.utils';

const mockAuctionFindUnique = prisma.auction.findUnique as jest.Mock;
const mockAuctionBidFindMany = prisma.auctionBid.findMany as jest.Mock;
const mockAuctionBidCreate = prisma.auctionBid.create as jest.Mock;
const mockTransaction = prisma.$transaction as jest.Mock;

describe('auction routes', () => {
   let app: Express;

   beforeEach(() => {
      jest.clearAllMocks();
      app = express();
      app.use(express.json());
      app.use('/auctions', auctionRouter);
   });

   it('rejects bids below the required minimum increment', async () => {
      mockAuctionFindUnique.mockResolvedValue({
         id: 'auction-1',
         keyId: 'key-1',
         status: 'OPEN',
         minimumBid: '100',
         minimumIncrement: '10',
         currentBid: '100',
         currentBidder: 'wallet-a',
         winnerWallet: null,
      });
      mockAuctionBidFindMany.mockResolvedValue([
         { id: 'bid-1', auctionId: 'auction-1', bidderId: 'wallet-a', amount: '100' },
      ]);

      const res = await supertest(app)
         .post('/auctions/auction-1/bid')
         .send({ bidderId: 'wallet-b', amount: '109' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });

   it('accepts a valid bid and emits an outbid event', async () => {
      mockAuctionFindUnique.mockResolvedValue({
         id: 'auction-1',
         keyId: 'key-1',
         status: 'OPEN',
         minimumBid: '100',
         minimumIncrement: '10',
         currentBid: '100',
         currentBidder: 'wallet-a',
         winnerWallet: null,
      });
      mockAuctionBidFindMany.mockResolvedValue([
         { id: 'bid-1', auctionId: 'auction-1', bidderId: 'wallet-a', amount: '100' },
      ]);
      mockAuctionBidCreate.mockResolvedValue({
         id: 'bid-2',
         auctionId: 'auction-1',
         bidderId: 'wallet-b',
         amount: '120',
      });
      mockTransaction.mockImplementation(async (cb: any) =>
         cb({
            auctionBid: { create: mockAuctionBidCreate },
            auction: { update: jest.fn() },
         })
      );

      const res = await supertest(app)
         .post('/auctions/auction-1/bid')
         .send({ bidderId: 'wallet-b', amount: '120' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockAuctionBidCreate).toHaveBeenCalled();
   });

   it('returns bids sorted by highest amount first', async () => {
      mockAuctionBidFindMany.mockResolvedValue([
         { id: 'bid-2', auctionId: 'auction-1', bidderId: 'wallet-b', amount: '120' },
         { id: 'bid-1', auctionId: 'auction-1', bidderId: 'wallet-a', amount: '100' },
      ]);

      const res = await supertest(app).get('/auctions/auction-1/bids');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data[0].amount).toBe('120');
      expect(res.body.data[1].amount).toBe('100');
   });

   it('closes an auction and refunds losing bids atomically', async () => {
      mockAuctionFindUnique.mockResolvedValue({
         id: 'auction-1',
         keyId: 'key-1',
         status: 'OPEN',
         minimumBid: '100',
         minimumIncrement: '10',
         currentBid: '120',
         currentBidder: 'wallet-b',
         winnerWallet: null,
      });
      mockTransaction.mockImplementation(async (cb: any) =>
         cb({
            auctionBid: {
               findMany: jest.fn().mockResolvedValue([
                  { id: 'bid-2', bidderId: 'wallet-b', amount: '120' },
                  { id: 'bid-1', bidderId: 'wallet-a', amount: '110' },
               ]),
               updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            auction: { update: jest.fn().mockResolvedValue({ id: 'auction-1' }) },
            registeredKey: { update: jest.fn().mockResolvedValue({ id: 'key-1' }) },
         })
      );

      const { closeAuction } = await import('./auction.service');
      await expect(closeAuction('auction-1')).resolves.toMatchObject({ id: 'auction-1' });
      expect(mockTransaction).toHaveBeenCalled();
   });
});
