/** @type {import("jest").Config} **/
module.exports = {
   testEnvironment: 'node',
   transform: {
      // sanitize-html (src/lib/sanitize.ts) depends on the ESM-only
      // htmlparser2 12 family; compile just those packages to CommonJS.
      '/node_modules/.+\\.js$': [
         'ts-jest',
         {
            diagnostics: false,
            tsconfig: { allowJs: true, module: 'commonjs', isolatedModules: true },
         },
      ],
      '^.+\\.[tj]sx?$': [
         'ts-jest',
         {
            diagnostics: { warnOnly: true },
            tsconfig: '<rootDir>/tsconfig.jest.json',
         },
      ],
   },
   transformIgnorePatterns: [
      '/node_modules/(?!(\\.pnpm/[^/]+/node_modules/)?(htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
   ],
   maxWorkers: 2,
   workerIdleMemoryLimit: '512MB',
   moduleNameMapper: {
      '^chalk$': '<rootDir>/src/__mocks__/chalk.ts',
      '^k6/crypto$': '<rootDir>/loadtest/__mocks__/k6-crypto.ts',
      '^k6/encoding$': '<rootDir>/loadtest/__mocks__/k6-encoding.ts',
   },
   roots: ['<rootDir>/src', '<rootDir>/loadtest'],
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
