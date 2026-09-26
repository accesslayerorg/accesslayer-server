/**
 * body-size-limit.middleware resolves its per-group overrides from envConfig
 * once, at module load — matching how envConfig itself is a one-time
 * envSchema.parse(process.env) snapshot. Each test that needs a different
 * envConfig shape therefore mocks '../config' and re-imports the module
 * under test fresh via jest.resetModules(), rather than mutating envConfig
 * after the fact (which the real module never observes, by design).
 */
function loadWithEnvConfig(envConfig: {
   BODY_SIZE_LIMIT_DEFAULT: string;
   BODY_SIZE_LIMIT_AUTH?: string;
   BODY_SIZE_LIMIT_ADMIN?: string;
   BODY_SIZE_LIMIT_CREATORS?: string;
}) {
   jest.resetModules();
   jest.doMock('../config', () => ({ envConfig }));

   return require('./body-size-limit.middleware') as typeof import('./body-size-limit.middleware');
}

describe('getBodySizeLimit', () => {
   afterEach(() => {
      jest.dontMock('../config');
   });

   it('returns BODY_SIZE_LIMIT_DEFAULT for the "default" group', () => {
      const { getBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
      });
      expect(getBodySizeLimit('default')).toBe('10mb');
   });

   it('falls back to the default for a group with no override configured', () => {
      const { getBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
      });
      expect(getBodySizeLimit('auth')).toBe('10mb');
      expect(getBodySizeLimit('admin')).toBe('10mb');
      expect(getBodySizeLimit('creators')).toBe('10mb');
   });

   it('uses the group-specific override when configured', () => {
      const { getBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
         BODY_SIZE_LIMIT_AUTH: '100kb',
      });

      expect(getBodySizeLimit('auth')).toBe('100kb');
      // Unrelated groups are unaffected.
      expect(getBodySizeLimit('admin')).toBe('10mb');
   });

   it('supports a distinct override per group simultaneously', () => {
      const { getBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
         BODY_SIZE_LIMIT_AUTH: '100kb',
         BODY_SIZE_LIMIT_ADMIN: '20mb',
      });

      expect(getBodySizeLimit('auth')).toBe('100kb');
      expect(getBodySizeLimit('admin')).toBe('20mb');
      // creators has no override in this config, still falls back.
      expect(getBodySizeLimit('creators')).toBe('10mb');
   });

   it('reflects a non-default BODY_SIZE_LIMIT_DEFAULT for groups with no override', () => {
      const { getBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '5mb',
      });

      expect(getBodySizeLimit('default')).toBe('5mb');
      expect(getBodySizeLimit('admin')).toBe('5mb');
   });
});

describe('routeBodySizeLimit', () => {
   afterEach(() => {
      jest.dontMock('../config');
   });

   it('returns an express.json middleware function', () => {
      const { routeBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
      });
      const middleware = routeBodySizeLimit('default');
      expect(typeof middleware).toBe('function');
      // express.json() returns a function with this arity: (req, res, next)
      expect(middleware.length).toBe(3);
   });

   it('produces a distinct middleware instance per call (no shared limit state)', () => {
      const { routeBodySizeLimit } = loadWithEnvConfig({
         BODY_SIZE_LIMIT_DEFAULT: '10mb',
         BODY_SIZE_LIMIT_AUTH: '100kb',
         BODY_SIZE_LIMIT_ADMIN: '20mb',
      });
      const first = routeBodySizeLimit('auth');
      const second = routeBodySizeLimit('admin');
      expect(first).not.toBe(second);
   });
});
