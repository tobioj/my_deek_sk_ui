// Shared types used by both the server (API routes) and the browser (components).
import type { Effort, ProviderLimits } from "./models";
export type { Effort } from "./models";

export type ModelId = string; // "deepseek-flash", "claude-opus-5-5", … (see models.ts)

// What the AI may do with the chat's project folder.
export type Mode = "ask" | "plan" | "edit" | "auto";
export const MODES: Record<Mode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Read-only: it reads your project and answers questions" },
  plan: { label: "Plan", hint: "It reads your project and proposes a step-by-step plan, without changing anything" },
  edit: { label: "Edit", hint: "It can create, change and delete files. You approve every change first" },
  auto: { label: "Auto", hint: "It makes all the changes without asking. Each reply can still be undone" },
};
export const isEditingMode = (m: Mode | undefined) => m === "edit" || m === "auto";

// How skills are matched in on/off lists and name clashes.
export const skillKey = (name: string) => name.trim().toLowerCase();

export interface Attachment {
  id: string;
  name: string; // display name — a relative path for files that came from a folder
  kind: "file" | "image" | "pasted";
  size: number; // characters for text, bytes for images
  truncated?: boolean;
  content?: string; // text content (only sent browser → server, then folded into `files`)
  dataUrl?: string; // image, PDF or spreadsheet data (only sent browser → server, then saved to data/uploads)
  upload?: string; // saved filename in data/uploads (images, PDFs, files for Claude's code sandbox)
  sandbox?: boolean; // also goes into Claude's code sandbox (data files, when Code is on)
  fileId?: string; // Claude: the file's id once it's been uploaded for the code sandbox
}

export interface ToolCall {
  id: string;
  name: string;
  args: string; // raw JSON arguments from the model
  result?: string; // full text given back to the model
  summary?: string; // short human-readable summary, e.g. "Read src/App.tsx (120 lines)"
  ok?: boolean;
  sources?: Source[]; // web pages found or read (web search tools)
  diff?: DiffPreview; // proposed or applied file change (edit tools)
  status?: "pending" | "applied" | "rejected"; // approval state (edit tools)
  command?: CommandRun; // a terminal command (run_command)
  server?: boolean; // run by Claude's servers (web search, page reading, code execution), not by the app
  files?: OutputFile[]; // files Claude's code made
}

// A file Claude's code sandbox made (a chart, a CSV…), saved in data/uploads.
export interface OutputFile {
  name: string;
  upload: string;
  size: number;
}

// A terminal command DeepSeek asked to run, and what happened.
export type CommandStatus = "pending" | "running" | "finished" | "failed" | "stopped" | "timed_out" | "denied" | "blocked";
export interface CommandRun {
  command: string;
  folder: string; // the folder's short name
  status: CommandStatus;
  level: "look" | "ask" | "always_ask" | "blocked";
  reason?: string; // why it always asks, or why it was blocked
  rule?: string; // what "Always allow" would save for this project
  sandboxed: boolean; // macOS sandbox (false on Windows)
  readOnly: boolean; // Ask/Plan mode: can't change files
  internet: boolean;
  background?: boolean; // keeps running (a dev server); shown in the Running list
  procId?: string; // its entry in the Running list
  startedAt?: string; // when it started running (for the timer on its card)
  exitCode?: number | null;
  durationMs?: number;
  output?: string; // what it printed (start and end, if long)
  edited?: boolean; // you changed the command before running it
  unasked?: boolean; // ran without asking because "Run commands without asking" was on in this chat
}

// A command in the Running list (started by DeepSeek or by ▶ Run).
export type ProcessStatus = "running" | "stopping" | "finished" | "failed" | "stopped" | "timed_out" | "stop_failed";
export interface ProcessInfo {
  id: string;
  command: string;
  folder: string; // folder name
  cwd: string; // full path
  projectId: string;
  projectName: string;
  chatId: string | null;
  by: "deepseek" | "claude" | "you";
  background: boolean;
  sandboxed: boolean;
  status: ProcessStatus;
  exitCode?: number | null;
  error?: string; // e.g. why it couldn't be stopped
  startedAt: string;
  endedAt?: string;
  ports: number[]; // ports it's listening on (e.g. a dev server on 3000)
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // each starts with "+", "-" or " "
}

export interface DiffPreview {
  path: string;
  kind: "create" | "edit" | "overwrite" | "delete";
  added: number;
  removed: number;
  hunks: DiffHunk[];
  truncated?: boolean;
  doc?: boolean; // a save to the Docs folder (not a code change)
}

