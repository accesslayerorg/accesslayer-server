// Unit tests for alert.service.ts (#423)
//
// Covers: createAlert, listAlerts, deleteAlert.
// Uses Jest mocks for prisma — no database required.

import { createAlert, listAlerts, deleteAlert } from '../alert.service';
import { prisma } from '../../../utils/prisma.utils';
import { logger } from '../../../utils/logger.utils';

jest.mock('../../../utils/prisma.utils', () => ({
    prisma: {
        priceAlert: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            delete: jest.fn(),
        },
    },
}));

jest.mock('../../../utils/logger.utils', () => ({
    logger: { info: jest.fn() },
}));

const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const BASE_INPUT = {
    creator_id: 'creator-1',
    wallet_address: VALID_ADDRESS,
    target_price: 100,
    direction: 'above' as const,
    callback_url: 'https://example.com/callback',
};

const DB_ALERT = {
    id: 'alert-1',
    creatorId: 'creator-1',
    walletAddress: VALID_ADDRESS,
    targetPrice: 100,
    direction: 'above',
    callbackUrl: 'https://example.com/callback',
    isActive: true,
    triggeredAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('createAlert', () => {
    afterEach(() => jest.clearAllMocks());

    it('calls prisma.priceAlert.create with correct data', async () => {
        (mockedPrisma.priceAlert.create as jest.Mock).mockResolvedValue(DB_ALERT);

        const result = await createAlert(BASE_INPUT);

        expect(mockedPrisma.priceAlert.create).toHaveBeenCalledWith({
            data: {
                creatorId: 'creator-1',
                walletAddress: VALID_ADDRESS,
                targetPrice: 100,
                direction: 'above',
                callbackUrl: 'https://example.com/callback',
            },
        });
        expect(result).toEqual(DB_ALERT);

        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                alert_id: DB_ALERT.id,
                creator_id: DB_ALERT.creatorId,
                direction: DB_ALERT.direction,
                target_price: DB_ALERT.targetPrice,
                registered_at: DB_ALERT.createdAt,
                wallet_address: 'GAAA***AAAA',
            }),
            'Price alert registered'
        );
        expect((logger.info as jest.Mock).mock.calls[0][0]).not.toHaveProperty('callback_url');
    });

    it('creates a below-direction alert', async () => {
        const input = { ...BASE_INPUT, direction: 'below' as const, target_price: 50 };
        (mockedPrisma.priceAlert.create as jest.Mock).mockResolvedValue({
            ...DB_ALERT,
            direction: 'below',
            targetPrice: 50,
        });

        const result = await createAlert(input);
        expect(result.direction).toBe('below');
    });
});

describe('listAlerts', () => {
    afterEach(() => jest.clearAllMocks());

    it('returns active alerts for a wallet address', async () => {
        (mockedPrisma.priceAlert.findMany as jest.Mock).mockResolvedValue([DB_ALERT]);

        const result = await listAlerts(VALID_ADDRESS);

        expect(mockedPrisma.priceAlert.findMany).toHaveBeenCalledWith({
            where: { walletAddress: VALID_ADDRESS, isActive: true },
            orderBy: { createdAt: 'desc' },
        });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('alert-1');
    });

    it('returns empty array when no alerts exist', async () => {
        (mockedPrisma.priceAlert.findMany as jest.Mock).mockResolvedValue([]);

        const result = await listAlerts(VALID_ADDRESS);
        expect(result).toEqual([]);
    });
});

describe('deleteAlert', () => {
    afterEach(() => jest.clearAllMocks());

    it('deletes the alert and returns its id when found', async () => {
        (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(DB_ALERT);
        (mockedPrisma.priceAlert.delete as jest.Mock).mockResolvedValue(DB_ALERT);

        const result = await deleteAlert('alert-1', VALID_ADDRESS);

        expect(mockedPrisma.priceAlert.findFirst).toHaveBeenCalledWith({
            where: { id: 'alert-1', walletAddress: VALID_ADDRESS },
        });
        expect(mockedPrisma.priceAlert.delete).toHaveBeenCalledWith({
            where: { id: 'alert-1' },
        });
        expect(result).toEqual({ id: 'alert-1' });

        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                alert_id: DB_ALERT.id,
                creator_id: DB_ALERT.creatorId,
                cancelled_at: expect.any(Date),
                wallet_address: 'GAAA***AAAA',
            }),
            'Price alert cancelled'
        );
        expect((logger.info as jest.Mock).mock.calls[0][0]).not.toHaveProperty('callback_url');
    });

    it('returns null when the alert is not found', async () => {
        (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(null);

        const result = await deleteAlert('nonexistent', VALID_ADDRESS);

        expect(result).toBeNull();
        expect(mockedPrisma.priceAlert.delete).not.toHaveBeenCalled();
    });

    it('does not delete an alert belonging to a different wallet address', async () => {
        (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(null);

        const result = await deleteAlert('alert-1', 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
        expect(result).toBeNull();
    });
});
