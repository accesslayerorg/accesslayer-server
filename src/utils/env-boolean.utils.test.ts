import { normalizeEnvBoolean, EnvBooleanParseError } from './env-boolean.utils';

describe('normalizeEnvBoolean', () => {
  describe('true variants', () => {
    it.each([
      ['true'],
      ['True'],
      ['TRUE'],
      ['1'],
      ['yes'],
      ['Yes'],
      ['YES'],
    ])('returns true for "%s"', (value) => {
      expect(normalizeEnvBoolean('MY_FLAG', value)).toBe(true);
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(normalizeEnvBoolean('MY_FLAG', '  true  ')).toBe(true);
    });
  });

  describe('false variants', () => {
    it.each([
      ['false'],
      ['False'],
      ['FALSE'],
      ['0'],
      ['no'],
      ['No'],
      ['NO'],
    ])('returns false for "%s"', (value) => {
      expect(normalizeEnvBoolean('MY_FLAG', value)).toBe(false);
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(normalizeEnvBoolean('MY_FLAG', '  false  ')).toBe(false);
    });
  });

  describe('unrecognized values', () => {
    it.each([
      ['maybe'],
      ['2'],
      ['on'],
      ['off'],
      ['enabled'],
      ['disabled'],
      [''],
      ['null'],
      ['undefined'],
    ])('throws EnvBooleanParseError for "%s"', (value) => {
      expect(() => normalizeEnvBoolean('MY_FLAG', value)).toThrow(
        EnvBooleanParseError
      );
    });

    it('includes the env var name in the error message', () => {
      expect(() => normalizeEnvBoolean('FEATURE_FLAG', 'maybe')).toThrow(
        /FEATURE_FLAG/
      );
    });

    it('includes the raw value in the error message', () => {
      expect(() => normalizeEnvBoolean('FEATURE_FLAG', 'banana')).toThrow(
        /banana/
      );
    });

    it('exposes varName and rawValue on the thrown error', () => {
      let caught: unknown;
      try {
        normalizeEnvBoolean('MY_VAR', 'oops');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvBooleanParseError);
      const error = caught as EnvBooleanParseError;
      expect(error.varName).toBe('MY_VAR');
      expect(error.rawValue).toBe('oops');
    });
  });
});
