import fs from "node:fs/promises";

import JSZip from "jszip";

export type ArchivePathCandidate = {
  archivePath: string;
  subPath: string;
};

export type ArchiveNode = {
  path: string;
  isDirectory: boolean;
  size: number;
};

export type ArchiveDirectoryEntry = ArchiveNode & {
  name: string;
};

export type ExtractedArchiveFile = ArchiveNode & {
  bytes: Uint8Array;
};

type ArchiveIndexEntry = ArchiveNode & {
  entryName: string;
};

function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
  if (!rawPath) {
    return "";
  }
  const parts = rawPath.replace(/\\/g, "/").split("/");
  const normalizedParts: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      return undefined;
    }
    normalizedParts.push(part);
  }
  return normalizedParts.join("/");
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
  const normalized = normalizeArchiveLookupPath(rawPath);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
  const normalized = filePath.replace(/\\/g, "/");
  const pattern = /\.zip(?=(?::|$))/gi;
  const candidates: ArchivePathCandidate[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const end = match.index + match[0].length;
    const archivePath = filePath.slice(0, end);
    const subPath = normalized.slice(end).replace(/^:+/, "");
    const key = `${archivePath}\0${subPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ archivePath, subPath });
  }

  return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

function ensureParentDirectories(entries: Map<string, ArchiveIndexEntry>): void {
  for (const entry of [...entries.values()]) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const dirPath = parts.slice(0, index).join("/");
      if (!dirPath || entries.has(dirPath)) {
        continue;
      }
      entries.set(dirPath, {
        path: dirPath,
        isDirectory: true,
        size: 0,
        entryName: `${dirPath}/`,
      });
    }
  }
}

export class ZipArchiveReader {
  #zip: JSZip;
  #entries = new Map<string, ArchiveIndexEntry>();

  constructor(zip: JSZip) {
    this.#zip = zip;
    for (const [rawPath, entry] of Object.entries(zip.files)) {
      const normalizedPath = normalizeArchiveEntryPath(rawPath);
      if (!normalizedPath) {
        continue;
      }
      this.#entries.set(normalizedPath, {
        path: normalizedPath,
        isDirectory: entry.dir,
        size: 0,
        entryName: rawPath,
      });
    }
    ensureParentDirectories(this.#entries);
  }

  getNode(subPath?: string): ArchiveNode | undefined {
    const normalizedPath = normalizeArchiveLookupPath(subPath);
    if (normalizedPath === undefined) {
      return undefined;
    }
    if (normalizedPath === "") {
      return { path: "", isDirectory: true, size: 0 };
    }
    const entry = this.#entries.get(normalizedPath);
    if (!entry) {
      return undefined;
    }
    return {
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
    };
  }

  listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
    const normalizedPath = normalizeArchiveLookupPath(subPath);
    if (normalizedPath === undefined) {
      throw new Error("Archive path cannot contain '..'");
    }
    if (normalizedPath) {
      const current = this.#entries.get(normalizedPath);
      if (!current) {
        throw new Error(`Archive path '${normalizedPath}' not found`);
      }
      if (!current.isDirectory) {
        throw new Error(`Archive path '${normalizedPath}' is not a directory`);
      }
    }

    const prefix = normalizedPath ? `${normalizedPath}/` : "";
    const children = new Map<string, ArchiveDirectoryEntry>();
    for (const entry of this.#entries.values()) {
      if (normalizedPath) {
        if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) {
          continue;
        }
      }
      const relativePath = normalizedPath ? entry.path.slice(prefix.length) : entry.path;
      const nextSegment = relativePath.split("/")[0];
      if (!nextSegment) {
        continue;
      }
      const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
      if (children.has(childPath)) {
        continue;
      }
      const childEntry = this.#entries.get(childPath);
      const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
      children.set(childPath, {
        name: nextSegment,
        path: childPath,
        isDirectory,
        size: isDirectory ? 0 : (childEntry?.size ?? 0),
      });
    }
    return [...children.values()].sort((left, right) =>
      left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    );
  }

  listFiles(subPath?: string): ArchiveNode[] {
    const normalizedPath = normalizeArchiveLookupPath(subPath);
    if (normalizedPath === undefined) {
      throw new Error("Archive path cannot contain '..'");
    }
    const prefix = normalizedPath ? `${normalizedPath}/` : "";
    const files: ArchiveNode[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.isDirectory) {
        continue;
      }
      if (normalizedPath) {
        if (entry.path !== normalizedPath && !entry.path.startsWith(prefix)) {
          continue;
        }
      }
      files.push({
        path: entry.path,
        isDirectory: false,
        size: entry.size,
      });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  }

  async readFile(subPath: string): Promise<ExtractedArchiveFile> {
    const normalizedPath = normalizeArchiveLookupPath(subPath);
    if (!normalizedPath) {
      throw new Error("Archive file path is required");
    }
    const entry = this.#entries.get(normalizedPath);
    if (!entry) {
      throw new Error(`Archive file '${normalizedPath}' not found`);
    }
    if (entry.isDirectory) {
      throw new Error(`Archive path '${normalizedPath}' is a directory`);
    }
    const zipEntry = this.#zip.file(entry.entryName);
    if (!zipEntry) {
      throw new Error(`Archive file '${normalizedPath}' has no readable storage`);
    }
    const bytes = await zipEntry.async("uint8array");
    entry.size = bytes.byteLength;
    return {
      path: entry.path,
      isDirectory: false,
      size: entry.size,
      bytes,
    };
  }
}

export async function openArchive(filePath: string): Promise<ZipArchiveReader> {
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes);
  return new ZipArchiveReader(zip);
}
