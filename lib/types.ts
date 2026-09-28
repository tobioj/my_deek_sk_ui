// Shared types used by both the server (API routes) and the browser (components).

export type ModelId = "deepseek-flash" | "deepseek-v4-pro";
export type Effort = "high" | "max";

export const MODELS: Record<ModelId, { label: string; description: string; vision: boolean }> = {
  // `deepseek-flash` always points at DeepSeek's newest Flash model (DeepSeek-V4.1-Flash since
  // Sept 10, 2026); `deepseek-v4-pro` is DeepSeek-V4-Pro-0813. Update the labels if DeepSeek upgrades them.
  "deepseek-flash": { label: "V4.1 Flash", description: "Fast and cheap. Can see images.", vision: true },
  "deepseek-v4-pro": { label: "V4 Pro", description: "Smartest (version 0813). Text only.", vision: false },
};

export const CONTEXT_LIMIT = 1_000_000;

// What DeepSeek may do with the chat's project folder.
export type Mode = "ask" | "plan" | "edit" | "auto";
export const MODES: Record<Mode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Read-only: DeepSeek reads your project and answers questions" },
  plan: { label: "Plan", hint: "DeepSeek reads your project and proposes a step-by-step plan, without changing anything" },
  edit: { label: "Edit", hint: "DeepSeek can create, change and delete files. You approve every change first" },
  auto: { label: "Auto", hint: "DeepSeek makes all the changes without asking. Each reply can still be undone" },
};
export const isEditingMode = (m: Mode | undefined) => m === "edit" || m === "auto";

export interface Attachment {
  id: string;
  name: string; // display name — a relative path for files that came from a folder
  kind: "file" | "image" | "pasted";
  size: number; // characters for text, bytes for images
  truncated?: boolean;
  content?: string; // text content (only sent browser → server, then folded into `files`)
  dataUrl?: string; // image data (only sent browser → server, then saved to data/uploads)
  upload?: string; // saved image filename in data/uploads
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
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cost: number; // USD
}

export interface UserMessage {
  id: string;
  role: "user";
  createdAt: string;
  text: string; // what the user typed
  files?: string; // attached file text, wrapped in === FILE: path === markers
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
  github?: boolean; // DeepSeek may read GitHub (only if set up in Settings)
  autoApprove?: boolean; // older chats: Edit mode with "always approve" (now the same as Auto)
  projectId?: string | null;
  messages: ChatMessage[];
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
  createdAt: string;
  updatedAt: string;
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
  defaultModel: ModelId;
  thinking: boolean;
  effort: Effort;
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
  | { type: "tool_result"; id: string; summary: string; ok: boolean; sources?: Source[]; diff?: DiffPreview; status?: ToolCall["status"] }
  | { type: "approval"; id: string; diff: DiffPreview }
  | { type: "ping" }
  | { type: "usage"; usage: Usage; contextTokens: number }
  | { type: "title"; title: string }
  | { type: "error"; message: string }
  | { type: "done"; message: AssistantMessage };
