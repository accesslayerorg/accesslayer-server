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

const auditLogsStore: any[] = [];
let auditIdCounter = 1;

const mockAuditLog = {
   create: jest.fn().mockImplementation(async ({ data }: any) => {
      const item = {
         id: `audit_log_${auditIdCounter}`,
         actorWallet: data.actorWallet,
         actionType: data.actionType,
         targetEntity: data.targetEntity ?? null,
         targetId: data.targetId ?? null,
         payload: data.payload ?? null,
         createdAt: data.createdAt
            ? new Date(data.createdAt)
            : new Date(Date.now() + auditIdCounter),
      };
      auditIdCounter++;
      auditLogsStore.push(item);
      return item;
   }),
   findMany: jest.fn().mockImplementation(async (args?: any) => {
      let filtered = [...auditLogsStore];
      if (args?.where?.actionType) {
         filtered = filtered.filter(
            e => e.actionType === args.where.actionType
         );
      }
      if (args?.where?.createdAt?.gte) {
         filtered = filtered.filter(
            e =>
               e.createdAt.getTime() >=
               new Date(args.where.createdAt.gte).getTime()
         );
      }
      if (args?.where?.createdAt?.lte) {
         filtered = filtered.filter(
            e =>
               e.createdAt.getTime() <=
               new Date(args.where.createdAt.lte).getTime()
         );
      }
      // sort by createdAt desc, id desc
      filtered.sort((a, b) => {
         const diff = b.createdAt.getTime() - a.createdAt.getTime();
         if (diff !== 0) return diff;
         return b.id.localeCompare(a.id);
      });
      if (args?.cursor?.id) {
         const idx = filtered.findIndex(e => e.id === args.cursor.id);
         if (idx !== -1) {
            filtered = filtered.slice(idx + (args.skip || 0));
         }
      }
      if (args?.take) {
         filtered = filtered.slice(0, args.take);
      }
      return filtered;
   }),
   findFirst: jest.fn().mockImplementation(async (args?: any) => {
      const list = await mockAuditLog.findMany(args);
      return list[0] ?? null;
   }),
   deleteMany: jest.fn().mockImplementation(async () => {
      const count = auditLogsStore.length;
      auditLogsStore.length = 0;
      return { count };
   }),
};

jest.mock(
   '@prisma/client',
   () => {
      const mockPrismaClient = {
         creatorProfile: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
         },
         activity: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({}),
         },
         auditLog: mockAuditLog,
         $disconnect: jest.fn(),
         $extends: jest.fn(() => ({
            creatorProfile: {
               findMany: jest.fn().mockResolvedValue([]),
               findFirst: jest.fn().mockResolvedValue(null),
               findUnique: jest.fn().mockResolvedValue(null),
               update: jest.fn().mockResolvedValue({}),
            },
            activity: {
               findMany: jest.fn().mockResolvedValue([]),
               create: jest.fn().mockResolvedValue({}),
            },
            auditLog: mockAuditLog,
            $disconnect: jest.fn(),
         })),
      };

      return {
         PrismaClient: jest.fn(() => mockPrismaClient),
      };
   },
   { virtual: true }
);

jest.setTimeout(30000);