// A change DeepSeek made to a file, kept so it can be undone.
export interface FileChange {
  path: string; // relative, for display
  abs: string; // absolute path on disk
  backup: string | null; // backup filename in data/backups/<chatId>/, or null if the file was new
  afterHash: string | null; // hash of the file right after the change (null if deleted)
}

export interface Source {
  title: string;
  url: string;
}

// One assistant "turn" can involve several API calls when the model uses tools.
// Each call is a step: optional thinking, optional text, optional tool calls.
export interface AssistantStep {
  reasoning?: string;
  content: string;
  toolCalls?: ToolCall[];
  // Claude: the reply's content blocks exactly as the API returned them (with their thinking
  // signatures), sent back as-is next time. On the first step of each API call only.
  raw?: unknown[];
  cont?: boolean; // Claude: continues the API call of the step before (text after a web search…)
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cacheWriteTokens?: number; // Claude: tokens written to the cache (cost a little more than plain input)
  searches?: number; // Claude: web searches
  cost: number; // USD
  priceUnknown?: boolean; // the app doesn't know this model's price yet
}

export interface UserMessage {
  id: string;
  role: "user";
  createdAt: string;
  text: string; // what the user typed
  files?: string; // attached file text, wrapped in === FILE: path === markers
  pdfText?: string; // text of attached PDFs (models that can't read PDFs themselves get this)
  attachments: Attachment[]; // metadata only (names, sizes, image filenames)
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  createdAt: string;
  model: ModelId;
  steps: AssistantStep[];
  usage?: Usage; // totals for this turn
  contextTokens?: number; // size of the conversation after this turn
  mode?: Mode; // folder mode used for this reply
  changes?: FileChange[]; // files changed in Edit mode
  undone?: boolean; // the person undid those changes
  cutOff?: boolean; // cut off by "Answer together now" (the rest continues after your message)
  note?: string; // Claude: a note from the app sent just before this reply (e.g. "switched to Edit mode")
  fallback?: string; // Claude declined and another Claude model answered, e.g. "Opus 5.5 → Opus 5"
  refusal?: string; // Claude declined to answer (the reason's category, if given)
  stopped?: boolean;
  error?: string;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: ModelId;
  thinking: boolean;
  effort: Effort;
  folders?: string[]; // folders added to this chat (DeepSeek can explore them)
  hiddenProjectFolders?: string[]; // project folders switched off for this chat
  workspace?: string | null; // older chats: a single folder (read as folders[0])
  webSearch?: boolean; // DeepSeek may search the web (only if enabled in Settings)
  mode?: Mode; // Ask / Plan / Edit / Auto (only matters when a folder is open)
  github?: boolean; // the AI may read GitHub (only if set up in Settings)
  code?: boolean; // Claude may run code in Anthropic's sandbox (only if allowed in Settings)
  container?: { id: string; expiresAt?: string | null }; // Claude's code sandbox for this chat, reused between replies
  autoApprove?: boolean; // older chats: Edit mode with "always approve" (now the same as Auto)
  runWithoutAsking?: boolean; // commands run without asking in Edit and Auto mode (risky ones still ask)
  projectId?: string | null;
  summary?: ChatSummaryNote; // earlier messages were summarized (long chats)
  extraCost?: number; // USD spent outside replies (summaries)
  messages: ChatMessage[];
}

// A long chat's earlier messages, summarized. The AI gets the summary instead of the messages up
// to (and including) `upto`; you still see them all.
export interface ChatSummaryNote {
  upto: string; // id of the last message it covers
  text: string;
  block?: unknown; // Claude: the compaction block exactly as returned (sent back as-is)
  model: string; // who wrote it
  createdAt: string;
  cost: number;
}

export interface ProjectFile {
  id: string;
  name: string;
  content: string;
  size: number; // characters
}

