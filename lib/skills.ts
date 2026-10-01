// Skills: instructions you keep for particular kinds of tasks.
// A skill is a folder with a SKILL.md file (a name and a one-line description at the top, then the
// instructions), plus any templates or notes it refers to. The same format Claude Code uses.
//
// Where they live:
//   - your skills: data/skills, so they move with the data folder to another computer
//   - a project's own skills: data/project-skills/<project id>
//   - skills in a project's code: .claude/skills inside its folders (they move with the code)
//   - optionally, one more folder on this computer (e.g. Claude Code's ~/.claude/skills)
//
// Every AI (DeepSeek or Claude) sees only each skill's name and description, and opens the full
// instructions with use_skill when a task matches. These tools only read inside skill folders;
// nothing in them runs.
import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type OpenAI from "openai";
import { expandHome, readText, resolveInside } from "./files";
import { isBinaryName, isSecretFile, isSkippedDir } from "./skip";
import { projectSkillsDir, SKILLS_DIR } from "./storage";
import type { ToolOutcome } from "./tools";
import { skillKey, type Project, type Settings, type SkillInfo, type SkillSource } from "./types";

const MAX_SKILLS = 200;
const MAX_DEPTH = 3; // <folder>/<group>/<skill>/SKILL.md
const MAX_SKILL_CHARS = 100_000;
const MAX_LISTED_FILES = 60;

export const SKILL_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "Open one of your skills (listed under Skills in your instructions) and get its full instructions, plus the other files in it. " +
        "Do this before starting a task the skill is for, then follow it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The skill's name, exactly as listed." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_skill_file",
      description: "Read another file from inside a skill's folder (a template, reference or example its instructions point to).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill's name." },
          path: { type: "string", description: "The file's path inside the skill's folder, as use_skill listed it." },
        },
        required: ["name", "path"],
      },
    },
  },
];

