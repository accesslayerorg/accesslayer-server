// src/modules/indexer/buy-flow.integration.test.ts
//
// Integration test for the server-side "buy" flow against a real database.
//
// This codebase has no HTTP buy endpoint, JWT challenge/verify auth, or
// server-side bonding-curve/Stellar-submission code — bonding curve pricing
// and transaction submission happen on-chain / client-side. The
// `processTradeEvents` pipeline below is the closest real analog to a "buy
// flow": it is what actually turns a confirmed on-chain KEY_BOUGHT trade
// event (which already carries the bonding-curve-computed price at the
// supply it traded at) into the server's read models — an Activity record,
// the KeyOwnership balance, and the CreatorPriceSnapshot. These tests verify
// that persistence contract end-to-end against a real Postgres instance
// (see docker-compose.yml — `pnpm db:up`), not against mocked Prisma calls.
//
// Mapped acceptance criteria from the original "buy flow" ask:
// - Golden path buy persists the trade at the price carried by the event
//   (the price a bonding-curve computation would have produced on-chain)
// - Ownership record created in DB with the correct wallet and creator ID
// - A malformed/unprocessable event does not create a partial ownership
//   record (closest analog to "failed submission creates no ownership row";
//   there is no Stellar submission or 502 status at this layer)
// - Duplicate buy with the same transaction hash is idempotent
// - Not testable here: "unauthenticated request returns 401" — there is no
//   HTTP endpoint in front of this pipeline to authenticate against.

import { prisma } from '../../utils/prisma.utils';
import { processTradeEvents } from './indexer-pipeline.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const USER_ID = 'buy-flow-test-user-1';
const HANDLE = 'buy-flow-test-creator-1';
const BUYER_WALLET = 'GABUYER00000000000000000000000000000000000000000000000';
const OTHER_BUYER_WALLET =
   'GBSECONDBUYER0000000000000000000000000000000000000000';

