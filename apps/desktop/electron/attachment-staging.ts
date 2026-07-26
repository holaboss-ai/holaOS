import path from "node:path";

const IMAGE_MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".md", "text/markdown"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".js", "text/javascript"],
  [".jsx", "text/jsx"],
  [".css", "text/css"],
  [".html", "text/html"],
]);

const PREVIEWABLE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
]);

const HEIF_BRANDS = new Set([
  "heif",
  "mif1",
  "msf1",
]);

const AVIF_BRANDS = new Set([
  "avif",
  "avis",
]);

export function fallbackAttachmentMimeType(
  name: string,
  mimeType?: string | null,
): string {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") {
    return normalized;
  }
  return (
    IMAGE_MIME_TYPES_BY_EXTENSION.get(path.extname(name).toLowerCase()) ??
    "application/octet-stream"
  );
}

export function detectAttachmentMimeTypeFromBytes(
  bytes: Uint8Array,
): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 2 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x4d
  ) {
    return "image/bmp";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
      .trim()
      .toLowerCase();
    if (HEIC_BRANDS.has(brand)) {
      return "image/heic";
    }
    if (HEIF_BRANDS.has(brand)) {
      return "image/heif";
    }
    if (AVIF_BRANDS.has(brand)) {
      return "image/avif";
    }
  }
  return null;
}

export function resolveStagedAttachmentMimeType(params: {
  name: string;
  declaredMimeType?: string | null;
  bytes: Uint8Array;
}): string {
  const normalized = (params.declaredMimeType ?? "").trim().toLowerCase();
  const detected = detectAttachmentMimeTypeFromBytes(params.bytes);
  if (detected) {
    return detected;
  }
  const fallback = fallbackAttachmentMimeType(params.name, params.declaredMimeType);
  if (
    normalized.startsWith("image/") &&
    normalized !== "image/svg+xml" &&
    !PREVIEWABLE_IMAGE_MIME_TYPES.has(normalized)
  ) {
    return "application/octet-stream";
  }
  if (
    fallback.startsWith("image/") &&
    fallback !== "image/svg+xml" &&
    !PREVIEWABLE_IMAGE_MIME_TYPES.has(fallback)
  ) {
    return "application/octet-stream";
  }
  if (normalized.startsWith("image/") && normalized !== "image/svg+xml") {
    return "application/octet-stream";
  }
  if (fallback.startsWith("image/") && fallback !== "image/svg+xml") {
    return "application/octet-stream";
  }
  return fallback;
}

export function stagedAttachmentKind(
  mimeType: string,
): "image" | "file" {
  return PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase())
    ? "image"
    : "file";
}
