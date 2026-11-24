import { sniffAttachmentContent } from "../../modules/support/attachment-policy.utils";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function detectAndValidateFileType(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<string> {
  const detected = sniffAttachmentContent(buffer);

  if (detected.kind !== "allowed" || !ALLOWED_TYPES.has(detected.contentType)) {
    throw new Error("Unsupported file type.");
  }

  if (detected.contentType !== declaredMimeType.toLowerCase()) {
    throw new Error("File type does not match its content.");
  }

  return detected.contentType;
}