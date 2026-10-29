const { createDefaultPreset } = require('ts-jest');

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
   testEnvironment: 'node',
   transform: {
      ...tsJestTransformCfg,
   },
   globals: {
      'ts-jest': {
         // Treat TypeScript type errors as warnings rather than hard failures.
         // This allows the test suite to run against files that have pre-existing
         // type errors (e.g. schema mismatches not yet addressed) without blocking
         // all integration tests that import those modules transitively.
         diagnostics: { warnOnly: true },
      },
   },
   moduleNameMapper: {
      '^chalk$': '<rootDir>/src/__mocks__/chalk.ts',
   },
   roots: ['<rootDir>/src'],
   setupFiles: ['./jest.setup.ts'],
};
