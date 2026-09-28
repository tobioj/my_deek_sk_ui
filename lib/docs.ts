// The Docs folder: the one place DeepSeek may create and update documents in any mode
// (even Ask and Plan). It can't reach anything else through these tools.
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { expandHome, folderTree, readText, resolveInside } from "./files";
import type { Root } from "./roots";
import type { ToolOutcome } from "./tools";
import type { Project, Settings } from "./types";

const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc", ".csv", ".json", ".yaml", ".yml", ".html", ".tex"]);

export const DOC_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_document",
      description:
        "Save a document for the user in their Docs folder: a plan, notes, a summary, a write-up. Creates the file if it's new. " +
        "Works in every mode. Use a clear file name ending in .md unless another text format fits better. The user approves each save.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File name inside the Docs folder, e.g. 'auth-refactor-plan.md' or 'meetings/2026-09-27.md'." },
          content: { type: "string", description: "The document text (Markdown is best)." },
          mode: { type: "string", enum: ["replace", "append"], description: "'replace' writes the whole file (default); 'append' adds to the end." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "List the documents in the user's Docs folder.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Read a document from the user's Docs folder (for example, before updating it).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File name inside the Docs folder." } },
        required: ["path"],
      },
    },
  },
];

export const DOC_TOOL_NAMES = new Set(DOC_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

// The project's Docs folder if it has one, otherwise the default from Settings ("" = off).
export function docsFolderPath(settings: Settings, project: Project | null): string | null {
  const raw = (project?.docsFolder || settings.docsFolder || "").trim();
  return raw ? path.resolve(expandHome(raw)) : null;
}

// Created on first use, so it can be named before it exists.
export async function docsRoot(folder: string): Promise<Root> {
  await fs.mkdir(folder, { recursive: true });
  return { name: "docs", abs: await fs.realpath(folder), source: "chat" };
}

// save_document → the internal write_file / append_file operation used by Edit mode.
export function docEdit(rawArgs: string): { name: "write_file" | "append_file"; args: string } {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {}
  let file = typeof a.path === "string" ? a.path.trim().replace(/^\/+/, "") : "";
  if (!file) throw new Error("path is required");
  if (!path.extname(file)) file += ".md";
  if (!DOC_EXTS.has(path.extname(file).toLowerCase())) {
    throw new Error(`Docs must be text documents (${[...DOC_EXTS].join(", ")}). Code changes need Edit or Auto mode.`);
  }
  if (typeof a.content !== "string" || !a.content.trim()) throw new Error("content is required");
  return { name: a.mode === "append" ? "append_file" : "write_file", args: JSON.stringify({ path: file, content: a.content }) };
}

export async function runDocReadTool(name: string, rawArgs: string, root: Root): Promise<ToolOutcome> {
  try {
    if (name === "list_documents") {
      const entries = await fs.readdir(root.abs);
      if (!entries.filter((e) => !e.startsWith(".")).length) return { result: "The Docs folder is empty.", summary: "Docs folder is empty", ok: true };
      return { result: await folderTree(root.abs, ".", 3, 300), summary: "Listed your docs", ok: true };
    }
    let a: Record<string, unknown> = {};
    try {
      a = JSON.parse(rawArgs || "{}");
    } catch {}
    const rel = typeof a.path === "string" ? a.path : "";
    if (!rel) throw new Error("path is required");
    const abs = await resolveInside(root.abs, rel);
    const { text } = await readText(abs, 200_000);
    return { result: `=== DOC: ${rel} ===\n${text}\n=== END DOC ===`, summary: `Read doc ${rel}`, ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    return { result: `Error: ${msg}`, summary: msg, ok: false };
  }
}
