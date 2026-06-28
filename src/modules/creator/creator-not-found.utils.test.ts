// src/modules/creator/creator-not-found.utils.test.ts
import { sendCreatorNotFound } from './creator-not-found.utils';
import { sendError } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';

jest.mock('../../utils/api-response.utils', () => ({
  sendError: jest.fn(),
}));

function makeRes(): any {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('sendCreatorNotFound', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('calls sendError with status 404', () => {
    const res = makeRes();
    sendCreatorNotFound(res);
    expect(sendError).toHaveBeenCalledWith(
      res,
      404,
      ErrorCode.NOT_FOUND,
      'Creator not found'
    );
  });

  it('uses the NOT_FOUND error code from shared constants', () => {
    const res = makeRes();
    sendCreatorNotFound(res);
    const [, , code] = (sendError as jest.Mock).mock.calls[0];
    expect(code).toBe(ErrorCode.NOT_FOUND);
  });

  it('returns void', () => {
    const res = makeRes();
    const result = sendCreatorNotFound(res);
    expect(result).toBeUndefined();
  });
});
