// Test environment stub — sets all required env vars before any module loads.
// Values are non-functional placeholders sufficient for schema validation.

process.env.MODE ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.GMAIL_USER ??= 'test@example.com';
process.env.GMAIL_APP_PASSWORD ??= 'test-password';
process.env.GOOGLE_CLIENT_ID ??= 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-client-secret';
process.env.BACKEND_URL ??= 'http://localhost:3000';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
process.env.CLOUDINARY_CLOUD_NAME ??= 'test-cloud';
process.env.CLOUDINARY_API_KEY ??= 'test-api-key';
process.env.CLOUDINARY_API_SECRET ??= 'test-api-secret';
process.env.PAYSTACK_SECRET_KEY ??= 'test-paystack-secret';
process.env.APP_SECRET ??= 'accesslayer_test_secret_key_32_bytes_long_xxxx';
process.env.DB_QUERY_TIMEOUT_MS = '30000';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'accesslayer_test_jwt_secret_key_32_bytes_long_xx';
process.env.JWT_EXPIRES_IN = '1h';
process.env.SSE_HEARTBEAT_INTERVAL_MS = '100';
process.env.SSE_QUEUE_CAPACITY = '10';
process.env.SSE_QUEUE_FULL_TIMEOUT_MS = '2000';
process.env.SSE_THROTTLE_DURATION_MS = '5000';
process.env.SSE_MAX_CONNECTIONS_PER_WALLET = '2';
process.env.SSE_MAX_SUBSCRIPTIONS_PER_WALLET = '5';
process.env.SSE_SUBSCRIPTION_TTL_MS = '86400000';
process.env.SSE_REPLAY_MAX_EVENTS = '1000';
process.env.SSE_PRUNE_INTERVAL_MS = '300000';

jest.mock('@prisma/client', () => {
   const modelMocks: Record<string, any> = {};
   let auditLogsStore: any[] = [];

   const getModelMock = (modelName: string) => {
      if (modelName === 'auditLog') {
         if (!modelMocks.auditLog) {
            modelMocks.auditLog = {
               create: jest.fn().mockImplementation(async (args: any) => {
                  const entry = {
                     id: 'audit-' + Math.random().toString(36).substring(2, 9),
                     actorWallet: args?.data?.actorWallet || '',
                     actionType: args?.data?.actionType || '',
                     targetId: args?.data?.targetId ?? null,
                     payload: args?.data?.payload ?? null,
                     createdAt: args?.data?.createdAt ? new Date(args.data.createdAt) : new Date(),
                  };
                  auditLogsStore.push(entry);
                  return entry;
               }),
               findMany: jest.fn().mockImplementation(async (args?: any) => {
                  let results = [...auditLogsStore];
                  if (args?.where?.actionType) {
                     results = results.filter((r) => r.actionType === args.where.actionType);
                  }
                  if (args?.where?.createdAt) {
                     const { gte, lte } = args.where.createdAt;
                     if (gte) results = results.filter((r) => new Date(r.createdAt) >= new Date(gte));
                     if (lte) results = results.filter((r) => new Date(r.createdAt) <= new Date(lte));
                  }
                  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                  if (args?.cursor?.id) {
                     const idx = results.findIndex((r) => r.id === args.cursor.id);
                     if (idx !== -1) {
                        const skip = args.skip ?? 0;
                        results = results.slice(idx + skip);
                     }
                  }
                  if (args?.take) {
                     results = results.slice(0, args.take);
                  }
                  return results;
               }),
               findFirst: jest.fn().mockImplementation(async (args?: any) => {
                  let results = [...auditLogsStore];
                  if (args?.where?.actionType) {
                     results = results.filter((r) => r.actionType === args.where.actionType);
                  }
                  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                  return results[0] ?? null;
               }),
               deleteMany: jest.fn().mockImplementation(async (_args?: any) => {
                  const count = auditLogsStore.length;
                  auditLogsStore.length = 0;
                  return { count };
               }),
               count: jest.fn().mockImplementation(async () => auditLogsStore.length),
            };
         }
         return modelMocks.auditLog;
      }

      if (!modelMocks[modelName]) {
         modelMocks[modelName] = {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(null),
            findUniqueOrThrow: jest.fn().mockResolvedValue({}),
            create: jest.fn().mockImplementation(async (args: any) => ({ id: 'mock-id', ...args?.data })),
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            delete: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            count: jest.fn().mockResolvedValue(0),
            aggregate: jest.fn().mockResolvedValue({}),
            groupBy: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockImplementation(async (args: any) => ({ id: 'mock-id', ...args?.create })),
         };
      }
      return modelMocks[modelName];
   };

   const createProxyClient = (): any => {
      const baseObj: any = {
         $disconnect: jest.fn().mockResolvedValue(undefined),
         $connect: jest.fn().mockResolvedValue(undefined),
         $transaction: jest.fn().mockImplementation(async (cbOrArr: any) => {
            if (typeof cbOrArr === 'function') {
               return cbOrArr(mockPrismaClient);
            }
            return Promise.all(cbOrArr);
         }),
         $extends: jest.fn(() => mockPrismaClient),
      };

      return new Proxy(baseObj, {
         get(target: any, prop: string) {
            if (prop in target) return target[prop];
            if (typeof prop === 'string' && !prop.startsWith('$')) {
               return getModelMock(prop);
            }
            return undefined;
         },
      });
   };

   const mockPrismaClient = createProxyClient();

   return {
      PrismaClient: jest.fn(() => mockPrismaClient),
   };
}, { virtual: true });

jest.setTimeout(30000);
