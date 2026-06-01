// Integration tests for health controllers under simulated dependency failures.
// All external dependencies (Prisma, config) are mocked so no real DB is needed.

jest.mock('../../config', () => ({
    envConfig: {
        MODE: 'production',
        PORT: 3000,
        INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
    },
    appConfig: {
        allowedOrigins: [],
    },
}));

jest.mock('../../utils/prisma.utils', () => ({
    prisma: {
        $queryRaw: jest.fn(),
    },
}));

jest.mock('../../utils/indexer-cursor-staleness.utils', () => ({
    checkIndexerCursorStalenessFromStore: jest.fn().mockResolvedValue(undefined),
}));

import { Request, Response } from 'express';
import { healthCheck, readinessCheck } from './health.controllers';
import { prisma } from '../../utils/prisma.utils';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(): Response & { statusCode: number; body: any } {
    const res = { statusCode: 0, body: undefined as any } as any;
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload: any) => {
        res.body = payload;
        return res;
    };
    return res;
}

function mockRequest(): Request {
    return {} as Request;
}

// ---------------------------------------------------------------------------
// readinessCheck — database failure
// ---------------------------------------------------------------------------

describe('readinessCheck() — simulated database failure', () => {
    beforeEach(() => {
        queryRawMock.mockReset();
    });

    it('returns 503 when the database is unreachable', async () => {
        queryRawMock.mockRejectedValue(new Error('connection refused'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        expect(res.statusCode).toBe(503);
    });

    it('sets ready:false when a dependency check fails', async () => {
        queryRawMock.mockRejectedValue(new Error('timeout'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        expect(res.body.ready).toBe(false);
    });

    it('response body conforms to the readiness schema even on failure', async () => {
        queryRawMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        expect(res.body).toHaveProperty('ready', false);
        expect(res.body).toHaveProperty('timestamp');
        expect(typeof res.body.timestamp).toBe('string');
        expect(res.body).toHaveProperty('latencyMs');
        expect(typeof res.body.latencyMs).toBe('number');
        expect(Array.isArray(res.body.checks)).toBe(true);
    });

    it('reports the database check as failed in the checks array', async () => {
        queryRawMock.mockRejectedValue(new Error('connection refused'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
        expect(dbCheck).toBeDefined();
        expect(dbCheck.status).toBe('fail');
        expect(typeof dbCheck.error).toBe('string');
    });

    it('still passes the cache check when only the database fails', async () => {
        queryRawMock.mockRejectedValue(new Error('db down'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        const cacheCheck = res.body.checks.find((c: any) => c.name === 'cache');
        expect(cacheCheck).toBeDefined();
        expect(cacheCheck.status).toBe('ok');
    });

    it('includes a non-zero latencyMs even when the database check fails', async () => {
        queryRawMock.mockRejectedValue(new Error('db down'));

        const res = mockResponse();
        await readinessCheck(mockRequest(), res);

        expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// healthCheck (detailed) — database failure in production
// ---------------------------------------------------------------------------

describe('healthCheck() — simulated database failure in production mode', () => {
    beforeEach(() => {
        queryRawMock.mockReset();
    });

    it('returns 503 when the database is disconnected in production', async () => {
        queryRawMock.mockRejectedValue(new Error('connection refused'));

        const res = mockResponse();
        await healthCheck(mockRequest(), res);

        expect(res.statusCode).toBe(503);
    });

    it('response body conforms to the health schema even when DB is down', async () => {
        queryRawMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = mockResponse();
        await healthCheck(mockRequest(), res);

        expect(res.body).toHaveProperty('success');
        expect(res.body).toHaveProperty('message');
        expect(res.body).toHaveProperty('timestamp');
        expect(res.body).toHaveProperty('database');
        expect(res.body.database.status).toBe('disconnected');
    });

    it('marks the Database service as unhealthy in the services array', async () => {
        queryRawMock.mockRejectedValue(new Error('db down'));

        const res = mockResponse();
        await healthCheck(mockRequest(), res);

        const dbService = res.body.services?.find((s: any) => s.name === 'Database');
        expect(dbService).toBeDefined();
        expect(dbService.status).toBe('unhealthy');
    });
});
