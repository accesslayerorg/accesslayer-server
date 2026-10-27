// Runs after each test file finishes (setupFilesAfterEnv).
//
// Files that call `jest.unmock('@prisma/client')` get a real PrismaClient
// with a live connection pool. Without an explicit disconnect those sockets
// outlive the test file's module registry and accumulate across the
// --runInBand run until Postgres refuses new connections. This hook closes
// the client's pool after every file. For files still on the Prisma mock it
// is a harmless call to the mock's `$disconnect`.
const testPath = expect.getState().testPath ?? '';
const normalizedTestPath = testPath.replace(/\\/g, '/');
const isIntegrationTest =
   normalizedTestPath.includes('/integration/') ||
   normalizedTestPath.endsWith('.integration.test.ts');

if (isIntegrationTest) {
   jest.unmock('@prisma/client');

   afterAll(async () => {
      const { prisma } = await import('./src/utils/prisma.utils');
      if (!prisma) {
         return;
      }

      if (typeof prisma.$disconnect === 'function') {
         await prisma.$disconnect();
      }
   });
}
