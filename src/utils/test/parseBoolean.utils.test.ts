import {
  parseBoolean,
  parseBooleanWithDefault,
  ParseBooleanError,
} from "../parseBoolean.utils";

// ---------------------------------------------------------------------------
// parseBoolean()
// ---------------------------------------------------------------------------

describe("parseBoolean()", () => {

  // ── True variants ────────────────────────────────────────────────────────

  describe("true variants", () => {
    const trueInputs = ["true", "1", "yes", "on"];

    trueInputs.forEach((input) => {
      it(`returns true for "${input}"`, () => {
        expect(parseBoolean("isVerified", input)).toBe(true);
      });

      it(`returns true for uppercase "${input.toUpperCase()}"`, () => {
        expect(parseBoolean("isVerified", input.toUpperCase())).toBe(true);
      });

      it(`returns true for mixed-case "${input[0].toUpperCase() + input.slice(1)}"`, () => {
        expect(
          parseBoolean("isVerified", input[0].toUpperCase() + input.slice(1))
        ).toBe(true);
      });
    });
  });

  // ── False variants ───────────────────────────────────────────────────────

  describe("false variants", () => {
    const falseInputs = ["false", "0", "no", "off"];

    falseInputs.forEach((input) => {
      it(`returns false for "${input}"`, () => {
        expect(parseBoolean("isVerified", input)).toBe(false);
      });

      it(`returns false for uppercase "${input.toUpperCase()}"`, () => {
        expect(parseBoolean("isVerified", input.toUpperCase())).toBe(false);
      });
    });
  });

  // ── Absent parameter ─────────────────────────────────────────────────────

  describe("absent parameter", () => {
    it("returns null when value is undefined", () => {
      expect(parseBoolean("isVerified", undefined)).toBeNull();
    });
  });

  // ── Whitespace handling ──────────────────────────────────────────────────

  describe("whitespace trimming", () => {
    it("trims leading/trailing whitespace before parsing", () => {
      expect(parseBoolean("isVerified", "  true  ")).toBe(true);
      expect(parseBoolean("isVerified", "  false  ")).toBe(false);
    });
  });

  // ── Array input (req.query returns string[] sometimes) ──────────────────

  describe("array input", () => {
    it("uses the first element of an array", () => {
      expect(parseBoolean("isVerified", ["true", "false"])).toBe(true);
      expect(parseBoolean("isVerified", ["false", "true"])).toBe(false);
    });
  });

  // ── Invalid values ───────────────────────────────────────────────────────

  describe("invalid values", () => {
    const invalidInputs = [
      "maybe",
      "2",
      "-1",
      "t",
      "f",
      "y",
      "n",
      "enabled",
      "disabled",
      "TRUE_VAL",
      "",          // empty string after trim is still invalid
      " ",         // whitespace-only
    ];

    invalidInputs.forEach((input) => {
      it(`throws ParseBooleanError for "${input}"`, () => {
        expect(() => parseBoolean("isVerified", input)).toThrow(
          ParseBooleanError
        );
      });
    });

    it("includes the param name in the error message", () => {
      expect(() => parseBoolean("isActive", "maybe")).toThrow(
        /isActive/
      );
    });

    it("includes the raw value in the error message", () => {
      expect(() => parseBoolean("isActive", "maybe")).toThrow(
        /maybe/
      );
    });

    it("includes accepted values hint in the error message", () => {
      expect(() => parseBoolean("isActive", "bad")).toThrow(
        /Accepted values/
      );
    });

    it("sets rawValue on the error instance", () => {
      try {
        parseBoolean("isActive", "bad");
      } catch (e) {
        expect(e).toBeInstanceOf(ParseBooleanError);
        expect((e as ParseBooleanError).rawValue).toBe("bad");
      }
    });

    it("sets paramName on the error instance", () => {
      try {
        parseBoolean("isActive", "bad");
      } catch (e) {
        expect(e).toBeInstanceOf(ParseBooleanError);
        expect((e as ParseBooleanError).paramName).toBe("isActive");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// parseBooleanWithDefault()
// ---------------------------------------------------------------------------

describe("parseBooleanWithDefault()", () => {
  it("returns the parsed value when present", () => {
    expect(parseBooleanWithDefault("isVerified", "true", false)).toBe(true);
    expect(parseBooleanWithDefault("isVerified", "false", true)).toBe(false);
  });

  it("returns the default when param is undefined", () => {
    expect(parseBooleanWithDefault("isVerified", undefined, false)).toBe(false);
    expect(parseBooleanWithDefault("isVerified", undefined, true)).toBe(true);
  });

  it("still throws ParseBooleanError for invalid values", () => {
    expect(() =>
      parseBooleanWithDefault("isVerified", "maybe", false)
    ).toThrow(ParseBooleanError);
  });
});

// ---------------------------------------------------------------------------
// ParseBooleanError
// ---------------------------------------------------------------------------

describe("ParseBooleanError", () => {
  it("is an instance of Error", () => {
    const err = new ParseBooleanError("field", "bad");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name ParseBooleanError", () => {
    const err = new ParseBooleanError("field", "bad");
    expect(err.name).toBe("ParseBooleanError");
  });
});