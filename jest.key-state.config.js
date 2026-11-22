const base = require('./jest.config');

module.exports = {
   ...base,
   testMatch: [
      "<rootDir>/src/middlewares/sanctioned-address.middleware.test.ts",
      "<rootDir>/src/workers/order-keeper.worker.test.ts",
      "<rootDir>/src/modules/keys/key-holder-balance-invalidation.test.ts",
      "<rootDir>/src/modules/airdrops/airdrop.integration.test.ts",
      "<rootDir>/src/modules/airdrops/airdrop.routes.test.ts",
      "<rootDir>/src/modules/airdrops/airdrop.schemas.test.ts",
      "<rootDir>/src/modules/airdrops/airdrop.service.test.ts",
      "<rootDir>/src/modules/airdrops/merkle.service.test.ts",
      "<rootDir>/src/modules/concentration/concentration.service.test.ts",
      "<rootDir>/src/modules/indexer/airdrop-indexer.service.test.ts",
      "<rootDir>/src/modules/indexer/marketplace-indexer.service.test.ts",
      "<rootDir>/src/modules/indexer/scheduled-transfer-indexer.service.test.ts",
      "<rootDir>/src/modules/marketplaces/marketplace-concentration.integration.test.ts",
      "<rootDir>/src/modules/marketplaces/marketplace.service.test.ts",
      "<rootDir>/src/modules/scheduled-transfers/scheduled-transfer-ledger.service.test.ts",
      "<rootDir>/src/modules/scheduled-transfers/scheduled-transfer.integration.test.ts",
      "<rootDir>/src/modules/scheduled-transfers/scheduled-transfer.routes.test.ts",
      "<rootDir>/src/modules/scheduled-transfers/scheduled-transfer.service.test.ts"
   ],
   collectCoverage: true,
   collectCoverageFrom: [
      "src/modules/airdrops/airdrop.routes.ts",
      "src/modules/airdrops/airdrop.schemas.ts",
      "src/modules/airdrops/airdrop.service.ts",
      "src/modules/airdrops/merkle.service.ts",
      "src/modules/concentration/concentration.routes.ts",
      "src/modules/concentration/concentration.service.ts",
      "src/modules/indexer/airdrop-indexer.service.ts",
      "src/modules/indexer/marketplace-indexer.service.ts",
      "src/modules/indexer/scheduled-transfer-indexer.service.ts",
      "src/modules/marketplaces/marketplace.routes.ts",
      "src/modules/marketplaces/marketplace.service.ts",
      "src/modules/marketplaces/royalty-enforcement.routes.ts",
      "src/modules/scheduled-transfers/scheduled-transfer-ledger.service.ts",
      "src/modules/scheduled-transfers/scheduled-transfer.routes.ts",
      "src/modules/scheduled-transfers/scheduled-transfer.schemas.ts",
      "src/modules/scheduled-transfers/scheduled-transfer.service.ts"
   ],
   coverageReporters: ['text', 'json-summary'],
   coverageThreshold: {
      global: { lines: 80, statements: 80 },
   },
};
