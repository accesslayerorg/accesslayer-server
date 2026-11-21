import { httpGetVolumeLeaderboard } from './creator-leaderboard-volume.controller';
import * as service from './creator-leaderboard-volume.service';
import type { VolumeLeaderboardEntry } from './creator-leaderboard-volume.service';

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

const ENTRY: VolumeLeaderboardEntry = {
   rank: 1,
   keyId: 'creator-a',
   creatorName: 'Alice',
   avatarUrl: null,
   totalVolume: '1000',
   priceChange24h: 5,
};

describe('GET /api/v1/creators/leaderboard/volume', () => {
   afterEach(() => jest.restoreAllMocks());

   it('returns the leaderboard items wrapped in a success envelope', async () => {
      jest.spyOn(service, 'getVolumeLeaderboard').mockResolvedValue([ENTRY]);

      const req: any = {};
      const res = makeRes();
      const next = jest.fn();
      await httpGetVolumeLeaderboard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toEqual([ENTRY]);
   });

   it('returns an empty items array when there is no volume', async () => {
      jest.spyOn(service, 'getVolumeLeaderboard').mockResolvedValue([]);

      const req: any = {};
      const res = makeRes();
      const next = jest.fn();
      await httpGetVolumeLeaderboard(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toEqual([]);
   });

   it('forwards errors to next()', async () => {
      const err = new Error('db down');
      jest.spyOn(service, 'getVolumeLeaderboard').mockRejectedValue(err);

      const req: any = {};
      const res = makeRes();
      const next = jest.fn();
      await httpGetVolumeLeaderboard(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.json).not.toHaveBeenCalled();
   });
});