export const SKILL_TOOL_NAMES = new Set(SKILL_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

// Claude Code's own skills folder, if you have one (to use the same skills here).
export async function claudeCodeSkillsFolder(): Promise<string | null> {
  const p = path.join(os.homedir(), ".claude", "skills");
  try {
    return (await fs.stat(p)).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

// ---------- Reading SKILL.md ----------

const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");

// The frontmatter between the first two --- lines: simple "key: value" pairs, with quoted values
// and folded/literal blocks (description: > / |) like Claude Code's skills use.
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2];
    if (/^[|>][+-]?$/.test(value.trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = value.trim().startsWith(">") ? block.join(" ").replace(/\s+/g, " ") : block.join("\n");
    }
    meta[kv[1].toLowerCase()] = unquote(value);
  }
  return { meta, body: text.slice(m[0].length) };
}

async function findSkillFile(dir: string): Promise<string | null> {
  try {
    const names = await fs.readdir(dir);
    const hit = names.find((n) => n.toLowerCase() === "skill.md");
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

const PLACEHOLDER = "When to use this skill, in one line (the AI reads this to decide when to open it)";

async function readSkill(dir: string, file: string, folder: string, source: SkillSource): Promise<SkillInfo> {
  const rel = path.relative(folder, dir) || path.basename(dir);
  try {
    const { text } = await readText(file, 20_000); // the top is enough for the name and description
    const { meta, body } = parseFrontmatter(text);
    const firstLine = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
    const name = (meta.name || path.basename(dir)).trim().slice(0, 80);
    const description = (meta.description || firstLine).trim().slice(0, 400);
    const problem = !meta.description
      ? "SKILL.md has no description at the top, so the AI may not know when to use it"
      : description === PLACEHOLDER
        ? "Still has the example description: say when to use it"
        : null;
    return { name, description, dir, source, rel, ...(problem ? { problem } : {}) };
  } catch (e) {
    return { name: path.basename(dir), description: "", dir, source, rel, problem: `Couldn't read SKILL.md: ${(e as Error).message}` };
  }
}

// Every skill in a folder (the folder itself can be one skill, or hold many).
export async function scanSkills(folder: string, source: SkillSource): Promise<SkillInfo[]> {
  let root: string;
  try {
    root = await fs.realpath(path.resolve(expandHome(folder)));
    if (!(await fs.stat(root)).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  async function visit(dir: string, depth: number) {
    if (out.length >= MAX_SKILLS) return;
    const file = await findSkillFile(dir);
    if (file) {
      out.push(await readSkill(dir, file, root, source));
      return; // a skill's own subfolders are its files, not more skills
    }
    if (depth >= MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !e.name.startsWith(".") && !isSkippedDir(e.name)) await visit(path.join(dir, e.name), depth + 1);
    }
  }
  await visit(root, 0);
  return out;
}

// .claude/skills inside a project folder: where Claude Code keeps a project's skills.
export const codeSkillsFolder = (folder: string) => path.join(path.resolve(expandHome(folder)), ".claude", "skills");

// Your skills: data/skills, or a project's own: data/project-skills/<id>.
export const libraryFolder = (projectId?: string | null) => (projectId ? projectSkillsDir(projectId) : SKILLS_DIR);

// Your skills (data/skills plus the optional folder from Settings), minus the ones switched off.
export async function ownSkills(settings: Settings): Promise<SkillInfo[]> {
  const extra = settings.skillsFolder.trim() ? await scanSkills(settings.skillsFolder, "folder") : [];
  const off = new Set(settings.skillsOff);
  return [...extra, ...(await scanSkills(SKILLS_DIR, "library"))].filter((s) => !off.has(skillKey(s.name)));
}

// The skills a chat can use: yours (unless its project leaves them out), then skills in the project's
// code folders, then the project's own. When two have the same name the later one wins (the
// project's own over its code's over yours). `codeFolders` are the project folders the chat can use.
export async function skillsFor(settings: Settings, project: Project | null, codeFolders: string[]): Promise<SkillInfo[]> {
  const useOwn = !project || (project.skillsGlobal ?? !project.isolated);
  const own = useOwn ? await ownSkills(settings) : [];
  const code = project ? (await Promise.all(codeFolders.map((f) => scanSkills(codeSkillsFolder(f), "code")))).flat() : [];
  const projects = project ? await scanSkills(libraryFolder(project.id), "project") : [];
  const off = new Set(project?.skillsOff ?? []);
  const byName = new Map<string, SkillInfo>();
  for (const s of [...own, ...code, ...projects]) {
    if (!off.has(skillKey(s.name))) byName.set(skillKey(s.name), s);
  }
  return [...byName.values()];
}

// ---------- Adding skills (to your skills or a project's) ----------

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const NOT_COPIED = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "__MACOSX", ".DS_Store"]);

export const skillSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

// A new skill from a short template, ready to fill in. Returns its folder.
export async function createSkill(library: string, rawName: string): Promise<{ name: string; dir: string }> {
  const name = skillSlug(rawName);
  if (!name) throw new Error("Give the skill a name, e.g. weekly-report");
  const dir = path.join(library, name);
  const taken = (await scanSkills(library, "library")).some((s) => skillKey(s.name) === name);
  if (taken || (await exists(dir))) throw new Error(`There's already a skill called ${name}`);
  await fs.mkdir(dir, { recursive: true });
  const title = name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${PLACEHOLDER}\n---\n\n# ${title}\n\n` +
      `Write the instructions here: how you like this done, the steps, a checklist, an example.\n\n` +
      `You can put other files in this folder (templates, examples) and mention them by name; the AI can read them.\n`,
    "utf8",
  );
  return { name, dir };
}

async function copyFolder(from: string, to: string, budget: { files: number; bytes: number }) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (e.isSymbolicLink() || NOT_COPIED.has(e.name)) continue;
    const src = path.join(from, e.name);
    if (e.isDirectory()) await copyFolder(src, path.join(to, e.name), budget);
    else if (e.isFile() && !isSecretFile(e.name)) {
      budget.files += 1;
      budget.bytes += (await fs.stat(src)).size;
      if (budget.files > MAX_IMPORT_FILES || budget.bytes > MAX_IMPORT_BYTES) throw new Error("it's too big (over 500 files or 50 MB)");
      await fs.copyFile(src, path.join(to, e.name));
    }
  }
}

// Copies every skill found in a folder (or the folder itself, if it's one skill) into a library.
// Skills it already has (same name) are left alone. Secret files and links aren't copied.
export async function importSkills(from: string, library: string): Promise<{ added: string[]; skipped: string[] }> {
  let src: string;
  try {
    src = await fs.realpath(path.resolve(expandHome(from)));
  } catch {
    throw new Error(`Folder not found: ${from}`);
  }
  await fs.mkdir(library, { recursive: true });
  const dest = await fs.realpath(library);
  if (src === dest || src.startsWith(dest + path.sep)) throw new Error("Those skills are already here");
  const found = await scanSkills(src, "folder");
  if (!found.length) throw new Error("No skills found there. A skill is a folder with a SKILL.md file in it.");
  const have = new Set((await scanSkills(dest, "library")).map((s) => skillKey(s.name)));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const s of found) {
    const folder = path.join(dest, skillSlug(s.name) || skillSlug(path.basename(s.dir)) || "skill");
    if (have.has(skillKey(s.name)) || (await exists(folder)) || dest.startsWith(s.dir + path.sep)) {
      skipped.push(s.name);
      continue;
    }
    try {
      await copyFolder(s.dir, folder, { files: 0, bytes: 0 });
    } catch (e) {
      await fs.rm(folder, { recursive: true, force: true });
      throw new Error(`Couldn't copy ${s.name}: ${(e as Error).message}`);
    }
    have.add(skillKey(s.name));
    added.push(s.name);
  }
  return { added, skipped };
}

