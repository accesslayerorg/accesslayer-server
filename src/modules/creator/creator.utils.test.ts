import { handleCreatorParamNotFound } from './creator.utils';
import { sendNotFound } from '../../utils/api-response.utils';

jest.mock('../../utils/api-response.utils', () => ({
   sendNotFound: jest.fn(),
}));

function makeRes(): any {
   return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('handleCreatorParamNotFound', () => {
   beforeEach(() => {
      jest.resetAllMocks();
   });

   it('returns false and sends 404 when result is null', () => {
      const res = makeRes();
      const result = null;

      const ok = handleCreatorParamNotFound(res, result);

      expect(ok).toBe(false);
      expect(sendNotFound).toHaveBeenCalledWith(res, 'Creator');
   });

   it('returns true and does not send error when result exists', () => {
      const res = makeRes();
      const result = { id: 'creator-123', handle: 'alice' };

      const ok = handleCreatorParamNotFound(res, result);

      expect(ok).toBe(true);
      expect(sendNotFound).not.toHaveBeenCalled();
   });

   it('narrows type so caller can access id after check', () => {
      const res = makeRes();
      const result = { id: 'creator-123', handle: 'alice' };

      if (!handleCreatorParamNotFound(res, result)) {
         throw new Error('Should not reach here');
      }

      expect(result.id).toBe('creator-123');
      expect(result.handle).toBe('alice');
   });
});