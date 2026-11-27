import { NextFunction, Request, Response } from 'express';
import {
   httpGetEmbedBadgeSvg,
   httpGetEmbedWidget,
} from './embed.controllers';
import { embedService } from './embed.service';

jest.mock('./embed.service', () => {
   const actual = jest.requireActual('./embed.service');
   return {
      ...actual,
      embedService: {
         getKeyEmbedData: jest.fn(),
         incrementWeeklyLoadCount: jest.fn(),
      },
   };
});

function createMockRes() {
   const headers: Record<string, string> = {};
   const send = jest.fn();
   const json = jest.fn();
   const status = jest.fn().mockReturnValue({ send, json });
   const setHeader = jest.fn((k: string, v: string) => {
      headers[k] = v;
   });
   const removeHeader = jest.fn((k: string) => {
      delete headers[k];
   });
   return {
      res: { status, setHeader, removeHeader, send, json } as unknown as Response,
      headers,
      status,
      send,
      json,
   };
}

describe('embed.controllers', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns 400 for unsupported metric or style values', async () => {
      const { res, status } = createMockRes();
      const next = jest.fn() as NextFunction;
      const req = {
         params: { handle: 'alice' },
         query: { metric: 'invalid_metric', style: 'flat' },
      } as unknown as Request;

      await httpGetEmbedBadgeSvg(req, res, next);
      expect(status).toHaveBeenCalledWith(400);

      const { res: res2, status: status2 } = createMockRes();
      const req2 = {
         params: { handle: 'alice' },
         query: { metric: 'price', style: 'invalid_style' },
      } as unknown as Request;

      await httpGetEmbedBadgeSvg(req2, res2, next);
      expect(status2).toHaveBeenCalledWith(400);
   });

   it('returns neutral placeholder and 5-minute cache header when embed is disabled', async () => {
      (embedService.getKeyEmbedData as jest.Mock).mockResolvedValue({
         found: true,
         enabled: false,
         creatorId: 'c1',
         allowedDomains: [],
         metricLabel: 'AccessLayer',
         metricValue: 'Unavailable',
      });

      const { res, headers, status, send } = createMockRes();
      const req = {
         params: { handle: 'alice' },
         query: { metric: 'price', style: 'rounded', theme: 'dark' },
      } as unknown as Request;

      await httpGetEmbedBadgeSvg(req, res, jest.fn());

      expect(status).toHaveBeenCalledWith(200);
      expect(headers['Cache-Control']).toBe('public, max-age=300');
      expect(headers['Content-Type']).toBe('image/svg+xml; charset=utf-8');
      expect(send.mock.calls[0][0]).toContain('Unavailable');
      expect(embedService.incrementWeeklyLoadCount).not.toHaveBeenCalled();
   });

   it('sets Content-Security-Policy frame-ancestors from allowlist on widget', async () => {
      (embedService.getKeyEmbedData as jest.Mock).mockResolvedValue({
         found: true,
         enabled: true,
         creatorId: 'c1',
         handle: 'alice',
         displayName: 'Alice',
         allowedDomains: ['https://creator.example'],
         metricLabel: 'alice price',
         metricValue: '2.5000 XLM',
      });

      const { res, headers, status, send } = createMockRes();
      const req = {
         params: { handle: 'alice' },
         query: { metric: 'price', theme: 'light' },
      } as unknown as Request;

      await httpGetEmbedWidget(req, res, jest.fn());

      expect(status).toHaveBeenCalledWith(200);
      expect(headers['Content-Security-Policy']).toBe(
         "frame-ancestors 'self' https://creator.example"
      );
      expect(send.mock.calls[0][0]).toContain('2.5000 XLM');
      expect(embedService.incrementWeeklyLoadCount).toHaveBeenCalledWith('c1');
   });
});
