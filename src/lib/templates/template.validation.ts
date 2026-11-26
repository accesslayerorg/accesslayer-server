import { NotificationTemplate, TemplateVariables } from "./template.types";

/**
 * Throws when any variable the template declares as required is absent or
 * empty. Only variable names are reported, never their values.
 */
export function validateRequiredVariables(
  template: NotificationTemplate,
  variables: TemplateVariables,
): void {
  const missing = template.requiredVariables.filter(
    (name) => variables[name] === undefined || variables[name] === "",
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required template variables: ${missing.join(", ")}`,
    );
  }
}
