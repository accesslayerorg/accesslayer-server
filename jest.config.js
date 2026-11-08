const { createDefaultPreset } = require('ts-jest');

const tsJestTransformCfg = createDefaultPreset({
   diagnostics: { warnOnly: true },
   tsconfig: '<rootDir>/tsconfig.jest.json',
}).transform;

/** @type {import("jest").Config} **/
module.exports = {
   testEnvironment: 'node',
   transform: {
      ...tsJestTransformCfg,
   },
   maxWorkers: 2,
   workerIdleMemoryLimit: '512MB',
   moduleNameMapper: {
      '^chalk$': '<rootDir>/src/__mocks__/chalk.ts',
   },
   roots: ['<rootDir>/src'],
   setupFiles: ['./jest.setup.ts'],
   setupFilesAfterEnv: ['<rootDir>/jest.integration.setup.ts'],
   testEnvironmentOptions: {
      // Jest 30 soft-deletes globals between test files, which recursively
      // rewrites accessors on long-lived objects (e.g. EventEmitter
      // `_eventsCount`) and blows the stack with
      // "RangeError: Maximum call stack size exceeded" when the whole suite
      // runs in a single process (--runInBand in CI). Cleanup is disabled so
      // a leaked global cannot crash the runner.
      globalsCleanup: 'off',
   },
};
