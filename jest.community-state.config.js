const base = require('./jest.config');

module.exports = {
   ...base,
   testMatch: [
      "<rootDir>/src/modules/campaigns/campaign-read.service.test.ts",
      "<rootDir>/src/modules/campaigns/campaign.routes.integration.test.ts",
      "<rootDir>/src/modules/governance/governance-delegation-voting-weight.service.test.ts",
      "<rootDir>/src/modules/governance/governance-tips.integration.test.ts",
      "<rootDir>/src/modules/governance/governance-voting-weight.service.test.ts",
      "<rootDir>/src/modules/indexer/campaign-indexer.service.test.ts",
      "<rootDir>/src/modules/indexer/tip-anonymity.service.test.ts",
      "<rootDir>/src/modules/pol/pol-indexer.service.test.ts",
      "<rootDir>/src/modules/pol/pol.integration.test.ts",
      "<rootDir>/src/modules/pol/pol.service.test.ts",
      "<rootDir>/src/modules/tips/tip-leaderboard.routes.test.ts",
      "<rootDir>/src/modules/tips/tip-leaderboard.service.test.ts",
      "<rootDir>/src/modules/tips/tips.service.test.ts"
   ],
   collectCoverage: true,
   collectCoverageFrom: [
      "src/modules/campaigns/campaign-read.service.ts",
      "src/modules/campaigns/campaigns.routes.ts",
      "src/modules/governance/governance-voting-weight.routes.ts",
      "src/modules/governance/governance-voting-weight.service.ts",
      "src/modules/indexer/campaign-indexer.service.ts",
      "src/modules/pol/pol-indexer.service.ts",
      "src/modules/pol/pol.routes.ts",
      "src/modules/pol/pol.service.ts",
      "src/modules/tips/tip-leaderboard.service.ts"
   ],
   coverageReporters: ['text', 'json-summary'],
   coverageThreshold: {
      global: { lines: 80, statements: 80 },
   },
};
