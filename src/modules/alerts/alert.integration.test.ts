import supertest from 'supertest';
import { Prisma } from '@prisma/client';
import { Keypair } from '@stellar/stellar-base';

// Mock Prisma so the integration test exercises the full HTTP + dispatch path
// without requiring a live database, matching the suite's mocking conventions.
jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    alert: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../utils/logger.utils', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { evaluateTradeForAlerts } from './alert.service';
import { envConfig } from '../../config';

const mockPrisma = prisma as unknown as {
  alert: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
};

const walletAddress = Keypair.random().publicKey();

function decimal(v: string): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/v1/alerts', () => {
  it('registers an alert and returns a unique alert ID', async () => {
    mockPrisma.alert.create.mockResolvedValue({
      id: 'alert-generated-id',
      creatorId: 'creator-1',
      walletAddress,
      targetPrice: decimal('15'),
      direction: 'ABOVE',
      callbackUrl: 'https://example.com/hook',
      status: 'PENDING',
      createdAt: new Date(),
    });

    const res = await supertest(app)
      .post('/api/v1/alerts')
      .send({
        creator_id: 'creator-1',
        wallet_address: walletAddress,
        target_price: '15',
        direction: 'above',
        callback_url: 'https://example.com/hook',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('alert-generated-id');
    expect(res.body.data.direction).toBe('above');
  });

  it('returns 400 on invalid body (bad direction / url / price)', async () => {
    const res = await supertest(app)
      .post('/api/v1/alerts')
      .send({
        creator_id: 'creator-1',
        wallet_address: walletAddress,
        target_price: '-5',
        direction: 'sideways',
        callback_url: 'not-a-url',
      });

    expect(res.status).toBe(400);
    expect(mockPrisma.alert.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/alerts/:id', () => {
  it('cancels a pending alert before it fires', async () => {
    mockPrisma.alert.findFirst.mockResolvedValue({ id: 'alert-1', status: 'PENDING' });
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-1' });

    const res = await supertest(app).delete('/api/v1/alerts/alert-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-1' } });
  });

  it('returns 404 for a non-existent alert', async () => {
    mockPrisma.alert.findFirst.mockResolvedValue(null);

    const res = await supertest(app).delete('/api/v1/alerts/missing-id');

    expect(res.status).toBe(404);
  });
});

describe('alert trigger evaluation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fires on an above trigger and deletes the alert (one-shot)', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-above',
        creatorId: 'creator-1',
        walletAddress,
        targetPrice: decimal('10'),
        direction: 'ABOVE',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-above' });
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    (global.fetch as jest.Mock) = mockFetch;

    await evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '11',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-above' } });
  });

  it('fires on a below trigger and deletes the alert (one-shot)', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-below',
        creatorId: 'creator-1',
        walletAddress,
        targetPrice: decimal('10'),
        direction: 'BELOW',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-below' });
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    (global.fetch as jest.Mock) = mockFetch;

    await evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '9',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-below' } });
  });

  it('does not fire when price moves in the opposite direction', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-above',
        creatorId: 'creator-1',
        walletAddress,
        targetPrice: decimal('10'),
        direction: 'ABOVE',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    const mockFetch = jest.fn();
    (global.fetch as jest.Mock) = mockFetch;

    await evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '5',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPrisma.alert.delete).not.toHaveBeenCalled();
  });

  describe('failed delivery retry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retries failed delivery up to 3 times then marks the alert failed', async () => {
      mockPrisma.alert.findMany.mockResolvedValue([
        {
          id: 'alert-fail',
          creatorId: 'creator-1',
          walletAddress,
          targetPrice: decimal('10'),
          direction: 'ABOVE',
          callbackUrl: 'https://nonexistent.example.com/fail',
          status: 'PENDING',
        },
      ]);
      mockPrisma.alert.update.mockResolvedValue({});
      const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
      (global.fetch as jest.Mock) = mockFetch;

      const promise = evaluateTradeForAlerts({
        creatorId: 'creator-1',
        price: '20',
        timestamp: new Date().toISOString(),
      });

      for (let i = 0; i < envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS; i++) {
        await jest.advanceTimersByTimeAsync(
          Math.pow(2, i) * envConfig.WEBHOOK_RETRY_BASE_DELAY_MS
        );
      }

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS);
      expect(mockPrisma.alert.delete).not.toHaveBeenCalled();
      expect(mockPrisma.alert.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        })
      );
    });
  });
});
