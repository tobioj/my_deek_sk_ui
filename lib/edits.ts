// Edit mode: tools that let DeepSeek create, change and delete files in the chat's project
// folder. Every change is previewed (diff), backed up before it's applied, and can be undone.
import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import { nanoid } from "nanoid";
import type OpenAI from "openai";
import { display, locate, type Root } from "./roots";
import { isBinaryName, isSecretFile, isSkippedDir } from "./skip";
import { BACKUPS_DIR } from "./storage";
import type { DiffPreview, FileChange } from "./types";

const MAX_WRITE_CHARS = 2_000_000;
const MAX_PREVIEW_LINES = 400;

export const EDIT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Change part of an existing file by replacing an exact piece of text. Read the file first. old_string must match the file exactly (including indentation and whitespace) and appear only once, unless replace_all is true. Prefer this over write_file for changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          old_string: { type: "string", description: "The exact text to replace." },
          new_string: { type: "string", description: "The text to put in its place." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one. Defaults to false." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file, or replace an existing file's entire contents. Missing folders are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          content: { type: "string", description: "The complete file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the project root." } },
        required: ["path"],
      },
    },
  },
];

export const EDIT_TOOL_NAMES = new Set(EDIT_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

class EditError extends Error {}

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// Where a write may go: inside the project folder, never into junk/.git folders, never secrets,
// and never through a symlink that points outside the project.
async function resolveWritePath(root: string, rel: unknown): Promise<{ abs: string; rel: string }> {
  if (typeof rel !== "string" || !rel.trim()) throw new EditError("path is required");
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new EditError(`${rel} is outside the project folder`);
  const relPosix = path.relative(root, abs).split(path.sep).join("/");
  const blockedDir = relPosix.split("/").slice(0, -1).find((part) => isSkippedDir(part));
  if (blockedDir) throw new EditError(`Files inside ${blockedDir}/ can't be edited`);
  if (isSecretFile(relPosix)) throw new EditError(`${relPosix} may contain secrets, so it can't be edited`);
  if (isBinaryName(relPosix)) throw new EditError(`${relPosix} isn't a text file`);
  let probe = abs;
  for (;;) {
    let real: string | null = null;
    try {
      real = await fs.realpath(probe);
    } catch {}
    if (real !== null) {
      if (real !== root && !real.startsWith(root + path.sep)) throw new EditError(`${relPosix} leads outside the project folder`);
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return { abs, rel: relPosix };
}

async function readIfExists(abs: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return null;
  }
  if (stat.isDirectory()) throw new EditError("That path is a folder, not a file");
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new EditError("That file looks binary, so it can't be edited");
  return buf.toString("utf8");
}

function args(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new EditError("The tool arguments weren't valid JSON");
  }
}

interface Planned {
  abs: string;
  rel: string;
  before: string | null;
  after: string | null;
  kind: DiffPreview["kind"];
}

// Work out what a tool call would do, without touching the disk.
async function plan(roots: Root[], name: string, rawArgs: string): Promise<Planned> {
  const a = args(rawArgs);
  if (typeof a.path !== "string" || !a.path.trim()) throw new EditError("path is required");
  let target: { root: Root; rel: string };
  try {
    target = locate(roots, a.path);
  } catch (e) {
    throw new EditError((e as Error).message);
  }
  const { abs, rel: inside } = await resolveWritePath(target.root.abs, target.rel);
  const rel = display(roots, target.root, inside);
  const before = await readIfExists(abs);
  switch (name) {
    case "write_file": {
      if (typeof a.content !== "string") throw new EditError("content is required");
      if (a.content.length > MAX_WRITE_CHARS) throw new EditError("That file is too large to write");
      if (before === a.content) throw new EditError(`${rel} already has exactly this content`);
      return { abs, rel, before, after: a.content, kind: before === null ? "create" : "overwrite" };
    }
    case "edit_file": {
      if (before === null) throw new EditError(`${rel} doesn't exist. Use write_file to create it.`);
      const oldStr = typeof a.old_string === "string" ? a.old_string : "";
      const newStr = typeof a.new_string === "string" ? a.new_string : "";
      if (!oldStr) throw new EditError("old_string is required");
      if (oldStr === newStr) throw new EditError("old_string and new_string are identical");
      const count = before.split(oldStr).length - 1;
      if (count === 0) {
        throw new EditError(`old_string wasn't found in ${rel}. Read the file again and copy the exact text, including whitespace.`);
      }
      if (count > 1 && a.replace_all !== true) {
        throw new EditError(`old_string appears ${count} times in ${rel}. Include more surrounding lines to make it unique, or set replace_all.`);
      }
      const after = a.replace_all === true ? before.split(oldStr).join(newStr) : before.replace(oldStr, () => newStr);
      return { abs, rel, before, after, kind: "edit" };
    }
    case "append_file": {
      // Not a model tool: used by save_document to add to the end of a doc.
      if (typeof a.content !== "string" || !a.content.trim()) throw new EditError("content is required");
      const sep = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      return { abs, rel, before, after: (before ?? "") + sep + a.content.trimEnd() + "\n", kind: before === null ? "create" : "edit" };
    }
    case "delete_file": {
      if (before === null) throw new EditError(`${rel} doesn't exist`);
      return { abs, rel, before, after: null, kind: "delete" };
    }
    default:
      throw new EditError(`Unknown tool: ${name}`);
  }
}

function toPreview(p: Planned): DiffPreview {
  const patch = structuredPatch(p.rel, p.rel, p.before ?? "", p.after ?? "", "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  let shown = 0;
  let truncated = false;
  const hunks: DiffPreview["hunks"] = [];
  for (const h of patch.hunks) {
    const lines = h.lines.filter((l) => !l.startsWith("\\")); // drop "\ No newline at end of file"
    for (const l of lines) {
      if (l[0] === "+") added++;
      else if (l[0] === "-") removed++;
    }
    if (shown >= MAX_PREVIEW_LINES) {
      truncated = true;
      continue;
    }
    const room = MAX_PREVIEW_LINES - shown;
    if (lines.length > room) truncated = true;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: lines.slice(0, room) });
    shown += Math.min(lines.length, room);
  }
  return { path: p.rel, kind: p.kind, added, removed, hunks, ...(truncated ? { truncated } : {}) };
}