// A group of chats that share context, files and (optionally) a folder.
export interface Project {
  id: string;
  name: string;
  context: string; // instructions/background every chat in the project sees
  folders?: string[]; // linked to every chat in the project
  workspace?: string | null; // older projects: a single folder (read as folders[0])
  files: ProjectFile[];
  docsFolder?: string | null; // where DeepSeek saves docs for this project (default: Settings)
  githubRepos?: string[]; // repos (from the Settings allowlist) this project's chats may read
  isolated?: boolean; // true = ignore your global instructions from Settings in this project
  terminal?: boolean; // DeepSeek may run commands in the project's folders (off by default)
  terminalInternet?: boolean; // commands may use the internet (off by default; enforced on macOS)
  terminalMinutes?: number; // time limit for each command DeepSeek runs: 10, 30 or 60
  allowedCommands?: string[]; // "Always allow" rules: run without asking in Edit and Auto mode
  skillsGlobal?: boolean; // also use your own skills (default: yes, unless the project is "This project only")
  skillsOff?: string[]; // skills (by name, lowercase) switched off in this project
  createdAt: string;
  updatedAt: string;
}

// A skill: a folder with a SKILL.md (name and description at the top, then instructions).
// Where it comes from:
//   library — your skills, kept in data/skills (they move with the data folder)
//   folder  — a folder on this computer you added in Settings (e.g. Claude Code's ~/.claude/skills)
//   project — a project's own skills, kept in data/project-skills/<project id>
//   code    — .claude/skills inside one of a project's folders (they move with the code)
export type SkillSource = "library" | "folder" | "project" | "code";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string; // the skill's folder (absolute)
  rel: string; // its path inside the folder it was found in
  source: SkillSource;
  problem?: string; // something to fix in it (e.g. no description)
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  folders: string[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  folders: string[]; // the chat's own folders
  projectId?: string | null;
  cost: number;
}

export interface Settings {
  defaultModel: ModelId; // model for new chats (DeepSeek or Claude)
  thinking: boolean; // DeepSeek defaults
  effort: Effort;
  claudeThinking: boolean; // Claude defaults
  claudeEffort: Effort;
  limits: { deepseek: ProviderLimits; claude: ProviderLimits }; // what each provider may ever do
  claudeMaxSearches: number; // web searches per reply
  claudeBlockedSites: string[]; // sites Claude's web search and page reading never use
  claudeFallback: boolean; // retry a mistaken decline on another Claude model
  skillsFolder: string; // optional extra skills folder on this computer ("" = none); your own skills live in data/skills
  skillsOff: string[]; // your skills (by name, lowercase) switched off everywhere
  summarizeAt: number; // summarize a chat's earlier messages past this many tokens (0 = never)
  systemPrompt: string;
  maxFileChars: number;
  webSearch: boolean; // master flag: shows the Search toggle in the composer
  docsFolder: string; // where DeepSeek saves docs for chats outside a project ("" = off)
  docsAutoSave: string[]; // docs (absolute paths) DeepSeek may save without asking
  githubRepos: string[]; // master allowlist of "owner/name" repos DeepSeek may read
}

export interface KeyStatus {
  configured: boolean;
  source: "env" | "keychain" | "windows" | "settings" | null;
  hint: string | null; // last 4 characters only
}

export interface FolderFile {
  path: string; // relative to the folder root, forward slashes
  size: number; // bytes
  text: boolean; // readable as text
  skipped?: string; // reason it's excluded by default
}

export interface FolderScan {
  root: string;
  name: string;
  tree: string;
  files: FolderFile[];
  truncated: boolean;
}

// Events streamed from POST /api/chat to the browser, one JSON object per line.
export type StreamEvent =
  | { type: "user"; message: UserMessage }
  | { type: "start"; id: string; model: ModelId }
  | { type: "step" }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; summary: string; ok: boolean; sources?: Source[]; diff?: DiffPreview; status?: ToolCall["status"]; result?: string; files?: OutputFile[] }
  | { type: "approval"; id: string; diff?: DiffPreview; command?: CommandRun }
  | { type: "command"; id: string; command: CommandRun } // a command started, finished or was blocked
  | { type: "command_output"; id: string; chunk: string }
  // Messages you sent while it was working went in: the reply so far (if anything was written) and
  // your messages are saved in order, and the reply carries on as `next` (null = starting over).
  | { type: "split"; done: AssistantMessage | null; users: UserMessage[]; next: { id: string; model: ModelId } | null }
  | { type: "step_cut"; drop: boolean; count?: number } // "Answer together now" cut off the step in progress (count: steps to drop)
  | { type: "status"; text: string | null } // e.g. "Summarizing earlier messages…"
  | { type: "summary"; summary: ChatSummaryNote; extraCost: number }
  | { type: "ping" }
  | { type: "usage"; usage: Usage; contextTokens: number }
  | { type: "title"; title: string }
  | { type: "error"; message: string }
  | { type: "done"; message: AssistantMessage };
