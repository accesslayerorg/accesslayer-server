import Handlebars from "handlebars";
import { templateRegistry } from "./template.registry";
import {
  RenderedTemplate,
  SupportedLocale,
  TemplateContent,
  TemplateVariables,
} from "./template.types";
import { validateRequiredVariables } from "./template.validation";

type TemplateStore = Record<
  SupportedLocale,
  Record<string, TemplateContent>
>;

const DEFAULT_LOCALE: SupportedLocale = "en";

export class TemplateService {
  constructor(
    private readonly templates: TemplateStore,
    private readonly logger: {
      warn: (message: string, meta?: Record<string, unknown>) => void;
    },
  ) {}

  render(
    templateId: string,
    locale: string,
    variables: TemplateVariables,
  ): RenderedTemplate {
    const metadata = templateRegistry[templateId];

    if (!metadata) {
      throw new Error("Unknown notification template.");
    }

    validateRequiredVariables(metadata, variables);

    const requestedLocale = this.normalizeLocale(locale);
    const localized = this.templates[requestedLocale]?.[templateId];
    const english = this.templates[DEFAULT_LOCALE]?.[templateId];

    if (!english) {
      throw new Error("Default template is unavailable.");
    }

    const fallbackUsed = !localized;

    if (fallbackUsed) {
      // Never log user variables, emails, payroll details, or rendered content.
      this.logger.warn("Notification template locale fallback used.", {
        templateId,
        requestedLocale,
        fallbackLocale: DEFAULT_LOCALE,
      });
    }

    const content = localized ?? english;

    return {
      templateId,
      locale: localized ? requestedLocale : DEFAULT_LOCALE,
      requestedLocale,
      fallbackUsed,
      subject: this.renderField(content.subject, variables),
      title: this.renderField(content.title, variables),
      body: this.renderField(content.body, variables),
    };
  }

  private renderField(
    template: string | undefined,
    variables: TemplateVariables,
  ): string | undefined {
    if (template === undefined) {
      return undefined;
    }

    // Handlebars normal interpolation escapes HTML.
    return Handlebars.compile(template, {
      strict: true,
    })(variables);
  }

  private normalizeLocale(locale: string): SupportedLocale {
    const normalized = locale.toLowerCase().split(/[-_]/)[0];

    if (normalized === "es" || normalized === "fr" || normalized === "en") {
      return normalized;
    }

    return DEFAULT_LOCALE;
  }
}