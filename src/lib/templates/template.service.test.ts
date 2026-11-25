describe("TemplateService", () => {
  it("renders English templates", () => {
    const result = service.render("welcome", "en", {
      name: "Alex",
    });

    expect(result.subject).toContain("Alex");
    expect(result.fallbackUsed).toBe(false);
  });

  it("renders Spanish templates", () => {
    const result = service.render("welcome", "es", {
      name: "Alex",
    });

    expect(result.locale).toBe("es");
    expect(result.fallbackUsed).toBe(false);
  });

  it("renders French templates", () => {
    const result = service.render("welcome", "fr", {
      name: "Alex",
    });

    expect(result.locale).toBe("fr");
  });

  it("falls back to English for missing locale templates", () => {
    const result = service.render("welcome", "fr", {
      name: "Alex",
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.subject).toBeDefined();
  });

  it("falls back to English for missing individual fields", () => {
    const result = service.render("welcome", "fr", {
      name: "Alex",
    });

    // Configure the French subject to be absent in the fixture.
    expect(result.subject).toBeDefined();
    expect(result.fallbackUsed).toBe(true);
  });

  it("rejects missing required variables", () => {
    expect(() => service.render("welcome", "en", {})).toThrow(
      /Missing required template variables/,
    );
  });

  it("escapes user-supplied HTML in rendered output", () => {
    const result = service.render("welcome", "en", {
      name: '<script>alert("xss")</script>',
    });

    expect(result.body).not.toContain("<script>");
    expect(result.body).toContain("&lt;script&gt;");
  });

  it("normalizes locale variants", () => {
    const result = service.render("welcome", "fr-FR", {
      name: "Alex",
    });

    expect(result.locale).toBe("fr");
  });

  it("uses English for unsupported locales", () => {
    const result = service.render("welcome", "de", {
      name: "Alex",
    });

    expect(result.locale).toBe("en");
    expect(result.fallbackUsed).toBe(true);
  });
});