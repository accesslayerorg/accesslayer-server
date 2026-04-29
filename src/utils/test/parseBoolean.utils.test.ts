import {
  parseBoolean,
  parseBooleanWithDefault,
  ParseBooleanError,
} from '../parseBoolean.utils';

describe('parseBoolean()', () => {
  describe('true variants', () => {
    const trueInputs = ['true', '1'];

    trueInputs.forEach((input) => {
      it(`returns true for "${input}"`, () => {
        expect(parseBoolean('isVerified', input)).toBe(true);
      });

      it(`returns true for uppercase "${input.toUpperCase()}"`, () => {
        expect(parseBoolean('isVerified', input.toUpperCase())).toBe(true);
      });
    });
  });

  describe('false variants', () => {
    const falseInputs = ['false', '0'];

    falseInputs.forEach((input) => {
      it(`returns false for "${input}"`, () => {
        expect(parseBoolean('isVerified', input)).toBe(false);
      });

      it(`returns false for uppercase "${input.toUpperCase()}"`, () => {
        expect(parseBoolean('isVerified', input.toUpperCase())).toBe(false);
      });
    });
  });

  describe('absent parameter', () => {
    it('returns null when value is undefined', () => {
      expect(parseBoolean('isVerified', undefined)).toBeNull();
    });

    it('returns null when value is null', () => {
      expect(parseBoolean('isVerified', null)).toBeNull();
    });
  });

  describe('non-string boolean input', () => {
    it('passes through boolean values', () => {
      expect(parseBoolean('isVerified', true)).toBe(true);
      expect(parseBoolean('isVerified', false)).toBe(false);
    });
  });

  describe('whitespace trimming', () => {
    it('trims leading/trailing whitespace before parsing', () => {
      expect(parseBoolean('isVerified', '  true  ')).toBe(true);
      expect(parseBoolean('isVerified', '  false  ')).toBe(false);
    });
  });

  describe('array input', () => {
    it('uses the first element of an array', () => {
      expect(parseBoolean('isVerified', ['true', 'false'])).toBe(true);
      expect(parseBoolean('isVerified', ['false', 'true'])).toBe(false);
    });
  });

  describe('invalid values', () => {
    const invalidInputs = [
      'maybe',
      '2',
      '-1',
      'yes',
      'no',
      'on',
      'off',
      't',
      'f',
      '',
      ' ',
    ];

    invalidInputs.forEach((input) => {
      it(`throws ParseBooleanError for "${input}"`, () => {
        expect(() => parseBoolean('isVerified', input)).toThrow(
          ParseBooleanError
        );
      });
    });

    it('includes the param name in the error message', () => {
      expect(() => parseBoolean('isActive', 'maybe')).toThrow(/isActive/);
    });

    it('includes the raw value in the error message', () => {
      expect(() => parseBoolean('isActive', 'maybe')).toThrow(/maybe/);
    });

    it('includes accepted values hint in the error message', () => {
      expect(() => parseBoolean('isActive', 'bad')).toThrow(
        /Accepted values: "true", "false", "1", "0"\./
      );
    });

    it('sets rawValue on the error instance', () => {
      try {
        parseBoolean('isActive', 'bad');
      } catch (e) {
        expect(e).toBeInstanceOf(ParseBooleanError);
        expect((e as ParseBooleanError).rawValue).toBe('bad');
      }
    });

    it('sets paramName on the error instance', () => {
      try {
        parseBoolean('isActive', 'bad');
      } catch (e) {
        expect(e).toBeInstanceOf(ParseBooleanError);
        expect((e as ParseBooleanError).paramName).toBe('isActive');
      }
    });
  });
});

describe('parseBooleanWithDefault()', () => {
  it('returns the parsed value when present', () => {
    expect(parseBooleanWithDefault('isVerified', 'true', false)).toBe(true);
    expect(parseBooleanWithDefault('isVerified', 'false', true)).toBe(false);
  });

  it('returns the default when param is undefined', () => {
    expect(parseBooleanWithDefault('isVerified', undefined, false)).toBe(false);
    expect(parseBooleanWithDefault('isVerified', undefined, true)).toBe(true);
  });

  it('still throws ParseBooleanError for invalid values', () => {
    expect(() =>
      parseBooleanWithDefault('isVerified', 'maybe', false)
    ).toThrow(ParseBooleanError);
  });
});

describe('ParseBooleanError', () => {
  it('is an instance of Error', () => {
    const err = new ParseBooleanError('field', 'bad');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name ParseBooleanError', () => {
    const err = new ParseBooleanError('field', 'bad');
    expect(err.name).toBe('ParseBooleanError');
  });
});
