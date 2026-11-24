import sharp from "sharp";

const MAX_WIDTH = 8000;
const MAX_HEIGHT = 8000;
const MAX_PIXELS = 40_000_000;

export async function sanitizeImage(buffer: Buffer): Promise<Buffer> {
  const image = sharp(buffer, {
    failOn: "error",
    limitInputPixels: MAX_PIXELS,
  });

  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid image.");
  }

  if (
    metadata.width > MAX_WIDTH ||
    metadata.height > MAX_HEIGHT ||
    metadata.width * metadata.height > MAX_PIXELS
  ) {
    throw new Error("Image dimensions exceed allowed limits.");
  }

  // Re-encode without carrying over EXIF/XMP/IPTC metadata.
  switch (metadata.format) {
    case "jpeg":
      return image.rotate().jpeg().toBuffer();

    case "png":
      return image.png().toBuffer();

    case "webp":
      return image.webp().toBuffer();

    default:
      throw new Error("Unsupported image format.");
  }
}