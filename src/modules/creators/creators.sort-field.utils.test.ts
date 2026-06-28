import {
   getRawCreatorListSortParam,
   isRecognizedCreatorListSortField,
   warnIfUnrecognizedCreatorListSort,
} from './creators.sort-field.utils';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn() },
}));

const warnMock = logger.warn as jest.Mock;

beforeEach(() => {
   warnMock.mockClear();
});

describe('isRecognizedCreatorListSortField()', () => {
   it('accepts allowed public sort fields', () => {
      expect(isRecognizedCreatorListSortField('createdAt')).toBe(true);
      expect(isRecognizedCreatorListSortField('displayName')).toBe(true);
   });

   it('rejects values outside the allowed set', () => {
      expect(isRecognizedCreatorListSortField('invalidField')).toBe(false);
   });
});

describe('getRawCreatorListSortParam()', () => {
   it('reads a string sort query param', () => {
      expect(getRawCreatorListSortParam({ sort: 'handle' })).toBe('handle');
   });

   it('reads the first value when sort is an array', () => {
      expect(getRawCreatorListSortParam({ sort: ['followers', 'createdAt'] })).toBe(
         'followers'
      );
   });
});

describe('warnIfUnrecognizedCreatorListSort()', () => {
   it('emits a warn log with the raw sort value and request id', () => {
      warnIfUnrecognizedCreatorListSort(
         { sort: 'invalidField' },
         'req-sort-123'
      );

      expect(warnMock).toHaveBeenCalledWith({
         msg: 'Unrecognized creator list sort field',
         sort: 'invalidField',
         requestId: 'req-sort-123',
      });
   });

   it('does not log for recognized sort fields', () => {
      warnIfUnrecognizedCreatorListSort({ sort: 'createdAt' }, 'req-ok');
      expect(warnMock).not.toHaveBeenCalled();
   });

   it('does not log when sort is omitted', () => {
      warnIfUnrecognizedCreatorListSort({}, 'req-ok');
      expect(warnMock).not.toHaveBeenCalled();
   });

   it('does not log for whitespace-only sort (treated as omitted)', () => {
      warnIfUnrecognizedCreatorListSort({ sort: '   ' }, 'req-ok');
      expect(warnMock).not.toHaveBeenCalled();
   });
});
