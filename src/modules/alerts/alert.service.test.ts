import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import * as alertService from './alert.service';

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

const mockPrisma = prisma as unknown as {
  alert: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
};

function decimal(v: string): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createAlert', () => {
  it('creates an alert and returns a unique ID with normalized fields', async () => {
    mockPrisma.alert.create.mockResolvedValue({
      id: 'alert-1',
      creatorId: 'creator-1',
      walletAddress: 'GABC',
      targetPrice: decimal('10.5'),
      direction: 'ABOVE',
      callbackUrl: 'https://example.com/hook',
      status: 'PENDING',
      createdAt: new Date(),
    });

    const result = await alertService.createAlert({
      creatorId: 'creator-1',
      walletAddress: 'GABC',
      targetPrice: '10.5',
      direction: 'above',
      callbackUrl: 'https://example.com/hook',
    });

    expect(result.id).toBe('alert-1');
    expect(result.direction).toBe('above');
    expect(result.status).toBe('pending');
    expect(result.targetPrice).toBe('10.5');
    expect(mockPrisma.alert.create).toHaveBeenCalledTimes(1);
  });
});

describe('deleteAlert', () => {
  it('cancels a pending alert', async () => {
    mockPrisma.alert.findFirst.mockResolvedValue({ id: 'alert-1', status: 'PENDING' });
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-1' });

    const result = await alertService.deleteAlert('alert-1');

    expect(result).toEqual({ id: 'alert-1' });
    expect(mockPrisma.alert.findFirst).toHaveBeenCalledWith({
      where: { id: 'alert-1', status: 'PENDING' },
    });
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-1' } });
  });

  it('returns null for a non-existent or already-fired alert', async () => {
    mockPrisma.alert.findFirst.mockResolvedValue(null);

    const result = await alertService.deleteAlert('alert-1');

    expect(result).toBeNull();
    expect(mockPrisma.alert.delete).not.toHaveBeenCalled();
  });
});

describe('evaluateTradeForAlerts — threshold crossing', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fires an ABOVE alert when price rises past the target', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-above',
        creatorId: 'creator-1',
        walletAddress: 'GABC',
        targetPrice: decimal('10'),
        direction: 'ABOVE',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    (global.fetch as jest.Mock) = mockFetch;
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-above' });

    await alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '12',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      creator_id: 'creator-1',
      triggered_price: '12',
      target_price: '10',
      direction: 'above',
    });
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-above' } });
  });

  it('fires a BELOW alert when price drops past the target', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-below',
        creatorId: 'creator-1',
        walletAddress: 'GABC',
        targetPrice: decimal('10'),
        direction: 'BELOW',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    (global.fetch as jest.Mock) = mockFetch;
    mockPrisma.alert.delete.mockResolvedValue({ id: 'alert-below' });

    await alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '8',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.direction).toBe('below');
    expect(mockPrisma.alert.delete).toHaveBeenCalledWith({ where: { id: 'alert-below' } });
  });

  it('does NOT fire an ABOVE alert when price moves the opposite direction', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-above',
        creatorId: 'creator-1',
        walletAddress: 'GABC',
        targetPrice: decimal('10'),
        direction: 'ABOVE',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    const mockFetch = jest.fn();
    (global.fetch as jest.Mock) = mockFetch;

    await alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '8',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPrisma.alert.delete).not.toHaveBeenCalled();
  });

  it('does NOT fire a BELOW alert when price moves the opposite direction', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-below',
        creatorId: 'creator-1',
        walletAddress: 'GABC',
        targetPrice: decimal('10'),
        direction: 'BELOW',
        callbackUrl: 'https://example.com/hook',
        status: 'PENDING',
      },
    ]);
    const mockFetch = jest.fn();
    (global.fetch as jest.Mock) = mockFetch;

    await alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '12',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when no pending alerts exist for the creator', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([]);
    const mockFetch = jest.fn();
    (global.fetch as jest.Mock) = mockFetch;

    await alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '99',
      timestamp: new Date().toISOString(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('evaluateTradeForAlerts — delivery retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries delivery up to max attempts then marks the alert FAILED', async () => {
    mockPrisma.alert.findMany.mockResolvedValue([
      {
        id: 'alert-fail',
        creatorId: 'creator-1',
        walletAddress: 'GABC',
        targetPrice: decimal('10'),
        direction: 'ABOVE',
        callbackUrl: 'https://nonexistent.example.com/fail',
        status: 'PENDING',
      },
    ]);
    mockPrisma.alert.update.mockResolvedValue({});

    const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
    (global.fetch as jest.Mock) = mockFetch;

    const promise = alertService.evaluateTradeForAlerts({
      creatorId: 'creator-1',
      price: '12',
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
        where: { id: 'alert-fail' },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });
});
