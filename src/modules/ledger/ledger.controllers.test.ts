import { Request, Response } from 'express';
import { httpGetLedgerStatus } from './ledger.controllers';
import { prisma } from '../../utils/prisma.utils';
import { sendSuccess } from '../../utils/api-response.utils';

// Mock prisma and api-response utils
jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    indexedLedger: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../../utils/api-response.utils', () => ({
  sendSuccess: jest.fn(),
}));

jest.mock('../../utils/timestamp-headers.utils', () => ({
  attachTimestampHeader: jest.fn(),
}));

describe('Ledger Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let jsonFn: jest.Mock;
  let statusFn: jest.Mock;

  beforeEach(() => {
    jsonFn = jest.fn();
    statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    mockRequest = {};
    mockResponse = {
      status: statusFn,
      json: jsonFn,
      set: jest.fn(),
    };
    jest.clearAllMocks();
  });

  it('returns 200 with empty data when no ledger is found', async () => {
    (prisma.indexedLedger.findFirst as jest.Mock).mockResolvedValue(null);

    await httpGetLedgerStatus(mockRequest as Request, mockResponse as Response);

    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        ledger: 0,
        message: 'No ledgers indexed yet',
      }),
    }));
  });

  it('returns 200 with ledger data when a record exists', async () => {
    const mockLedger = {
      ledger: 12345,
      cursor: 'abc-123',
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    };
    (prisma.indexedLedger.findFirst as jest.Mock).mockResolvedValue(mockLedger);

    await httpGetLedgerStatus(mockRequest as Request, mockResponse as Response);

    expect(sendSuccess).toHaveBeenCalledWith(mockResponse, {
      ledger: mockLedger.ledger,
      cursor: mockLedger.cursor,
      updatedAt: mockLedger.updatedAt.toISOString(),
    });
  });

  it('returns 500 when database query fails', async () => {
    (prisma.indexedLedger.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

    await httpGetLedgerStatus(mockRequest as Request, mockResponse as Response);

    expect(statusFn).toHaveBeenCalledWith(500);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message: 'Failed to fetch ledger status',
    }));
  });
});
