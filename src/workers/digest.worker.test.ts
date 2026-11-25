// src/workers/digest.worker.test.ts
// Unit & Integration tests for DigestWorker (#1217).

const mockPreferences = new Map<string, any>();
const mockTrades: any[] = [];
const mockOrders: any[] = [];
const mockActivities: any[] = [];

const mockPrisma = {
   notificationPreference: {
      create: jest.fn(async ({ data }: any) => {
         const item = {
            id: `pref-${Date.now()}-${Math.random()}`,
            unsubscribedAt: null,
            lastDigestAt: null,
            claimToken: null,
            claimExpiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
         };
         mockPreferences.set(data.wallet, item);
         return item;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
         return mockPreferences.get(where.wallet) || null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
         const all = Array.from(mockPreferences.values());
         return all.filter(p => {
            if (where?.verifiedAt?.not === null && !p.verifiedAt) return false;
            if (where?.unsubscribedAt === null && p.unsubscribedAt) return false;
            return true;
         });
      }),
      update: jest.fn(async ({ where, data }: any) => {
         const existing = Array.from(mockPreferences.values()).find(
            p => p.id === where.id || p.wallet === where.wallet
         );
         if (!existing) throw new Error('Not found');
         const updated = { ...existing, ...data, updatedAt: new Date() };
         mockPreferences.set(existing.wallet, updated);
         return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
         let count = 0;
         for (const [key, p] of mockPreferences.entries()) {
            if (where.id && p.id !== where.id) continue;
            if (where.OR) {
               const matchesOr = where.OR.some((cond: any) => {
                  if (cond.claimExpiresAt === null && p.claimExpiresAt === null) return true;
                  if (cond.claimExpiresAt?.lt && p.claimExpiresAt && p.claimExpiresAt < cond.claimExpiresAt.lt) return true;
                  return false;
               });
               if (!matchesOr) continue;
            }
            mockPreferences.set(key, { ...p, ...data });
            count++;
         }
         return { count };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
         if (where?.wallet?.in) {
            for (const w of where.wallet.in) mockPreferences.delete(w);
         } else if (where?.wallet) {
            mockPreferences.delete(where.wallet);
         }
         return { count: 1 };
      }),
   },
   trade: {
      create: jest.fn(async ({ data }: any) => {
         const t = { id: `trade-${Date.now()}-${Math.random()}`, paymentAsset: 'XLM', ...data };
         mockTrades.push(t);
         return t;
      }),
      findMany: jest.fn(async ({ where }: any) => {
         return mockTrades.filter(t => {
            if (where.buyer && t.buyer !== where.buyer) return false;
            if (where.timestamp?.gte && t.timestamp < where.timestamp.gte) return false;
            if (where.timestamp?.lte && t.timestamp > where.timestamp.lte) return false;
            return true;
         });
      }),
      deleteMany: jest.fn(async () => {
         mockTrades.length = 0;
         return { count: 0 };
      }),
   },
   limitOrder: {
      create: jest.fn(async ({ data }: any) => {
         const o = { id: `order-${Date.now()}-${Math.random()}`, ...data };
         mockOrders.push(o);
         return o;
      }),
      findMany: jest.fn(async ({ where }: any) => {
         return mockOrders.filter(o => {
            if (where.wallet && o.wallet !== where.wallet) return false;
            if (where.createdAt?.gte && o.createdAt < where.createdAt.gte) return false;
            if (where.createdAt?.lte && o.createdAt > where.createdAt.lte) return false;
            return true;
         });
      }),
   },
   activity: {
      create: jest.fn(async ({ data }: any) => {
         const a = { id: `act-${Date.now()}-${Math.random()}`, ...data };
         mockActivities.push(a);
         return a;
      }),
      findMany: jest.fn(async ({ where }: any) => {
         return mockActivities.filter(a => {
            if (where.createdAt?.gte && a.createdAt < where.createdAt.gte) return false;
            if (where.createdAt?.lte && a.createdAt > where.createdAt.lte) return false;
            if (where.OR) {
               const match = where.OR.some((c: any) => (c.actor && a.actor === c.actor) || (c.target && a.target === c.target));
               if (!match) return false;
            }
            return true;
         });
      }),
      deleteMany: jest.fn(async () => {
         mockActivities.length = 0;
         return { count: 0 };
      }),
   },
};

jest.mock('../utils/prisma.utils', () => ({
   prisma: mockPrisma,
}));

import { DigestWorker } from './digest.worker';
import { LogMailer } from '../services/email/mailer.service';
import { Keypair } from '@stellar/stellar-base';

