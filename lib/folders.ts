// Which folders a chat can use: its project's folders (always linked, unless switched off in
// this chat) plus folders added to the chat itself. Shared by the server and the browser.
import type { Chat, Project } from "./types";

export interface LinkedFolder {
  path: string; // absolute
  name: string; // short name DeepSeek uses as the first part of paths, e.g. "backend"
  source: "project" | "chat";
  hidden: boolean; // a project folder switched off for this chat
}

export function projectFolders(project: Pick<Project, "folders" | "workspace"> | null | undefined): string[] {
  if (!project) return [];
  return project.folders ?? (project.workspace ? [project.workspace] : []);
}

// Chats from before multi-folder support stored a single `workspace`.
export function ownFolders(chat: Pick<Chat, "folders" | "workspace"> | null | undefined): string[] {
  if (!chat) return [];
  return chat.folders ?? (chat.workspace ? [chat.workspace] : []);
}

// A folder's own name from its full path, on macOS (/) or Windows (\).
export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

// Short, unique names: "api", "web", and "api-2" if two folders are both called "api".
export function folderNames(paths: string[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const base = baseName(p).replace(/\s+/g, "-") || "folder";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

export function linkedFolders(
  own: string[],
  fromProject: string[],
  hiddenProjectFolders: string[] = [],
): LinkedFolder[] {
  const items: Omit<LinkedFolder, "name">[] = [];
  const seen = new Set<string>();
  for (const path of fromProject) {
    if (seen.has(path)) continue;
    seen.add(path);
    items.push({ path, source: "project", hidden: hiddenProjectFolders.includes(path) });
  }
  for (const path of own) {
    if (seen.has(path)) continue;
    seen.add(path);
    items.push({ path, source: "chat", hidden: false });
  }
  // Names are based on the visible folders only, so DeepSeek's paths stay short.
  const visible = items.filter((f) => !f.hidden);
  const names = folderNames(visible.map((f) => f.path));
  const nameOf = new Map(visible.map((f, i) => [f.path, names[i]]));
  return items.map((f) => ({ ...f, name: nameOf.get(f.path) ?? baseName(f.path) }));
}

export function chatLinkedFolders(chat: Chat, project: Project | null): LinkedFolder[] {
  return linkedFolders(ownFolders(chat), chat.projectId ? projectFolders(project) : [], chat.hiddenProjectFolders ?? []);
}