describe('buy flow — processTradeEvents against a real database', () => {
   let creatorId: string;

   beforeAll(async () => {
      await prisma.user.upsert({
         where: { id: USER_ID },
         create: {
            id: USER_ID,
            email: 'buy-flow-test@example.test',
            passwordHash: 'dummy-hash',
            firstName: 'Buy',
            lastName: 'Flow',
         },
         update: {},
      });

      const creator = await prisma.creatorProfile.upsert({
         where: { userId: USER_ID },
         create: {
            userId: USER_ID,
            handle: HANDLE,
            displayName: 'Buy Flow Creator',
         },
         update: {},
      });

      creatorId = creator.id;

      // Seed a known "supply level" — represented here by an existing price
      // snapshot, standing in for the bonding curve's current state before
      // the trade under test is processed.
      await prisma.creatorPriceSnapshot.upsert({
         where: { creatorId },
         create: {
            creatorId,
            currentPrice: BigInt(1_000_000),
            price24hAgo: BigInt(1_000_000),
         },
         update: {
            currentPrice: BigInt(1_000_000),
            price24hAgo: BigInt(1_000_000),
         },
      });
   });

   afterAll(async () => {
      await prisma.activity.deleteMany({ where: { creatorId } });
      await prisma.keyOwnership.deleteMany({ where: { creatorId } });
      await prisma.creatorPriceSnapshot.deleteMany({ where: { creatorId } });
      await prisma.creatorProfile.deleteMany({ where: { handle: HANDLE } });
      await prisma.user.deleteMany({ where: { id: USER_ID } });
      await prisma.$disconnect();
   });

   afterEach(async () => {
      await prisma.activity.deleteMany({ where: { creatorId } });
      await prisma.keyOwnership.deleteMany({ where: { creatorId } });
   });

   it('golden path: persists the trade price and creates the ownership record for the buyer', async () => {
      const tradeAt = new Date('2026-01-01T00:00:00.000Z');
      const event: IndexerChainEvent = {
         txHash: '0xbuy-golden-path',
         eventIndex: 0,
         eventType: 'KEY_BOUGHT',
         ledger: 5000,
         creatorId,
         actor: BUYER_WALLET,
         amount: 10,
         price: BigInt(1_050_000),
         feePaid: BigInt(5_000),
         tradeAt: tradeAt.toISOString(),
      };

      await processTradeEvents([event]);

      // The persisted price is exactly the price carried by the trade event
      // — i.e. whatever the bonding curve computed on-chain at that supply.
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
      });
      expect(snapshot?.currentPrice).toBe(BigInt(1_050_000));

      const activity = await prisma.activity.findFirst({
         where: { creatorId, actor: BUYER_WALLET },
      });
      expect(activity).not.toBeNull();
      expect(activity?.type).toBe('KEY_BOUGHT');
      expect((activity?.payload as any).price_at_trade).toBe('1050000');

      const ownership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: BUYER_WALLET },
      });
      expect(ownership).not.toBeNull();
      expect(ownership?.ownerAddress).toBe(BUYER_WALLET);
      expect(ownership?.creatorId).toBe(creatorId);
      expect(Number(ownership?.balance)).toBe(10);
   });

   it('accumulates balance across sequential buys by the same wallet', async () => {
      const firstBuy: IndexerChainEvent = {
         txHash: '0xbuy-sequential-1',
         eventIndex: 0,
         eventType: 'KEY_BOUGHT',
         ledger: 5001,
         creatorId,
         actor: BUYER_WALLET,
         amount: 4,
         price: BigInt(1_060_000),
         feePaid: BigInt(1_000),
         tradeAt: '2026-01-01T00:01:00.000Z',
      };
      const secondBuy: IndexerChainEvent = {
         ...firstBuy,
         txHash: '0xbuy-sequential-2',
         amount: 6,
         price: BigInt(1_080_000),
         tradeAt: '2026-01-01T00:02:00.000Z',
      };

      await processTradeEvents([firstBuy]);
      await processTradeEvents([secondBuy]);

      const ownership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: BUYER_WALLET },
      });
      expect(Number(ownership?.balance)).toBe(10);

      // The price snapshot reflects the most recent trade.
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
      });
      expect(snapshot?.currentPrice).toBe(BigInt(1_080_000));
   });

   it('tracks separate ownership rows per buyer wallet for the same creator', async () => {
      const buyByFirstWallet: IndexerChainEvent = {
         txHash: '0xbuy-multi-wallet-1',
         eventIndex: 0,
         eventType: 'KEY_BOUGHT',
         ledger: 5002,
         creatorId,
         actor: BUYER_WALLET,
         amount: 3,
         price: BigInt(1_000_000),
         feePaid: BigInt(500),
         tradeAt: '2026-01-01T00:03:00.000Z',
      };
      const buyBySecondWallet: IndexerChainEvent = {
         ...buyByFirstWallet,
         txHash: '0xbuy-multi-wallet-2',
         actor: OTHER_BUYER_WALLET,
         amount: 7,
      };

      await processTradeEvents([buyByFirstWallet, buyBySecondWallet]);

      const firstOwnership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: BUYER_WALLET },
      });
      const secondOwnership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: OTHER_BUYER_WALLET },
      });

      expect(Number(firstOwnership?.balance)).toBe(3);
      expect(Number(secondOwnership?.balance)).toBe(7);
   });

   it('duplicate buy with the same transaction hash is idempotent', async () => {
      const event: IndexerChainEvent = {
         txHash: '0xbuy-duplicate',
         eventIndex: 0,
         eventType: 'KEY_BOUGHT',
         ledger: 5003,
         creatorId,
         actor: BUYER_WALLET,
         amount: 5,
         price: BigInt(1_100_000),
         feePaid: BigInt(2_000),
         tradeAt: '2026-01-01T00:04:00.000Z',
      };

      // Same event delivered twice in one batch — as would happen with an
      // overlapping indexer ingestion window replaying the same tx hash.
      await processTradeEvents([event, event]);

      const activities = await prisma.activity.findMany({
         where: { creatorId, actor: BUYER_WALLET },
      });
      expect(activities).toHaveLength(1);

      const ownership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: BUYER_WALLET },
      });
      expect(Number(ownership?.balance)).toBe(5);
   });

   it('a malformed buy event creates no ownership record and no activity', async () => {
      const malformedEvent = {
         txHash: '0xbuy-malformed',
         eventIndex: 0,
         eventType: 'KEY_BOUGHT',
         ledger: 5004,
         // creatorId is missing — this is the closest analog available at
         // this layer to a failed/unprocessable submission: the pipeline
         // must not leave a partial ownership record behind.
         actor: BUYER_WALLET,
         amount: 99,
         price: BigInt(1_000_000),
         feePaid: BigInt(0),
         tradeAt: '2026-01-01T00:05:00.000Z',
      } as unknown as IndexerChainEvent;

      await processTradeEvents([malformedEvent]);

      const ownership = await prisma.keyOwnership.findFirst({
         where: { creatorId, ownerAddress: BUYER_WALLET },
      });
      expect(ownership).toBeNull();

      const activity = await prisma.activity.findFirst({
         where: { actor: BUYER_WALLET, creatorId: null },
      });
      expect(activity).toBeNull();
   });
});
