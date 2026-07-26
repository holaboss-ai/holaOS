import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HEIC_ATTACHMENT_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
]);

const SIPS_BINARY_PATH = "/usr/bin/sips";
const SIPS_JPEG_QUALITY = "85";

export const HEIC_CONVERSION_OUTPUT_EXTENSION = ".jpg";
export const HEIC_CONVERSION_OUTPUT_MIME_TYPE = "image/jpeg";

export function isHeicAttachmentMimeType(mimeType: string): boolean {
  return HEIC_ATTACHMENT_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function replaceAttachmentExtension(
  name: string,
  extension: string,
): string {
  const normalizedExtension = extension.startsWith(".")
    ? extension
    : `.${extension}`;
  const parsed = path.parse(path.basename(name));
  return `${parsed.name || "attachment"}${normalizedExtension}`;
}

function normalizeHeicConversionError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("sips HEIC conversion failed");
  }
  const stdout =
    typeof (error as { stdout?: string }).stdout === "string"
      ? (error as { stdout?: string }).stdout?.trim()
      : "";
  const stderr =
    typeof (error as { stderr?: string }).stderr === "string"
      ? (error as { stderr?: string }).stderr?.trim()
      : "";
  const detail = stderr || stdout || error.message;
  return new Error(`sips HEIC conversion failed: ${detail}`);
}

function assertHeicConversionSupport() {
  if (process.platform !== "darwin") {
    throw new Error("HEIC conversion requires macOS");
  }
}

export async function convertHeicFileToJpeg(params: {
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  assertHeicConversionSupport();
  try {
    await execFileAsync(SIPS_BINARY_PATH, [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      SIPS_JPEG_QUALITY,
      params.sourcePath,
      "--out",
      params.targetPath,
    ]);
  } catch (error) {
    throw normalizeHeicConversionError(error);
  }
}

export async function convertHeicBufferToJpeg(params: {
  bytes: Buffer;
  sourceName: string;
  targetPath: string;
}): Promise<void> {
  assertHeicConversionSupport();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-heic-"));
  const sourcePath = path.join(
    tempDir,
    replaceAttachmentExtension(params.sourceName, ".heic"),
  );
  try {
    await fs.writeFile(sourcePath, params.bytes);
    await convertHeicFileToJpeg({
      sourcePath,
      targetPath: params.targetPath,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