// A .zip (or .skill) file with one or more skills in it, as Claude.ai and skill tools share them.
export async function importZip(bytes: Buffer, library: string): Promise<{ added: string[]; skipped: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("That isn't a zip file");
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-import-"));
  try {
    let files = 0;
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      // No absolute paths or ".." (a zip can't write outside the folder it's unpacked into). JSZip
      // already tidies such names; the original is checked so a zip like that is refused outright.
      const original = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      const unsafe = (n: string) => /^([a-z]:|\/|\\)/i.test(n) || n.split(/[\\/]/).some((p) => p === "..");
      if (unsafe(original) || unsafe(entry.name)) throw new Error(`It has an unsafe path in it (${original})`);
      const parts = entry.name.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
      if (!parts.length || parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") continue;
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      files += 1;
      total += size;
      if (files > MAX_IMPORT_FILES || total > MAX_IMPORT_BYTES) throw new Error("It's too big (over 500 files or 50 MB unpacked)");
      const content = await entry.async("nodebuffer");
      total += Math.max(0, content.length - size);
      if (total > MAX_IMPORT_BYTES) throw new Error("It's too big (over 50 MB unpacked)");
      const out = path.join(tmp, ...parts);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, content);
    }
    return await importSkills(tmp, library);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// The SKILL.md in a skill's folder (to open it in your text editor).
export async function skillMarkdown(dir: string): Promise<string> {
  const file = await findSkillFile(path.resolve(expandHome(dir)));
  if (!file) throw new Error("That folder has no SKILL.md");
  return file;
}

// What the AI is told about its skills (names and descriptions only; the rest is opened on demand).
export function skillsPrompt(skills: SkillInfo[]): string {
  if (!skills.length) return "";
  return (
    `\n\n## Skills\n` +
    `The user keeps skills: instructions for particular kinds of tasks. When a task matches one, open it with use_skill before ` +
    `you start, and follow it; it may point to extra files you can read with read_skill_file. Only open the skills a task needs.\n` +
    skills.map((s) => `- \`${s.name}\`: ${s.description || "(no description)"}`).join("\n")
  );
}

// ---------- The tools ----------

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string, depth: number) {
    if (out.length >= MAX_LISTED_FILES || depth > 4) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LISTED_FILES) return;
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isSkippedDir(e.name)) await walk(path.join(d, e.name), rel, depth + 1);
      } else if (e.name.toLowerCase() !== "skill.md" && !isSecretFile(e.name)) out.push(rel);
    }
  }
  await walk(dir, "", 0);
  return out;
}

export async function runSkillTool(name: string, rawArgs: string, skills: SkillInfo[]): Promise<ToolOutcome> {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {}
  const wanted = typeof a.name === "string" ? a.name.trim().toLowerCase() : "";
  const skill = skills.find((s) => s.name.toLowerCase() === wanted);
  if (!skill) {
    const names = skills.map((s) => s.name).join(", ");
    return { result: `Error: no skill called "${a.name ?? ""}". Your skills: ${names || "none"}.`, summary: `No skill called "${a.name ?? ""}"`, ok: false };
  }
  try {
    if (name === "use_skill") {
      const file = await findSkillFile(skill.dir);
      if (!file) throw new Error("its SKILL.md is gone");
      const { text, truncated } = await readText(file, MAX_SKILL_CHARS);
      const { body } = parseFrontmatter(text);
      const files = await listFiles(skill.dir);
      return {
        result:
          `=== SKILL: ${skill.name} ===\n${body.trim()}${truncated ? "\n…(cut off)" : ""}\n=== END SKILL ===` +
          (files.length ? `\n\nOther files in this skill (read them with read_skill_file):\n${files.map((f) => `- ${f}`).join("\n")}` : ""),
        summary: `Used skill ${skill.name}`,
        ok: true,
      };
    }
    const rel = typeof a.path === "string" ? a.path.trim() : "";
    if (!rel) throw new Error("path is required");
    if (isSecretFile(rel)) throw new Error(`${rel} may contain secrets, so it can't be read`);
    if (isBinaryName(rel)) throw new Error(`${rel} isn't a text file`);
    const abs = await resolveInside(await fs.realpath(skill.dir), rel);
    const { text, truncated } = await readText(abs, MAX_SKILL_CHARS);
    return {
      result: `=== FILE: ${skill.name}/${rel} ===\n${text}${truncated ? "\n…(cut off)" : ""}\n=== END FILE ===`,
      summary: `Read ${rel} from skill ${skill.name}`,
      ok: true,
    };
  } catch (e) {
    const msg = (e as Error).message.replace("outside the project folder", "outside the skill's folder");
    return { result: `Error: ${msg}`, summary: msg, ok: false };
  }
}
