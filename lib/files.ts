// Server-side file access: folder maps, reading files, searching.
// Ported from chat.py's folder_tree / read_files, with the same skip rules.
import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import type { FolderFile, FolderScan } from "./types";
import { isBinaryName, isSecretFile, isSkippedDir, skipReason, truncateText } from "./skip";

const MAX_SCAN_FILES = 5000;

export function expandHome(p: string): string {
  const trimmed = p.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export async function assertFolder(p: string): Promise<string> {
  const abs = path.resolve(expandHome(p));
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`Folder not found: ${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${abs}`);
  return fs.realpath(abs);
}

const toPosix = (p: string) => p.split(path.sep).join("/");

// Resolve a path the model (or browser) asked for, making sure it stays inside root.
export async function resolveInside(root: string, rel: string): Promise<string> {
  const cleaned = (rel || ".").replace(/^\/+/, "");
  const candidate = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, cleaned);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new Error(`Not found: ${rel}`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`Access denied: ${rel} is outside the project folder`);
  }
  return real;
}

interface WalkEntry {
  rel: string;
  size: number;
}

// Walk a folder, skipping junk directories. Stops after `limit` files.
async function walk(root: string, start: string, limit: number, maxDepth = Infinity): Promise<{ files: WalkEntry[]; truncated: boolean }> {
  const files: WalkEntry[] = [];
  let truncated = false;
  async function visit(dir: string, depth: number) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isSkippedDir(e.name) && depth < maxDepth) await visit(full, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {}
        files.push({ rel: toPosix(path.relative(root, full)), size });
      }
    }
  }
  await visit(start, 0);
  return { files, truncated };
}

// A simple map of the folder, like the Explorer sidebar in VS Code.
export async function folderTree(root: string, sub = ".", maxDepth = 3, maxLines = 400): Promise<string> {
  const start = await resolveInside(root, sub);
  const lines: string[] = [(sub === "." ? path.basename(root) : toPosix(path.relative(root, start))) + "/"];
  let count = 0;
  let cut = false;
  async function visit(dir: string, depth: number) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const indent = "    ".repeat(depth + 1);
    for (const d of dirs) {
      if (count >= maxLines) return void (cut = true);
      if (isSkippedDir(d.name)) {
        lines.push(`${indent}${d.name}/ (skipped)`);
        count++;
        continue;
      }
      lines.push(`${indent}${d.name}/`);
      count++;
      if (depth + 1 < maxDepth) await visit(path.join(dir, d.name), depth + 1);
      else lines.push(`${indent}    …`);
    }
    for (const f of files) {
      if (count >= maxLines) return void (cut = true);
      lines.push(`${indent}${f.name}`);
      count++;
    }
  }
  await visit(start, 0);
  if (cut) lines.push(`… (map cut off at ${maxLines} entries — ask for a subfolder to see more)`);
  return lines.join("\n");
}

// Everything the folder picker needs: the map plus a checklist of files.
export async function scanFolder(input: string): Promise<FolderScan> {
  const root = await assertFolder(input);
  const [{ files, truncated }, tree] = await Promise.all([walk(root, root, MAX_SCAN_FILES), folderTree(root)]);
  const list: FolderFile[] = files.map((f) => {
    const reason = skipReason(f.rel, f.size);
    return { path: f.rel, size: f.size, text: !isBinaryName(f.rel) && !isSecretFile(f.rel), ...(reason ? { skipped: reason } : {}) };
  });
  return { root, name: path.basename(root), tree, files: list, truncated };
}

// Read a file as text. Refuses secrets and binary files.
export async function readText(abs: string, maxChars: number): Promise<{ text: string; truncated: boolean; lines: number }> {
  if (isSecretFile(abs)) throw new Error(`${path.basename(abs)} may contain secrets, so it can't be read`);
  if (isBinaryName(abs)) throw new Error(`${path.basename(abs)} is not a text file`);
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${path.basename(abs)} looks like a binary file`);
  const raw = buf.toString("utf8");
  const { text, truncated } = truncateText(raw, maxChars);
  return { text, truncated, lines: raw.split("\n").length };
}

export async function readFilesFromFolder(root: string, rels: string[], maxChars: number) {
  const out: { path: string; content: string; truncated: boolean; error?: string }[] = [];
  for (const rel of rels) {
    try {
      const abs = await resolveInside(root, rel);
      const { text, truncated } = await readText(abs, maxChars);
      out.push({ path: rel, content: text, truncated });
    } catch (e) {
      out.push({ path: rel, content: "", truncated: false, error: (e as Error).message });
    }
  }
  return out;
}

// Quick filename search for @-mentions.
export async function suggestFiles(root: string, query: string, limit = 30): Promise<string[]> {
  const { files } = await walk(root, root, MAX_SCAN_FILES);
  const q = query.toLowerCase();
  const scored = files
    .filter((f) => !isSecretFile(f.rel) && !isBinaryName(f.rel))
    .map((f) => {
      const p = f.rel.toLowerCase();
      const base = p.split("/").pop()!;
      let score = -1;
      if (!q) score = 1;
      else if (base.startsWith(q)) score = 4;
      else if (base.includes(q)) score = 3;
      else if (p.includes(q)) score = 2;
      return { rel: f.rel, score, depth: f.rel.split("/").length };
    })
    .filter((f) => f.score >= 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.rel.localeCompare(b.rel));
  return scored.slice(0, limit).map((f) => f.rel);
}

export async function findFiles(root: string, pattern: string, limit = 300): Promise<{ paths: string[]; truncated: boolean }> {
  const { files } = await walk(root, root, 20000);
  const glob = pattern.includes("/") || pattern.startsWith("**") ? pattern : `**/${pattern}`;
  const isMatch = picomatch(glob, { dot: true, nocase: true });
  const matches = files.map((f) => f.rel).filter((rel) => isMatch(rel));
  return { paths: matches.slice(0, limit), truncated: matches.length > limit };
}

export async function searchFiles(
  root: string,
  opts: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean },
  limit = 200,
): Promise<{ matches: string[]; truncated: boolean; filesSearched: number }> {
  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern, opts.caseSensitive ? "" : "i");
  } catch {
    regex = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "" : "i");
  }
  const start = await resolveInside(root, opts.path || ".");
  const stat = await fs.stat(start);
  const entries = stat.isFile()
    ? [{ rel: toPosix(path.relative(root, start)), size: stat.size }]
    : (await walk(root, start, 20000)).files;
  const globMatch = opts.glob ? picomatch(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`, { dot: true, nocase: true }) : null;
  const matches: string[] = [];
  let filesSearched = 0;
  for (const f of entries) {
    if (isBinaryName(f.rel) || isSecretFile(f.rel) || f.size > 2_000_000) continue;
    if (globMatch && !globMatch(f.rel)) continue;
    let text: string;
    try {
      const buf = await fs.readFile(path.join(root, f.rel));
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    filesSearched++;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const line = lines[i].length > 300 ? lines[i].slice(0, 300) + "…" : lines[i];
        matches.push(`${f.rel}:${i + 1}: ${line.trim()}`);
        if (matches.length >= limit) return { matches, truncated: true, filesSearched };
      }
    }
  }
  return { matches, truncated: false, filesSearched };
}
