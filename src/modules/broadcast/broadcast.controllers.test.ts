import { NextFunction, Request, Response } from 'express';
import {
   httpCreateBroadcast,
   httpGetCreatorBroadcasts,
} from './broadcast.controllers';
import {
   BroadcastMonthlyLimitError,
   broadcastService,
} from './broadcast.service';

jest.mock('./broadcast.service', () => {
   const actual = jest.requireActual('./broadcast.service');
   return {
      ...actual,
      broadcastService: {
         createBroadcast: jest.fn(),
         getCreatorBroadcastsByHandle: jest.fn(),
      },
   };
});

function createMockRes() {
   const json = jest.fn();
   const status = jest.fn().mockReturnValue({ json });
   return {
      res: { status, json } as unknown as Response,
      status,
      json,
   };
}

describe('broadcast.controllers', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns 429 when creating a fifth broadcast in a calendar month', async () => {
      (broadcastService.createBroadcast as jest.Mock).mockRejectedValue(
         new BroadcastMonthlyLimitError()
      );

      const { res, status } = createMockRes();
      const req = {
         params: { id: 'key-1' },
         body: {
            subject: '5th broadcast',
            bodyHtml: '<p>Hello</p>',
         },
      } as unknown as Request;

      await httpCreateBroadcast(req, res, jest.fn() as NextFunction);

      expect(status).toHaveBeenCalledWith(429);
   });

   it('returns delivery statistics on GET /v1/creators/:handle/broadcasts', async () => {
      (
         broadcastService.getCreatorBroadcastsByHandle as jest.Mock
      ).mockResolvedValue({
         creator: { id: 'key-1', handle: 'alice', displayName: 'Alice' },
         broadcasts: [
            {
               id: 'b1',
               subject: 'Update',
               status: 'COMPLETED',
               stats: {
                  recipientCount: 10,
                  sentCount: 8,
                  failedCount: 0,
                  bouncedCount: 1,
                  suppressedCount: 1,
               },
            },
         ],
      });

      const { res, status, json } = createMockRes();
      const req = {
         params: { handle: 'alice' },
      } as unknown as Request;

      await httpGetCreatorBroadcasts(req, res, jest.fn() as NextFunction);

      expect(status).toHaveBeenCalledWith(200);
      expect(json.mock.calls[0][0].data.broadcasts[0].stats).toEqual({
         recipientCount: 10,
         sentCount: 8,
         failedCount: 0,
         bouncedCount: 1,
         suppressedCount: 1,
      });
   });
});
