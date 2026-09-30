// Saving and loading chats, settings and uploaded images.
// One JSON file per chat in data/chats/. Everything under data/ stays out of Git.
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { ownFolders, projectFolders } from "./folders";
import type { Chat, ChatSummary, Project, ProjectSummary, Settings } from "./types";

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const SECRETS_DIR = path.join(DATA_DIR, "secrets"); // Windows: keys encrypted with your Windows login
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, knowledgeable assistant. Be direct and concise; skip filler. " +
  "Use Markdown for structure and fenced code blocks with a language tag for code. " +
  "Attached files appear between '=== FILE: path ===' and '=== END FILE ===' markers — " +
  "always mention the file path when you refer to or suggest changes in a file.";

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: "deepseek-flash",
  thinking: true,
  effort: "high",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxFileChars: 100_000,
  webSearch: false,
  docsFolder: "~/Documents/DeepSeek Docs",
  docsAutoSave: [],
  githubRepos: [],
};

// Write to a temp file then rename, so a crash mid-write never corrupts a chat.
async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const chatFile = (id: string) => {
  if (!validId(id)) throw new Error("Invalid chat id");
  return path.join(CHATS_DIR, `${id}.json`);
};

export async function listChats(query?: string): Promise<ChatSummary[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(CHATS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const q = query?.trim().toLowerCase();
  const chats: (ChatSummary | null)[] = await Promise.all(
    names.map(async (n) => {
      try {
        const chat = JSON.parse(await fs.readFile(path.join(CHATS_DIR, n), "utf8")) as Chat;
        if (q) {
          const haystack = [
            chat.title,
            ...chat.messages.map((m) => (m.role === "user" ? m.text : m.steps.map((s) => s.content).join(" "))),
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(q)) return null;
        }
        const cost = chat.messages.reduce((sum, m) => sum + (m.role === "assistant" ? m.usage?.cost ?? 0 : 0), 0);
        return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, folders: ownFolders(chat), projectId: chat.projectId ?? null, cost };
      } catch {
        return null;
      }
    }),
  );
  return chats.filter((c): c is ChatSummary => c !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getChat(id: string): Promise<Chat | null> {
  try {
    return JSON.parse(await fs.readFile(chatFile(id), "utf8")) as Chat;
  } catch {
    return null;
  }
}

export async function saveChat(chat: Chat): Promise<void> {
  await writeJson(chatFile(chat.id), chat);
}

// Read-modify-write with a per-chat lock, so a rename during a streaming reply
// isn't overwritten when the reply finishes saving.
// Kept on globalThis because each API route is bundled separately but runs in the same process.
const g = globalThis as unknown as { __chatLocks?: Map<string, Promise<unknown>> };
const locks = (g.__chatLocks ??= new Map<string, Promise<unknown>>());
export async function updateChat(id: string, fn: (chat: Chat) => void | Promise<void>): Promise<Chat | null> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(async () => {
    const chat = await getChat(id);
    if (!chat) return null;
    await fn(chat);
    await saveChat(chat);
    return chat;
  });
  const settled = run.catch(() => {});
  locks.set(id, settled);
  settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return run;
}

export async function createChat(
  init: Partial<Pick<Chat, "model" | "thinking" | "effort" | "folders" | "hiddenProjectFolders" | "webSearch" | "github" | "mode" | "projectId">>,
): Promise<Chat> {
  const settings = await getSettings();
  const now = new Date().toISOString();
  const chat: Chat = {
    id: nanoid(12),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    model: init.model ?? settings.defaultModel,
    thinking: init.thinking ?? settings.thinking,
    effort: init.effort ?? settings.effort,
    folders: init.folders ?? [],
    hiddenProjectFolders: init.hiddenProjectFolders ?? [],
    webSearch: init.webSearch ?? false,
    github: init.github ?? false,
    mode: init.mode ?? "ask",
    autoApprove: false,
    projectId: init.projectId ?? null,
    messages: [],
  };
  await saveChat(chat);
  return chat;
}

export async function deleteChat(id: string): Promise<void> {
  const chat = await getChat(id);
  await fs.rm(chatFile(id), { force: true });
  await fs.rm(path.join(BACKUPS_DIR, id), { recursive: true, force: true });
  // Clean up images that belonged to this chat.
  for (const m of chat?.messages ?? []) {
    if (m.role !== "user") continue;
    for (const a of m.attachments) {
      if (a.upload) await fs.rm(path.join(UPLOADS_DIR, path.basename(a.upload)), { force: true });
    }
  }
}

// Keys only land here on machines without a macOS Keychain.
type StoredSettings = Settings & { apiKey?: string; tavilyKey?: string; githubToken?: string };

async function readStoredSettings(): Promise<StoredSettings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Settings as the browser sees them — never includes API keys.
export async function getSettings(): Promise<Settings> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey, tavilyKey, githubToken, ...rest } = await readStoredSettings();
  return rest;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readStoredSettings();
  const next: StoredSettings = { ...current };
  if (patch.defaultModel === "deepseek-flash" || patch.defaultModel === "deepseek-v4-pro") next.defaultModel = patch.defaultModel;
  if (typeof patch.thinking === "boolean") next.thinking = patch.thinking;
  if (patch.effort === "high" || patch.effort === "max") next.effort = patch.effort;
  if (typeof patch.systemPrompt === "string") next.systemPrompt = patch.systemPrompt;
  if (typeof patch.maxFileChars === "number" && patch.maxFileChars >= 1000) next.maxFileChars = Math.min(patch.maxFileChars, 2_000_000);
  if (typeof patch.webSearch === "boolean") next.webSearch = patch.webSearch;
  if (typeof patch.docsFolder === "string") next.docsFolder = patch.docsFolder.trim();
  if (Array.isArray(patch.docsAutoSave)) next.docsAutoSave = patch.docsAutoSave.filter((p) => typeof p === "string").slice(0, 200);
  if (Array.isArray(patch.githubRepos)) {
    next.githubRepos = [...new Set(patch.githubRepos.filter((r) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 100);
  }
  await writeJson(SETTINGS_FILE, next);
  return getSettings();
}

// "Save without asking" for one doc (added from an approval card).
export async function allowDocAutoSave(absPath: string): Promise<void> {
  const current = await readStoredSettings();
  if (!current.docsAutoSave.includes(absPath)) {
    current.docsAutoSave = [...current.docsAutoSave, absPath];
    await writeJson(SETTINGS_FILE, current);
  }
}

// Fallback key storage for machines without a macOS Keychain.
const SECRET_FIELDS = { deepseek: "apiKey", tavily: "tavilyKey", github: "githubToken" } as const;

export async function getStoredSecret(name: keyof typeof SECRET_FIELDS): Promise<string | undefined> {
  return (await readStoredSettings())[SECRET_FIELDS[name]] || undefined;
}

export async function setStoredSecret(name: keyof typeof SECRET_FIELDS, value: string | null): Promise<void> {
  const current = await readStoredSettings();
  if (value) current[SECRET_FIELDS[name]] = value;
  else delete current[SECRET_FIELDS[name]];
  await writeJson(SETTINGS_FILE, current);
}

// Save a pasted/dropped image and return its filename.
export async function saveUpload(dataUrl: string): Promise<string> {
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("Unsupported image format");
  const ext = m[2] === "jpeg" ? "jpg" : m[2];
  const name = `${nanoid(16)}.${ext}`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, name), Buffer.from(m[3], "base64"));
  return name;
}