describe('DigestWorker', () => {
   let logMailer: LogMailer;

   beforeEach(() => {
      mockPreferences.clear();
      mockTrades.length = 0;
      mockOrders.length = 0;
      mockActivities.length = 0;
      logMailer = new LogMailer();
   });

   describe('Eligibility & Frequency Scheduling', () => {
      it('unverified emails never receive digests', async () => {
         const wallet = Keypair.random().publicKey();
         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'unverified@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: null, // UNVERIFIED!
               lastDigestAt: null,
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: wallet,
               creatorId: 'creator-1',
               quantity: '10',
               price: '1.5',
               ledger: 100,
               txHash: `tx-unverified-${Date.now()}`,
               timestamp: new Date(),
            },
         });

         const worker = new DigestWorker({ mailer: logMailer, prisma: mockPrisma as any });
         const result = await worker.runCycle();

         expect(result.sent).toBe(0);
         expect(logMailer.sentEmails.length).toBe(0);
      });

      it('unsubscribed users are skipped and never receive digests', async () => {
         const wallet = Keypair.random().publicKey();
         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'unsubbed@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: new Date(),
               unsubscribedAt: new Date(), // UNSUBSCRIBED!
               lastDigestAt: null,
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: wallet,
               creatorId: 'creator-1',
               quantity: '5',
               price: '2.0',
               ledger: 101,
               txHash: `tx-unsub-${Date.now()}`,
               timestamp: new Date(),
            },
         });

         const worker = new DigestWorker({ mailer: logMailer, prisma: mockPrisma as any });
         const result = await worker.runCycle();

         expect(result.sent).toBe(0);
         expect(logMailer.sentEmails.length).toBe(0);
      });

      it('daily vs weekly due-ness evaluation', async () => {
         const dailyWallet = Keypair.random().publicKey();
         const weeklyWallet = Keypair.random().publicKey();

         const t0 = new Date('2026-11-20T12:00:00.000Z');

         const dailyPref = await mockPrisma.notificationPreference.create({
            data: {
               wallet: dailyWallet,
               email: 'daily@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: t0,
               lastDigestAt: t0,
            },
         });

         const weeklyPref = await mockPrisma.notificationPreference.create({
            data: {
               wallet: weeklyWallet,
               email: 'weekly@example.com',
               frequency: 'weekly',
               events: ['KEY_BOUGHT'],
               verifiedAt: t0,
               lastDigestAt: t0,
            },
         });

         const worker = new DigestWorker({ mailer: logMailer, prisma: mockPrisma as any });

         // 1. After 12 hours: neither is due
         const t12h = new Date(t0.getTime() + 12 * 60 * 60 * 1000);
         expect(worker.isDue(dailyPref, t12h)).toBe(false);
         expect(worker.isDue(weeklyPref, t12h)).toBe(false);

         // 2. After 24 hours: daily is due, weekly is NOT due
         const t24h = new Date(t0.getTime() + 24 * 60 * 60 * 1000);
         expect(worker.isDue(dailyPref, t24h)).toBe(true);
         expect(worker.isDue(weeklyPref, t24h)).toBe(false);

         // 3. After 7 days: weekly is due
         const t7d = new Date(t0.getTime() + 7 * 24 * 60 * 60 * 1000);
         expect(worker.isDue(dailyPref, t7d)).toBe(true);
         expect(worker.isDue(weeklyPref, t7d)).toBe(true);
      });
   });

   describe('Event Gathering & Filtering', () => {
      it('sends no email when there are no events in the period (empty digests)', async () => {
         const wallet = Keypair.random().publicKey();
         const now = new Date('2026-11-20T12:00:00.000Z');
         const past = new Date('2026-11-19T10:00:00.000Z');

         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'empty@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: past,
               lastDigestAt: past,
            },
         });

         const worker = new DigestWorker({
            mailer: logMailer,
            prisma: mockPrisma as any,
            now: () => now,
         });
         const result = await worker.runCycle();

         expect(result.sent).toBe(0);
         expect(result.skippedEmpty).toBe(1);
         expect(logMailer.sentEmails.length).toBe(0);
      });

      it('digest contains only events matching the user selected types', async () => {
         const wallet = Keypair.random().publicKey();
         const now = new Date('2026-11-20T14:00:00.000Z');
         const periodStart = new Date('2026-11-19T12:00:00.000Z'); // 26 hours ago

         // User only subscribes to KEY_BOUGHT
         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'filter@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'], // Only KEY_BOUGHT
               verifiedAt: periodStart,
               lastDigestAt: periodStart,
            },
         });

         // 1. Matching Trade event
         await mockPrisma.trade.create({
            data: {
               buyer: wallet,
               creatorId: 'creator-alpha',
               quantity: '3',
               price: '5.0',
               ledger: 200,
               txHash: `tx-match-${Date.now()}`,
               timestamp: new Date('2026-11-20T06:00:00.000Z'),
            },
         });

         // 2. Non-matching Activity event (DIVIDEND_DISTRIBUTED)
         await mockPrisma.activity.create({
            data: {
               actor: wallet,
               type: 'DIVIDEND_DISTRIBUTED',
               payload: { amount: '100' },
               createdAt: new Date('2026-11-20T07:00:00.000Z'),
            },
         });

         const worker = new DigestWorker({
            mailer: logMailer,
            prisma: mockPrisma as any,
            now: () => now,
         });

         const result = await worker.runCycle();

         expect(result.sent).toBe(1);
         expect(logMailer.sentEmails.length).toBe(1);

         const email = logMailer.sentEmails[0];
         expect(email.to).toBe('filter@example.com');
         expect(email.html).toContain('creator-alpha');
         expect(email.html).not.toContain('DIVIDEND_DISTRIBUTED');
         expect(email.headers?.['List-Unsubscribe']).toBeDefined();
      });
   });

   describe('Digest Delivery, Error Isolation & State Progression', () => {
      it('lastDigestAt only advances after a successful send', async () => {
         const wallet = Keypair.random().publicKey();
         const initialLastDigest = new Date('2026-11-19T10:00:00.000Z');
         const now = new Date('2026-11-20T12:00:00.000Z');

         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'failingmailer@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: initialLastDigest,
               lastDigestAt: initialLastDigest,
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: wallet,
               creatorId: 'creator-fail',
               quantity: '1',
               price: '1.0',
               ledger: 300,
               txHash: `tx-fail-${Date.now()}`,
               timestamp: new Date('2026-11-20T00:00:00.000Z'),
            },
         });

         // Failing mailer mock
         const failingMailer = {
            send: jest.fn().mockResolvedValue(false), // Failed send!
         };

         const worker = new DigestWorker({
            mailer: failingMailer,
            prisma: mockPrisma as any,
            now: () => now,
         });

         const result = await worker.runCycle();
         expect(result.failed).toBe(1);

         // Verify in DB that lastDigestAt did NOT advance
         const pref = await mockPrisma.notificationPreference.findUnique({ where: { wallet } });
         expect(pref?.lastDigestAt?.toISOString()).toBe(initialLastDigest.toISOString());
      });

      it('one failing recipient does not stop other recipients', async () => {
         const failWallet = Keypair.random().publicKey();
         const successWallet = Keypair.random().publicKey();
         const now = new Date('2026-11-20T12:00:00.000Z');
         const past = new Date('2026-11-19T00:00:00.000Z');

         await mockPrisma.notificationPreference.create({
            data: {
               wallet: failWallet,
               email: 'recipient1-fail@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: past,
               lastDigestAt: past,
            },
         });

         await mockPrisma.notificationPreference.create({
            data: {
               wallet: successWallet,
               email: 'recipient2-success@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: past,
               lastDigestAt: past,
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: failWallet,
               creatorId: 'c1',
               quantity: '1',
               price: '1.0',
               ledger: 401,
               txHash: `tx-multi-1-${Date.now()}`,
               timestamp: new Date('2026-11-20T01:00:00.000Z'),
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: successWallet,
               creatorId: 'c2',
               quantity: '2',
               price: '2.0',
               ledger: 402,
               txHash: `tx-multi-2-${Date.now()}`,
               timestamp: new Date('2026-11-20T02:00:00.000Z'),
            },
         });

         // Mailer that throws on recipient1 but succeeds on recipient2
         const customMailer = {
            send: jest.fn().mockImplementation(async (opts: any) => {
               if (opts.to.includes('recipient1-fail')) {
                  throw new Error('SMTP connection timeout for recipient 1');
               }
               return true;
            }),
         };

         const worker = new DigestWorker({
            mailer: customMailer,
            prisma: mockPrisma as any,
            now: () => now,
         });

         const result = await worker.runCycle();

         expect(result.failed).toBe(1);
         expect(result.sent).toBe(1);

         // Recipient 2 succeeded and lastDigestAt was updated to now
         const pref2 = await mockPrisma.notificationPreference.findUnique({
            where: { wallet: successWallet },
         });
         expect(pref2?.lastDigestAt?.toISOString()).toBe(now.toISOString());
      });

      it('prevents double send when worker runs twice concurrently', async () => {
         const wallet = Keypair.random().publicKey();
         const now = new Date('2026-11-20T12:00:00.000Z');
         const past = new Date('2026-11-19T00:00:00.000Z');

         await mockPrisma.notificationPreference.create({
            data: {
               wallet,
               email: 'dedupe@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: past,
               lastDigestAt: past,
            },
         });

         await mockPrisma.trade.create({
            data: {
               buyer: wallet,
               creatorId: 'c-dedupe',
               quantity: '1',
               price: '1.0',
               ledger: 500,
               txHash: `tx-dedupe-${Date.now()}`,
               timestamp: new Date('2026-11-20T01:00:00.000Z'),
            },
         });

         const worker1 = new DigestWorker({ mailer: logMailer, prisma: mockPrisma as any, now: () => now });
         const worker2 = new DigestWorker({ mailer: logMailer, prisma: mockPrisma as any, now: () => now });

         // Run both cycles concurrently
         const [res1, res2] = await Promise.all([worker1.runCycle(), worker2.runCycle()]);

         // Only one worker sends an email
         const totalSent = res1.sent + res2.sent;
         expect(totalSent).toBe(1);
         expect(logMailer.sentEmails.length).toBe(1);
      });
   });
});