export function describe(d: DiffPreview): string {
  if (d.doc) return d.kind === "create" ? `Saved new doc ${d.path}` : `Updated doc ${d.path} (+${d.added} −${d.removed})`;
  switch (d.kind) {
    case "create":
      return `Created ${d.path} (+${d.added})`;
    case "delete":
      return `Deleted ${d.path}`;
    case "overwrite":
      return `Rewrote ${d.path} (+${d.added} −${d.removed})`;
    default:
      return `Edited ${d.path} (+${d.added} −${d.removed})`;
  }
}

// Preview only: used to ask for approval. Throws EditError with a message for the model.
export async function previewEdit(roots: Root[], name: string, rawArgs: string): Promise<DiffPreview> {
  return toPreview(await plan(roots, name, rawArgs));
}

// Re-check against the file as it is now, back it up, then write.
export async function applyEdit(roots: Root[], chatId: string, name: string, rawArgs: string): Promise<{ change: FileChange; preview: DiffPreview }> {
  const p = await plan(roots, name, rawArgs);
  let backup: string | null = null;
  if (p.before !== null) {
    const dir = path.join(BACKUPS_DIR, chatId);
    await fs.mkdir(dir, { recursive: true });
    backup = `${nanoid(12)}.bak`;
    await fs.writeFile(path.join(dir, backup), p.before);
  }
  if (p.after === null) {
    await fs.rm(p.abs, { force: true });
  } else {
    await fs.mkdir(path.dirname(p.abs), { recursive: true });
    await fs.writeFile(p.abs, p.after);
  }
  return {
    change: { path: p.rel, abs: p.abs, backup, afterHash: p.after === null ? null : hash(p.after) },
    preview: toPreview(p),
  };
}

export function isEditError(e: unknown): e is Error {
  return e instanceof EditError;
}

// Put files back the way they were before a reply's changes. If a file was changed again
// since (by you or another tool), it's reported as a conflict unless force is set.
export async function undoChanges(chatId: string, changes: FileChange[], force: boolean): Promise<{ conflicts: string[] }> {
  const last = new Map<string, FileChange>();
  for (const c of changes) last.set(c.abs, c);
  const conflicts: string[] = [];
  for (const c of last.values()) {
    let current: string | null = null;
    try {
      current = await fs.readFile(c.abs, "utf8");
    } catch {}
    const currentHash = current === null ? null : hash(current);
    if (currentHash !== c.afterHash) conflicts.push(c.path);
  }
  if (conflicts.length && !force) return { conflicts };
  for (const c of [...changes].reverse()) {
    if (c.backup) {
      const content = await fs.readFile(path.join(BACKUPS_DIR, chatId, path.basename(c.backup)), "utf8");
      await fs.mkdir(path.dirname(c.abs), { recursive: true });
      await fs.writeFile(c.abs, content);
    } else {
      await fs.rm(c.abs, { force: true });
    }
  }
  return { conflicts: [] };
}
