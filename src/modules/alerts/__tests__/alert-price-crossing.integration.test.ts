// Integration tests for price alert firing and post-delivery cleanup (#464, #472)
//
// #464: Verifies that the registered callback receives a POST with the correct
//       payload when the creator key price crosses the registered threshold.
// #472: Verifies that the alert record is deleted (set inactive) after a
//       successful delivery, and that a second crossing does not retrigger.

import { evaluatePriceAlertsForMovement } from '../alert.service';
import { prisma } from '../../../utils/prisma.utils';

jest.mock('../../../utils/prisma.utils', () => ({
  prisma: {
    priceAlert: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const mockPrisma = prisma as unknown as {
  priceAlert: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

const CREATOR_ID = 'creator-alert-test';
const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CALLBACK_URL = 'https://hooks.example.com/price-alert';

const BASE_ALERT = {
  id: 'alert-fire-test',
  creatorId: CREATOR_ID,
  walletAddress: WALLET_ADDRESS,
  targetPrice: 100,
  direction: 'above' as const,
  callbackUrl: CALLBACK_URL,
  isActive: true,
  triggeredAt: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

describe('price alert fires when price crosses threshold (#464)', () => {
  it('calls the callback URL when price crosses above the target', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      CALLBACK_URL,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends the correct payload to the callback', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);

    expect(body.creator_id).toBe(CREATOR_ID);
    expect(body.target_price).toBe(100);
    expect(body.current_price).toBe(110);
    expect(body.direction).toBe('above');
    expect(body.event_type).toBe('price_alert');
  });

  it('calls the callback when price crosses below the target', async () => {
    const belowAlert = { ...BASE_ALERT, id: 'alert-below', direction: 'below' as const, targetPrice: 80 };
    mockPrisma.priceAlert.findMany.mockResolvedValue([belowAlert]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 70,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.direction).toBe('below');
    expect(body.current_price).toBe(70);
  });

  it('does not call the callback when price does not cross the threshold', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 95,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not call the callback when price crosses in the wrong direction', async () => {
    // alert is 'above' but price dropped
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 110,
      currentPrice: 90,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('includes alert_id in the callback payload', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.alert_id).toBe(BASE_ALERT.id);
  });
});

describe('price alert deleted after successful webhook delivery (#472)', () => {
  it('marks the alert inactive after successful delivery', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    expect(mockPrisma.priceAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BASE_ALERT.id },
        data: expect.objectContaining({ isActive: false }),
      })
    );
  });

  it('sets triggeredAt after successful delivery', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    const updateCall = mockPrisma.priceAlert.update.mock.calls[0][0];
    expect(updateCall.data.triggeredAt).toBeInstanceOf(Date);
  });

  it('does not re-trigger when the alert is already inactive (second crossing)', async () => {
    // Second call: alert is not returned because isActive: false filters it out
    mockPrisma.priceAlert.findMany.mockResolvedValue([]);

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 120,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.priceAlert.update).not.toHaveBeenCalled();
  });

  it('does not mark alert inactive when the callback fails', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    await expect(
      evaluatePriceAlertsForMovement({
        creatorId: CREATOR_ID,
        previousPrice: 90,
        currentPrice: 110,
      })
    ).rejects.toThrow();

    expect(mockPrisma.priceAlert.update).not.toHaveBeenCalled();
  });

  it('update is called exactly once per alert per movement', async () => {
    mockPrisma.priceAlert.findMany.mockResolvedValue([BASE_ALERT]);
    mockPrisma.priceAlert.update.mockResolvedValue({});

    await evaluatePriceAlertsForMovement({
      creatorId: CREATOR_ID,
      previousPrice: 90,
      currentPrice: 110,
    });

    expect(mockPrisma.priceAlert.update).toHaveBeenCalledTimes(1);
  });
});
