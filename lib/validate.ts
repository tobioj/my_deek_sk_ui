// Checks folder lists sent by the browser: each must be an existing folder.
import "server-only";
import { assertFolder } from "./files";

export async function validFolders(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value.slice(0, 20)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const abs = await assertFolder(v); // throws "Folder not found: …"
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
}
