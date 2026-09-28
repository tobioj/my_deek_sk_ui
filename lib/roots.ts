// The folders DeepSeek can use in a chat, and how paths map onto them.
// With several folders, every path starts with the folder's short name ("backend/src/app.py").
import "server-only";
import path from "node:path";
import { assertFolder } from "./files";
import type { LinkedFolder } from "./folders";

export interface Root {
  name: string;
  abs: string; // real path on disk
  source: "project" | "chat";
}

// Folders that still exist on disk, in order. Missing ones (moved/deleted) are skipped.
export async function resolveRoots(folders: LinkedFolder[]): Promise<Root[]> {
  const roots: Root[] = [];
  for (const f of folders) {
    if (f.hidden) continue;
    try {
      const abs = await assertFolder(f.path);
      if (!roots.some((r) => r.abs === abs)) roots.push({ name: f.name, abs, source: f.source });
    } catch {}
  }
  return roots;
}

// Which folder a path belongs to, and the path inside it.
export function locate(roots: Root[], p: string): { root: Root; rel: string } {
  if (!roots.length) throw new Error("No folder is open");
  const raw = (p || ".").trim();
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const root = roots.find((r) => abs === r.abs || abs.startsWith(r.abs + path.sep));
    if (!root) throw new Error(`${raw} is outside the folders you can access`);
    return { root, rel: path.relative(root.abs, abs) || "." };
  }
  const cleaned = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
  const [first, ...rest] = cleaned.split("/");
  const named = roots.find((r) => r.name === first);
  if (named) return { root: named, rel: rest.join("/") || "." };
  if (roots.length === 1) return { root: roots[0], rel: cleaned || "." };
  throw new Error(`Start the path with one of the folder names: ${roots.map((r) => r.name).join(", ")}`);
}

// How a path is shown to DeepSeek and to you: prefixed with the folder name when there are several.
export function display(roots: Root[], root: Root, rel: string): string {
  const clean = rel === "." ? "" : rel.split(path.sep).join("/");
  if (roots.length === 1) return clean || ".";
  return clean ? `${root.name}/${clean}` : root.name;
}
