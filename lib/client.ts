// Browser-side helpers: JSON API calls, reading the reply stream, and turning
// dropped / pasted / picked files into attachments.
import { nanoid } from "nanoid";
import { isBinaryName, isSecretFile, isSkippedDir, skipReason } from "./skip";
import type { Attachment, StreamEvent } from "./types";

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new Error("Can't reach the app's server. Is it still running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as StreamEvent;
}

// ---------- Attachments ----------

export type DraftAttachment = Attachment & { status: "loading" | "ready" | "error"; error?: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2048;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function prepareImage(file: File): Promise<{ dataUrl: string; size: number }> {
  const dataUrl = await readAsDataUrl(file);
  if (file.type === "image/gif") return { dataUrl, size: file.size };
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return { dataUrl, size: file.size };
  // Shrink big screenshots/photos so they upload fast and stay within API limits.
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
  const finalUrl = out.length * 0.75 > MAX_IMAGE_BYTES ? canvas.toDataURL("image/jpeg", 0.85) : out;
  return { dataUrl: finalUrl, size: Math.round(finalUrl.length * 0.75) };
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}

// Convert one file into an attachment. Throws with a readable message if it can't be used.
export async function fileToAttachment(file: File, name = file.name): Promise<Attachment> {
  const id = nanoid(10);
  const lower = name.toLowerCase();
  if (IMAGE_TYPES.has(file.type)) {
    const { dataUrl, size } = await prepareImage(file);
    return { id, name, kind: "image", size, dataUrl };
  }
  if (isSecretFile(name)) throw new Error(`${name} may contain secrets, so it wasn't attached`);
  if (lower.endsWith(".pdf") || lower.endsWith(".docx")) {
    const form = new FormData();
    form.append("file", file);
    const { text } = await api<{ text: string }>("/api/extract", { method: "POST", body: form });
    return { id, name, kind: "file", size: text.length, content: text };
  }
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) throw new Error(`${name}: HEIC photos aren't supported — export as JPG or PNG`);
  if (isBinaryName(name)) throw new Error(`${name} isn't a text file, image, PDF or Word document`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${name} is too large (over 20 MB)`);
  const text = await file.text();
  if (looksBinary(text)) throw new Error(`${name} looks like a binary file`);
  return { id, name, kind: "file", size: text.length, content: text };
}

// ---------- Dropped folders ----------

export interface LocalFile {
  path: string;
  size: number;
  file: File;
  skipped?: string;
}

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

const entryFile = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

// Walk a dropped folder in the browser, applying the same skip rules as the server.
export async function walkDroppedFolder(root: FileSystemDirectoryEntry, limit = 5000): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  async function visit(dir: FileSystemDirectoryEntry, prefix: string) {
    const entries = (await readAllEntries(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!isSkippedDir(e.name)) await visit(e as FileSystemDirectoryEntry, rel);
      } else if (e.isFile) {
        const file = await entryFile(e as FileSystemFileEntry);
        const reason = skipReason(rel, file.size);
        out.push({ path: rel, size: file.size, file, ...(reason ? { skipped: reason } : {}) });
      }
    }
  }
  await visit(root, "");
  return out;
}

export function estimateAttachmentTokens(a: Pick<Attachment, "kind" | "size" | "content">): number {
  if (a.kind === "image") return 1000;
  return Math.ceil((a.content?.length ?? a.size) / 4);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
