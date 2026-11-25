export type SupportedLocale = "en" | "es" | "fr";

export type TemplateChannel = "email" | "notification";

export interface NotificationTemplate {
  id: string;
  channels: TemplateChannel[];
  requiredVariables: string[];
}

export interface TemplateContent {
  subject?: string;
  title?: string;
  body: string;
}

export interface RenderedTemplate {
  templateId: string;
  locale: SupportedLocale;
  requestedLocale: SupportedLocale;
  fallbackUsed: boolean;
  subject?: string;
  title?: string;
  body: string;
}

export type TemplateVariables = Record<string, string | number>;