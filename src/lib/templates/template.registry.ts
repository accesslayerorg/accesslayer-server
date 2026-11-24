import { NotificationTemplate } from "./template.types";

export const templateRegistry: Record<string, NotificationTemplate> = {
  welcome: {
    id: "welcome",
    channels: ["email", "notification"],
    requiredVariables: ["name"],
  },

  "payroll-completed": {
    id: "payroll-completed",
    channels: ["email", "notification"],
    requiredVariables: ["name", "period"],
  },
};