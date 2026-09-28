import { nanoid } from "nanoid";
import type { ProjectFile } from "@/lib/types";

const MAX_FILES = 50;
const MAX_FILE_CHARS = 500_000;

// Keep only well-formed text files, with sane limits.
export function cleanFiles(files: unknown): ProjectFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is ProjectFile => !!f && typeof f.name === "string" && typeof f.content === "string")
    .slice(0, MAX_FILES)
    .map((f) => {
      const content = f.content.slice(0, MAX_FILE_CHARS);
      return { id: typeof f.id === "string" && f.id ? f.id : nanoid(10), name: f.name.slice(0, 200), content, size: content.length };
    });
}

export function repoList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((r): r is string => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 100);
}
