// What the AI may do in a chat right now: Settings (including each provider's limits), then the
// project, then the chat's own switches. Each layer can only take away.
import "server-only";
import type OpenAI from "openai";
import type { ToolAccess } from "./conversation";
import { DOC_TOOLS, docsFolderPath } from "./docs";
import { EDIT_TOOLS } from "./edits";
import { chatLinkedFolders } from "./folders";
import { GITHUB_TOOLS, reposFor } from "./github";
import { providerOf, type Provider, type ProviderLimits } from "./models";
import { resolveRoots, type Root } from "./roots";
import { getSecret } from "./secrets";
import { SKILL_TOOLS, skillsFor } from "./skills";
import { getProject } from "./storage";
import { appPortsFor, COMMAND_TOOLS, terminalAccess, type TerminalAccess } from "./terminal";
import { WORKSPACE_TOOLS } from "./tools";
import { WEB_TOOLS } from "./websearch";
import { isEditingMode, type Chat, type Mode, type Project, type Settings, type SkillInfo } from "./types";

export interface ChatAccess {
  provider: Provider;
  limits: ProviderLimits;
  project: Project | null;
  roots: Root[]; // folders it can use (the project's, unless switched off here, plus the chat's own)
  mode: Mode;
  editing: boolean;
  web: boolean;
  docsPath: string | null;
  repos: string[];
  github: boolean;
  terminal: TerminalAccess | null;
  code: boolean; // Claude's code sandbox
  skills: SkillInfo[]; // skills it can open (for every provider)
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]; // the app's own tools (Claude's server tools are added by its session)
  access: ToolAccess;
}

export async function resolveAccess(chat: Chat, settings: Settings, req: Request): Promise<ChatAccess> {
  const provider = providerOf(chat.model);
  const limits = settings.limits[provider];
  const project = chat.projectId ? await getProject(chat.projectId) : null;
  // Folders that were moved or deleted are skipped.
  const roots = limits.folders ? await resolveRoots(chatLinkedFolders(chat, project)) : [];
  const root = roots.length > 0;
  // DeepSeek searches through Tavily (Settings flag + key); Claude uses its own web search.
  const web =
    limits.search &&
    !!chat.webSearch &&
    (provider === "claude" || (settings.webSearch && !!(await getSecret("tavily")).key));
  // Folder modes only apply when a project folder is open.
  // Older chats stored "Edit + always approve" as a flag; that's Auto mode now.
  let mode: Mode = root ? (chat.mode === "edit" && chat.autoApprove ? "auto" : (chat.mode ?? "ask")) : "ask";
  if (isEditingMode(mode) && !limits.edit) mode = "ask";
  if (mode === "auto" && !limits.auto) mode = "edit";
  const editing = isEditingMode(mode);
  // Docs folder: documents can be saved there in any mode. Created on first use.
  const docsPath = limits.docs ? docsFolderPath(settings, project) : null;
  // GitHub (read-only): the chat's toggle, a token, and repos allowed for this chat.
  const repos = reposFor(settings, project);
  const github = limits.github && !!chat.github && repos.length > 0 && !!(await getSecret("github")).key;
  // Terminal: only in a project with Terminal on, and only in that project's folders.
  const terminal = limits.commands ? terminalAccess(project, roots, appPortsFor(req)) : null;
  const code = provider === "claude" && limits.code && !!chat.code;
  // Skills: read-only instructions, the same for DeepSeek and Claude. Skills in the project's code
  // (.claude/skills) come only from the project folders the chat can use.
  const skills = await skillsFor(settings, project, roots.filter((r) => r.source === "project").map((r) => r.abs));
  const tools = [
    ...(root ? WORKSPACE_TOOLS : []),
    ...(root && editing ? EDIT_TOOLS : []),
    ...(docsPath ? DOC_TOOLS : []),
    ...(web && provider === "deepseek" ? WEB_TOOLS : []),
    ...(github ? GITHUB_TOOLS : []),
    ...(terminal ? COMMAND_TOOLS : []),
    ...(skills.length ? SKILL_TOOLS : []),
  ];
  const access: ToolAccess = { provider, roots, web, mode, docs: docsPath, github: github ? repos : [], terminal, code, skills };
  return { provider, limits, project, roots, mode, editing, web, docsPath, repos, github, terminal, code, skills, tools, access };
}
