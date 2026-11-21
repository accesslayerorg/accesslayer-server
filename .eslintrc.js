module.exports = {
   ignorePatterns: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'loadtest/*.js',
      'loadtest/lib/*.js',
   ],
   parser: '@typescript-eslint/parser',
   plugins: ['@typescript-eslint'],
   extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
   env: {
      node: true,
      es6: true,
   },
   rules: {
      // Disable base rule and use TypeScript version
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
         'error',
         {
            args: 'all',
            argsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            ignoreRestSiblings: true,
         },
      ],
   },
};