// Delete the images of messages that were never sent (taken back, or never delivered).
export async function discardUploads(messages: { attachments: { upload?: string }[] }[]): Promise<void> {
  for (const m of messages) {
    for (const a of m.attachments) if (a.upload) await fs.rm(path.join(UPLOADS_DIR, path.basename(a.upload)), { force: true });
  }
}

export async function readUploadAsDataUrl(name: string): Promise<string | null> {
  const safe = path.basename(name);
  const ext = path.extname(safe).slice(1);
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  try {
    const buf = await fs.readFile(path.join(UPLOADS_DIR, safe));
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ---------- Projects ----------

const projectFile = (id: string) => {
  if (!validId(id)) throw new Error("Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.json`);
};

export async function listProjects(): Promise<ProjectSummary[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(PROJECTS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const n of names) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(PROJECTS_DIR, n), "utf8")) as Project;
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, folders: projectFolders(p) });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    return JSON.parse(await fs.readFile(projectFile(id), "utf8")) as Project;
  } catch {
    return null;
  }
}

export async function saveProject(project: Project): Promise<void> {
  await writeJson(projectFile(project.id), project);
}

export async function createProject(
  init: Partial<
    Pick<Project, "name" | "context" | "folders" | "files" | "isolated" | "docsFolder" | "githubRepos" | "terminal" | "terminalInternet" | "terminalMinutes" | "allowedCommands">
  >,
): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = {
    id: nanoid(12),
    name: init.name?.trim() || "Untitled project",
    context: init.context ?? "",
    folders: init.folders ?? [],
    files: init.files ?? [],
    isolated: init.isolated ?? false,
    docsFolder: init.docsFolder ?? null,
    githubRepos: init.githubRepos ?? [],
    terminal: init.terminal ?? false,
    terminalInternet: init.terminalInternet ?? false,
    terminalMinutes: init.terminalMinutes ?? 10,
    allowedCommands: init.allowedCommands ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await saveProject(project);
  return project;
}

// "Always allow" for a command in a project (added from a command's approval card).
export async function allowProjectCommand(id: string, rule: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  const rules = project.allowedCommands ?? [];
  if (!rules.includes(rule)) {
    project.allowedCommands = [...rules, rule].slice(-200);
    await saveProject(project);
  }
}

// Deleting a project keeps its chats; they just move back to the ungrouped list.
export async function deleteProject(id: string): Promise<void> {
  await fs.rm(projectFile(id), { force: true });
  let names: string[] = [];
  try {
    names = (await fs.readdir(CHATS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const n of names) {
    const chatId = n.replace(/\.json$/, "");
    const chat = await getChat(chatId);
    if (chat?.projectId === id) await updateChat(chatId, (c) => void (c.projectId = null));
  }
}
