/**
 * FileBrandIcon — renders the official Microsoft Office brand mark for
 * Office file types (xlsx/docx/pptx and friends). Brand SVGs live in
 * src/assets/file-types/ as self-contained, multi-color gradient marks.
 * Anything we don't have a brand icon for falls back to FileTypeIcon.
 */

import { useId } from "react";
import excelMarkup from "@/assets/file-types/excel.svg?raw";
import powerpointMarkup from "@/assets/file-types/powerpoint.svg?raw";
import wordMarkup from "@/assets/file-types/word.svg?raw";
import { FileTypeIcon } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

const OFFICE_ICON_MARKUP: Record<string, string> = {
  ".xls": excelMarkup,
  ".xlsx": excelMarkup,
  ".xlsm": excelMarkup,
  ".xlsb": excelMarkup,
  ".csv": excelMarkup,
  ".tsv": excelMarkup,
  ".doc": wordMarkup,
  ".docx": wordMarkup,
  ".ppt": powerpointMarkup,
  ".pptx": powerpointMarkup,
};

function fileExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex).toLowerCase() : "";
}

export function hasOfficeBrandIcon(filePath: string | null | undefined): boolean {
  return Boolean(filePath) && fileExtension(filePath as string) in OFFICE_ICON_MARKUP;
}

interface FileBrandIconProps {
  filePath: string;
  size?: number;
  className?: string;
}

export function FileBrandIcon({
  filePath,
  size = 18,
  className,
}: FileBrandIconProps) {
  // The brand SVGs share a hardcoded `SVGID_1_` gradient id. This markup is
  // injected inline once per icon, so several Office icons on one screen would
  // collide on that id and steal each other's gradient. Rewrite it to a unique
  // id per instance (colon-stripped — invalid inside url(#...)).
  const gradientId = `office-grad-${useId().replace(/:/g, "")}`;
  const markup = OFFICE_ICON_MARKUP[fileExtension(filePath)];
  if (!markup) {
    return <FileTypeIcon className={className} filePath={filePath} size={size} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("block [&_svg]:h-full [&_svg]:w-full", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: bundled, sanitized brand SVGs
      dangerouslySetInnerHTML={{ __html: markup.replaceAll("SVGID_1_", gradientId) }}
      style={{ width: size, height: size }}
    />
  );
}
