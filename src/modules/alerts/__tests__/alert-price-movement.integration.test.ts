import { evaluatePriceAlertsForMovement } from '../alert.service';
import { prisma } from '../../../utils/prisma.utils';
import { envConfig } from '../../../config';
import { logger } from '../../../utils/logger.utils';

jest.mock('../../../utils/prisma.utils', () => ({
    prisma: {
        priceAlert: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../../utils/logger.utils', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockPrisma = prisma as unknown as {
    priceAlert: {
        findMany: jest.Mock;
        update: jest.Mock;
    };
};

const mockLogger = logger as unknown as {
    warn: jest.Mock;
    error: jest.Mock;
};

const BASE_ALERT = {
    id: 'alert-1',
    creatorId: 'creator-1',
    walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    targetPrice: 100,
    callbackUrl: 'https://example.com/price-alert',
    isActive: true,
    triggeredAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
};

describe('price alert movement integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('does not fire an above alert when the price drops', async () => {
        mockPrisma.priceAlert.findMany.mockResolvedValue([
            {
                ...BASE_ALERT,
                id: 'above-alert',
                direction: 'above',
                targetPrice: 120,
            },
        ]);

        await evaluatePriceAlertsForMovement({
            creatorId: 'creator-1',
            previousPrice: 100,
            currentPrice: 90,
        });

        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockPrisma.priceAlert.update).not.toHaveBeenCalled();
        expect(mockPrisma.priceAlert.findMany).toHaveBeenCalledWith({
            where: {
                creatorId: 'creator-1',
                isActive: true,
                triggeredAt: null,
            },
        });
    });

    it('does not fire a below alert when the price rises', async () => {
        mockPrisma.priceAlert.findMany.mockResolvedValue([
            {
                ...BASE_ALERT,
                id: 'below-alert',
                direction: 'below',
                targetPrice: 80,
            },
        ]);

        await evaluatePriceAlertsForMovement({
            creatorId: 'creator-1',
            previousPrice: 100,
            currentPrice: 110,
        });

        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockPrisma.priceAlert.update).not.toHaveBeenCalled();
    });

    it('logs a structured warning with masked URL after a failed delivery attempt', async () => {
        mockPrisma.priceAlert.findMany.mockResolvedValue([
            {
                ...BASE_ALERT,
                id: 'above-alert',
                direction: 'above',
                targetPrice: 100,
                callbackUrl: 'https://hooks.example.com/secret/path?token=sensitive',
            },
        ]);
        mockPrisma.priceAlert.update.mockResolvedValue({});
        (global.fetch as jest.Mock)
            .mockRejectedValueOnce(new Error('Network failure'))
            .mockResolvedValueOnce({ ok: true });

        await evaluatePriceAlertsForMovement({
            creatorId: 'creator-1',
            previousPrice: 90,
            currentPrice: 110,
        });

        expect(mockLogger.warn).toHaveBeenCalledWith(
            {
                alert_id: 'above-alert',
                retry_count: 1,
                error_code: 'Error',
                failure_reason: 'Network failure',
                masked_url: 'https://hooks.example.com',
            },
            'Price alert webhook delivery failed'
        );
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('/secret/path');
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('sensitive');
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockPrisma.priceAlert.update).toHaveBeenCalledWith({
            where: { id: 'above-alert' },
            data: {
                isActive: false,
                triggeredAt: expect.any(Date),
            },
        });
    });

    it('logs a structured final error with masked URL when retries are exhausted', async () => {
        mockPrisma.priceAlert.findMany.mockResolvedValue([
            {
                ...BASE_ALERT,
                id: 'below-alert',
                direction: 'below',
                targetPrice: 80,
                callbackUrl: 'https://hooks.example.com/private/price-alert',
            },
        ]);
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 503,
        });

        await expect(
            evaluatePriceAlertsForMovement({
                creatorId: 'creator-1',
                previousPrice: 100,
                currentPrice: 70,
            })
        ).rejects.toThrow('HTTP_503');

        expect(global.fetch).toHaveBeenCalledTimes(envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS);
        expect(mockLogger.error).toHaveBeenCalledWith(
            {
                alert_id: 'below-alert',
                retry_count: envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS,
                error_code: 'HTTP_503',
                failure_reason: 'HTTP_503',
                masked_url: 'https://hooks.example.com',
                final: true,
            },
            'Price alert webhook delivery exhausted retries'
        );
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('/private/price-alert');
        expect(mockPrisma.priceAlert.update).not.toHaveBeenCalled();
    });

    it('logs a structured error with all fields when the database query fails', async () => {
        const dbError = new Error('connection refused');
        mockPrisma.priceAlert.findMany.mockRejectedValue(dbError);

        await expect(
            evaluatePriceAlertsForMovement({
                creatorId: 'creator-1',
                previousPrice: 90,
                currentPrice: 110,
                ledger_sequence: 42,
            })
        ).rejects.toThrow('connection refused');

        expect(mockLogger.error).toHaveBeenCalledWith(
            {
                creator_id: 'creator-1',
                ledger_sequence: 42,
                new_price: 110,
                error_message: 'connection refused',
                failed_at: expect.any(String),
            },
            'Price alert threshold check failed'
        );
    });

    it('does not log alert threshold failure when the check succeeds', async () => {
        mockPrisma.priceAlert.findMany.mockResolvedValue([]);

        await evaluatePriceAlertsForMovement({
            creatorId: 'creator-1',
            previousPrice: 90,
            currentPrice: 110,
        });

        expect(mockLogger.error).not.toHaveBeenCalled();
    });
});
