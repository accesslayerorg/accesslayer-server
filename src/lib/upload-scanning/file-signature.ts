import { fileTypeFromBuffer } from "file-type";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function detectAndValidateFileType(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);

  if (!detected || !ALLOWED_TYPES.has(detected.mime)) {
    throw new Error("Unsupported file type.");
  }

  if (detected.mime !== declaredMimeType.toLowerCase()) {
    throw new Error("File type does not match its content.");
  }

  return detected.mime;
}