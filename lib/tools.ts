// Read-only tools DeepSeek can call to explore the chat's folders on its own.
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { findFiles, folderTree, readText, resolveInside, searchFiles } from "./files";
import { display, locate, type Root } from "./roots";

export const WORKSPACE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and folders in the project as an indented tree. Junk folders like node_modules and .git are marked (skipped). Use this first to get oriented.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list (start with the folder name when there are several). Defaults to the top level." },
          depth: { type: "integer", description: "How many levels deep to show (1-5). Defaults to 2." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file from the project. Returns numbered lines. For long files, read a range with offset/limit. You can call this several times in parallel to read multiple files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (start with the folder name when there are several folders)." },
          offset: { type: "integer", description: "First line to read (1-based). Defaults to 1." },
          limit: { type: "integer", description: "Maximum number of lines. Defaults to 2000." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search file contents with a regular expression (like grep). Returns matching lines as path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Folder or file to search in, relative to the root. Defaults to the root." },
          glob: { type: "string", description: "Only search files matching this glob, e.g. '*.tsx' or 'src/**/*.py'." },
          case_sensitive: { type: "boolean", description: "Defaults to false." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files by name or glob pattern, e.g. '*.test.ts', 'package.json' or 'src/**/*.css'.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern or file name." } },
        required: ["pattern"],
      },
    },
  },
];

export const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

export interface ToolOutcome {
  result: string; // what the model sees
  summary: string; // what the person sees
  ok: boolean;
}

const MAX_RESULT_CHARS = 150_000;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export async function runTool(name: string, rawArgs: string, roots: Root[]): Promise<ToolOutcome> {
  const args = parseArgs(rawArgs);
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const int = (k: string) => (typeof args[k] === "number" ? Math.floor(args[k] as number) : undefined);
  const multi = roots.length > 1;
  const prefix = (root: Root, line: string) => (multi ? `${root.name}/${line}` : line);
  try {
    switch (name) {
      case "list_directory": {
        const sub = str("path") || ".";
        const depth = Math.min(Math.max(int("depth") ?? 2, 1), 5);
        if (multi && (sub === "." || sub === "/")) {
          // Top level with several folders: one tree per folder.
          const trees = await Promise.all(
            roots.map(async (r) => {
              const lines = (await folderTree(r.abs, ".", depth, Math.floor(600 / roots.length))).split("\n");
              lines[0] = `${r.name}/`;
              return lines.join("\n");
            }),
          );
          return { result: trees.join("\n\n"), summary: `Listed ${roots.length} folders`, ok: true };
        }
        const { root, rel } = locate(roots, sub);
        const lines = (await folderTree(root.abs, rel, depth, 600)).split("\n");
        lines[0] = `${display(roots, root, rel)}/`;
        const shown = display(roots, root, rel);
        return { result: lines.join("\n"), summary: `Listed ${shown === "." ? "project root" : shown}`, ok: true };
      }
      case "read_file": {
        const requested = str("path");
        if (!requested) throw new Error("path is required");
        const { root, rel } = locate(roots, requested);
        const abs = await resolveInside(root.abs, rel);
        if ((await fs.stat(abs)).isDirectory()) throw new Error(`${requested} is a folder — use list_directory`);
        const { text } = await readText(abs, 5_000_000);
        const all = text.split("\n");
        const offset = Math.max(int("offset") ?? 1, 1);
        const limit = Math.min(Math.max(int("limit") ?? 2000, 1), 5000);
        const slice = all.slice(offset - 1, offset - 1 + limit);
        let body = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
        if (body.length > MAX_RESULT_CHARS) body = body.slice(0, MAX_RESULT_CHARS) + "\n… [truncated — read a smaller range]";
        const end = offset + slice.length - 1;
        const more = end < all.length ? `\n\n[showing lines ${offset}-${end} of ${all.length}; use offset to read more]` : "";
        const shown = display(roots, root, path.relative(root.abs, abs));
        const range = offset > 1 || more ? ` lines ${offset}-${end}` : ` (${all.length} lines)`;
        return { result: `=== FILE: ${shown} ===\n${body}${more}\n=== END FILE ===`, summary: `Read ${shown}${range}`, ok: true };
      }
      case "search_files": {
        const pattern = str("pattern");
        if (!pattern) throw new Error("pattern is required");
        const where = str("path");
        const targets = where ? [locate(roots, where)] : roots.map((root) => ({ root, rel: "." }));
        const matches: string[] = [];
        let truncated = false;
        let filesSearched = 0;
        for (const t of targets) {
          const r = await searchFiles(t.root.abs, { pattern, path: t.rel, glob: str("glob"), caseSensitive: args.case_sensitive === true }, 200 - matches.length);
          matches.push(...r.matches.map((m) => prefix(t.root, m)));
          filesSearched += r.filesSearched;
          if (r.truncated || matches.length >= 200) {
            truncated = true;
            break;
          }
        }
        const result = matches.length
          ? matches.join("\n") + (truncated ? "\n… [more matches not shown — narrow the search]" : "")
          : `No matches for /${pattern}/ in ${filesSearched} files.`;
        return { result, summary: `Searched for "${pattern}" — ${matches.length}${truncated ? "+" : ""} match${matches.length === 1 ? "" : "es"}`, ok: true };
      }
      case "find_files": {
        const pattern = str("pattern");
        if (!pattern) throw new Error("pattern is required");
        const paths: string[] = [];
        let truncated = false;
        for (const root of roots) {
          const r = await findFiles(root.abs, pattern);
          paths.push(...r.paths.map((p) => prefix(root, p)));
          truncated ||= r.truncated;
        }
        const result = paths.length ? paths.join("\n") + (truncated ? "\n… [more not shown]" : "") : `No files match ${pattern}.`;
        return { result, summary: `Found ${paths.length}${truncated ? "+" : ""} file${paths.length === 1 ? "" : "s"} matching ${pattern}`, ok: true };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    return { result: `Error: ${msg}`, summary: msg, ok: false };
  }
}
