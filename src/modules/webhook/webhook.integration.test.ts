import http from 'http';
import { httpRegisterWebhook, httpSimulateTrade } from './webhook.controllers';
import { prisma } from '../../utils/prisma.utils';

// Mock the prisma client to avoid needing a live DB connection
jest.mock('../../utils/prisma.utils', () => ({
    prisma: {
        activity: {
            create: jest.fn(),
        },
        webhookSubscription: {
            upsert: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

const activityCreateMock = prisma.activity.create as jest.Mock;
const webhookUpsertMock = prisma.webhookSubscription.upsert as jest.Mock;
const webhookFindManyMock = prisma.webhookSubscription.findMany as jest.Mock;

// Helper to mock Express req, res, next
function makeReq(body: any = {}): any {
    return { body };
}

function makeRes(): any {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

function makeNext() {
    return jest.fn();
}

describe('Webhook Integration Tests', () => {
    let mockServer: http.Server;
    let mockServerUrl: string;
    let receivedPayloads: any[] = [];

    beforeAll((done) => {
        // Start a mock HTTP server to receive webhook payloads
        mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
            });
            req.on('end', () => {
                try {
                    receivedPayloads.push(JSON.parse(body));
                } catch (_e) {
                    // Ignore non-json bodies
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
        });

        mockServer.listen(0, '127.0.0.1', () => {
            const address = mockServer.address() as any;
            mockServerUrl = `http://127.0.0.1:${address.port}/webhook`;
            done();
        });
    });

    afterAll((done) => {
        mockServer.close(done);
    });

    beforeEach(() => {
        receivedPayloads = [];
        jest.clearAllMocks();
    });

    it('should register a webhook successfully', async () => {
        const req = makeReq({
            url: mockServerUrl,
            events: ['buy', 'sell'],
        });
        const res = makeRes();
        const next = makeNext();

        const mockSub = {
            id: 'sub-123',
            url: mockServerUrl,
            events: ['buy', 'sell'],
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        webhookUpsertMock.mockResolvedValue(mockSub);

        await httpRegisterWebhook(req, res, next);

        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    url: mockServerUrl,
                    events: ['buy', 'sell'],
                }),
            })
        );
        expect(webhookUpsertMock).toHaveBeenCalledWith({
            where: { url: mockServerUrl },
            create: { url: mockServerUrl, events: ['buy', 'sell'] },
            update: { events: ['buy', 'sell'] },
        });
    });

    it('should deliver webhook with event_type: buy when a buy trade is simulated', async () => {
        const req = makeReq({
            type: 'buy',
            amount: 5,
            price: 15.5,
            creatorId: 'creator-abc',
            actor: 'user-xyz',
        });
        const res = makeRes();
        const next = makeNext();

        const mockActivity = {
            id: 'activity-buy-1',
            type: 'KEY_BOUGHT',
            actor: 'user-xyz',
            creatorId: 'creator-abc',
            payload: { amount: 5, price: 15.5 },
            createdAt: new Date(),
        };

        const mockSubscriptions = [
            {
                id: 'sub-123',
                url: mockServerUrl,
                events: ['buy', 'sell'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];

        activityCreateMock.mockResolvedValue(mockActivity);
        webhookFindManyMock.mockResolvedValue(mockSubscriptions);

        await httpSimulateTrade(req, res, next);

        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    activity: expect.objectContaining({ id: 'activity-buy-1' }),
                }),
            })
        );

        // Verify webhook HTTP delivery
        expect(receivedPayloads).toHaveLength(1);
        expect(receivedPayloads[0]).toEqual({
            event_type: 'buy',
            activity: expect.objectContaining({
                id: 'activity-buy-1',
                type: 'KEY_BOUGHT',
            }),
        });
    });

    it('should deliver webhook with event_type: sell when a sell trade is simulated', async () => {
        const req = makeReq({
            type: 'sell',
            amount: 2,
            price: 8.0,
            creatorId: 'creator-abc',
            actor: 'user-xyz',
        });
        const res = makeRes();
        const next = makeNext();

        const mockActivity = {
            id: 'activity-sell-1',
            type: 'KEY_SOLD',
            actor: 'user-xyz',
            creatorId: 'creator-abc',
            payload: { amount: 2, price: 8.0 },
            createdAt: new Date(),
        };

        const mockSubscriptions = [
            {
                id: 'sub-123',
                url: mockServerUrl,
                events: ['buy', 'sell'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];

        activityCreateMock.mockResolvedValue(mockActivity);
        webhookFindManyMock.mockResolvedValue(mockSubscriptions);

        await httpSimulateTrade(req, res, next);

        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    activity: expect.objectContaining({ id: 'activity-sell-1' }),
                }),
            })
        );

        // Verify webhook HTTP delivery
        expect(receivedPayloads).toHaveLength(1);
        expect(receivedPayloads[0]).toEqual({
            event_type: 'sell',
            activity: expect.objectContaining({
                id: 'activity-sell-1',
                type: 'KEY_SOLD',
            }),
        });
    });

    it('should not deliver webhook if subscription does not match event_type', async () => {
        const req = makeReq({
            type: 'sell',
            amount: 1,
            price: 10.0,
            creatorId: 'creator-abc',
            actor: 'user-xyz',
        });
        const res = makeRes();
        const next = makeNext();

        activityCreateMock.mockResolvedValue({
            id: 'activity-sell-2',
            type: 'KEY_SOLD',
            actor: 'user-xyz',
            creatorId: 'creator-abc',
            payload: { amount: 1, price: 10.0 },
            createdAt: new Date(),
        });

        // Mock findMany returning empty array (no subscriptions for sell event)
        webhookFindManyMock.mockResolvedValue([]);

        await httpSimulateTrade(req, res, next);

        expect(receivedPayloads).toHaveLength(0);
    });
});
