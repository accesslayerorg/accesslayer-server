import { Prisma } from '@prisma/client';
import { prisma } from '../src/utils/prisma.utils';

const TARGET_KEYS = 10000;
const TARGET_TRADES = 100000;
const KEY_CHUNK_SIZE = 1000;
const TRADE_CHUNK_SIZE = 5000;

export const SEED_WALLET_ADDRESS =
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
export const SEED_USER_ID = 'seed-loadtest-user-id';
export const SEED_KEY_PREFIX = 'seed-key-';
export const SEED_TRADE_PREFIX = 'seed-trade-';

/**
 * Idempotently seeds 10,000 keys and 100,000 trades.
 * Safe to run repeatedly.
 */
export async function seedLoadTestData(): Promise<void> {
   console.log('--- Starting load test data seeding ---');

   // Check existing seeded rows
   const existingKeys = await prisma.creatorProfile.count({
      where: { id: { startsWith: SEED_KEY_PREFIX } },
   });
   const existingTrades = await prisma.trade.count({
      where: { id: { startsWith: SEED_TRADE_PREFIX } },
   });

   console.log(
      `Current status: ${existingKeys}/${TARGET_KEYS} keys, ${existingTrades}/${TARGET_TRADES} trades.`
   );

   if (existingKeys >= TARGET_KEYS && existingTrades >= TARGET_TRADES) {
      console.log(
         'Database is already fully seeded. Skipping insertion (idempotent no-op).'
      );
      return;
   }

   // 1. Ensure seed user and StellarWallet exist
   console.log('Upserting seed user and Stellar wallet...');
   await prisma.user.upsert({
      where: { id: SEED_USER_ID },
      update: {},
      create: {
         id: SEED_USER_ID,
         email: 'seed-loadtest@accesslayer.io',
         passwordHash: 'seed-dummy-password-hash',
         firstName: 'LoadTest',
         lastName: 'SeedUser',
      },
   });

   await prisma.stellarWallet.upsert({
      where: { address: SEED_WALLET_ADDRESS },
      update: { userId: SEED_USER_ID },
      create: {
         address: SEED_WALLET_ADDRESS,
         userId: SEED_USER_ID,
      },
   });

   // 2. Seed Keys up to 10,000
   if (existingKeys < TARGET_KEYS) {
      console.log(`Seeding keys (${existingKeys} -> ${TARGET_KEYS})...`);
      for (let i = existingKeys; i < TARGET_KEYS; i += KEY_CHUNK_SIZE) {
         const chunkSize = Math.min(KEY_CHUNK_SIZE, TARGET_KEYS - i);
         const keysChunk = [];

         for (let j = 0; j < chunkSize; j++) {
            const index = i + j;
            const paddedIndex = String(index).padStart(5, '0');
            keysChunk.push({
               id: `${SEED_KEY_PREFIX}${paddedIndex}`,
               userId: SEED_USER_ID,
               handle: `creator_seed_${paddedIndex}`,
               displayName: `Seed Creator ${paddedIndex}`,
               circulatingSupply: new Prisma.Decimal(100),
               status: 'Active',
               isVerified: index % 5 === 0,
               tradingPaused: false,
               followersCount: (index * 7) % 500,
            });
         }

         await prisma.creatorProfile.createMany({
            data: keysChunk,
            skipDuplicates: true,
         });

         console.log(`Seeded keys: ${i + chunkSize}/${TARGET_KEYS}`);
      }
   }

   // 3. Seed Holdings for the test wallet across the first 100 keys
   console.log('Seeding holdings for test wallet...');
   const holdingsChunk = [];
   for (let k = 0; k < 100; k++) {
      const padded = String(k).padStart(5, '0');
      holdingsChunk.push({
         ownerAddress: SEED_WALLET_ADDRESS,
         creatorId: `${SEED_KEY_PREFIX}${padded}`,
         balance: new Prisma.Decimal(10),
         costBasis: new Prisma.Decimal(15),
         realisedPnl: new Prisma.Decimal(0),
         lastBuyAt: new Date(),
      });
   }
   await prisma.keyOwnership.createMany({
      data: holdingsChunk,
      skipDuplicates: true,
   });

   // 4. Seed Trades up to 100,000
   if (existingTrades < TARGET_TRADES) {
      console.log(`Seeding trades (${existingTrades} -> ${TARGET_TRADES})...`);
      const now = Date.now();

      for (let i = existingTrades; i < TARGET_TRADES; i += TRADE_CHUNK_SIZE) {
         const chunkSize = Math.min(TRADE_CHUNK_SIZE, TARGET_TRADES - i);
         const tradesChunk = [];

         for (let j = 0; j < chunkSize; j++) {
            const index = i + j;
            const paddedIndex = String(index).padStart(6, '0');
            const keyIndex = String(index % TARGET_KEYS).padStart(5, '0');

            tradesChunk.push({
               id: `${SEED_TRADE_PREFIX}${paddedIndex}`,
               buyer: SEED_WALLET_ADDRESS,
               creatorId: `${SEED_KEY_PREFIX}${keyIndex}`,
               quantity: '1',
               price: ((index % 100) + 1).toFixed(2),
               ledger: 1000000 + Math.floor(index / 10),
               txHash: `0xseedtx${paddedIndex}${String(index).padStart(20, '0')}`,
               timestamp: new Date(now - (TARGET_TRADES - index) * 1000),
               paymentAsset: 'XLM',
               type: 'single',
            });
         }

         await prisma.trade.createMany({
            data: tradesChunk,
            skipDuplicates: true,
         });

         console.log(`Seeded trades: ${i + chunkSize}/${TARGET_TRADES}`);
      }
   }

   const finalKeys = await prisma.creatorProfile.count({
      where: { id: { startsWith: SEED_KEY_PREFIX } },
   });
   const finalTrades = await prisma.trade.count({
      where: { id: { startsWith: SEED_TRADE_PREFIX } },
   });

   console.log(
      `--- Seeding completed: ${finalKeys} keys, ${finalTrades} trades in database ---`
   );
}

// Direct invocation handler
if (require.main === module) {
   seedLoadTestData()
      .then(async () => {
         await prisma.$disconnect();
         process.exit(0);
      })
      .catch(async error => {
         console.error('Failed to seed load test data:', error);
         await prisma.$disconnect();
         process.exit(1);
      });
}
