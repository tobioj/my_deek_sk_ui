// The Claude API client, the list of models your key can use, and what each model accepts.
// The key only ever lives on the server (see secrets.ts).
import "server-only";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { forgetCachedSecret, getSecret } from "./secrets";
import { DATA_DIR, saveUploadBytes } from "./storage";
import { atLeast, EFFORTS, finishModelInfo as finish, guessModelInfo, sortModels, type ModelInfo } from "./models";
export { thinkingOff } from "./models";
import { cleanTitle, TITLE_SYSTEM, titleRequest } from "./conversation";
import type { OutputFile } from "./types";

export class MissingClaudeKeyError extends Error {
  constructor() {
    super("No Claude API key is set. Open Settings (bottom-left) and add your key, or switch this chat to a DeepSeek model.");
  }
}

// The app's own setting for where Claude requests go (only for testing). ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN are ignored on purpose: tools like Claude Code set them for themselves (the
// `deepseek` command points them at DeepSeek), and your Claude key must only ever go to Anthropic.
const BASE_URL = process.env.CLAUDE_API_BASE_URL || "https://api.anthropic.com";

export async function getClaudeClient(): Promise<Anthropic> {
  const { key } = await getSecret("anthropic");
  if (!key) throw new MissingClaudeKeyError();
  // Long turns at high effort can take a while; the stream keeps the connection busy meanwhile.
  return new Anthropic({ apiKey: key, authToken: null, baseURL: BASE_URL, maxRetries: 2, timeout: 30 * 60 * 1000 });
}

export function isClaudeAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}

const detailOf = (err: InstanceType<typeof Anthropic.APIError>) =>
  ((err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message).replace(/^\d{3}\s+/, "");

// Turn API failures into messages a person can act on.
export function friendlyClaudeError(err: unknown): string {
  if (err instanceof MissingClaudeKeyError) return err.message;
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Claude. Check your internet connection and try again.";
  if (err instanceof Anthropic.APIError) {
    const detail = detailOf(err);
    if (err.status === 401) {
      forgetCachedSecret("anthropic");
      return "Claude rejected your API key. Open Settings and check it's correct.";
    }
    if (/credit balance/i.test(detail)) return "Your Claude credit balance is too low. Add credit at console.anthropic.com → Billing, then retry.";
    switch (err.status) {
      case 400:
        return `Claude rejected the request: ${detail}`;
      case 403:
        return `Your Claude key can't use this: ${detail}`;
      case 404:
        return `Claude doesn't recognize this model (it may have been retired). Pick another model. (${detail})`;
      case 413:
        return "This message is too large for Claude (over 32 MB with its attachments). Remove some attachments and retry.";
      case 429:
        return "Claude is rate-limiting you. Wait a few seconds and retry.";
      case 500:
      case 502:
      case 503:
      case 529:
        return "Claude's servers are busy right now. Retry in a moment.";
      default:
        return `Claude error ${err.status ?? ""}: ${detail}`.trim();
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export const badRequestText = (err: unknown): string | null =>
  err instanceof Anthropic.BadRequestError ? detailOf(err).toLowerCase() : null;

// ---------- What each model accepts ----------
// The Models API tells us thinking, effort, images, PDFs and summarizing. The rest is by version,
// and if a guess is wrong the API says so and the request is sent again without that part
// (see the Claude session).

// Mid-conversation system messages (used for notes like "the user switched to Edit mode").
export const acceptsSystemMessages = (id: string) =>
  atLeast(id, "opus", 4, 8) || atLeast(id, "fable", 5) || atLeast(id, "mythos", 5) || atLeast(id, "sonnet", 5, 5);
// Thinking tied to the conversation ("preserved thinking"): editing history drops it instead of failing.
export const bindsThinking = (id: string) =>
  atLeast(id, "opus", 5, 5) || atLeast(id, "sonnet", 5, 5) || atLeast(id, "fable", 5, 1) || atLeast(id, "mythos", 5, 1);
// Server-side retry on another Claude model when a request is declined by mistake.
export const acceptsFallbacks = (id: string) => atLeast(id, "opus", 5) || atLeast(id, "fable", 5) || atLeast(id, "sonnet", 5, 5);
// The newer web search and page reading (they filter results with code before reading them).
export const newWebTools = (id: string) =>
  atLeast(id, "opus", 4, 6) || atLeast(id, "sonnet", 4, 6) || atLeast(id, "fable", 0) || atLeast(id, "mythos", 0);

type Caps = Record<string, { supported?: boolean } & Record<string, { supported?: boolean } | null | boolean | undefined>> | null;

function infoFromApi(m: Anthropic.Models.ModelInfo): ModelInfo {
  const g = guessModelInfo(m.id);
  const caps = m.capabilities as unknown as Caps;
  if (!caps) return finish({ ...g, label: m.display_name?.replace(/^Claude\s+/i, "") || g.label, createdAt: m.created_at });
  const sub = (k: string, s: string) => (caps[k] as Record<string, { supported?: boolean } | null> | undefined)?.[s]?.supported === true;
  const thinkingTypes = (caps.thinking as unknown as { types?: Record<string, { supported?: boolean }> } | undefined)?.types;
  const thinkingType: ModelInfo["thinkingType"] = thinkingTypes?.adaptive?.supported
    ? "adaptive"
    : thinkingTypes?.enabled?.supported
      ? "enabled"
      : caps.thinking?.supported
        ? g.thinkingType
        : undefined;
  return finish({
    ...g,
    label: m.display_name?.replace(/^Claude\s+/i, "") || g.label,
    vision: caps.image_input?.supported ?? g.vision,
    pdf: caps.pdf_input?.supported ?? g.pdf,
    context: m.max_input_tokens ?? g.context,
    maxOutput: m.max_tokens ?? g.maxOutput,
    efforts: caps.effort?.supported ? EFFORTS.filter((e) => sub("effort", e)) : [],
    thinkingType,
    summarize: caps.compaction?.supported || sub("context_management", "compact_20260112") ? "native" : "app",
    createdAt: m.created_at,
  });
}

// ---------- The model list (from your key, kept for 12 hours) ----------

const MODELS_FILE = path.join(DATA_DIR, "claude-models.json");
const FRESH_MS = 12 * 60 * 60 * 1000;
const g = globalThis as unknown as { __claudeModels?: { at: number; models: ModelInfo[] } | null; __claudeModelsLoading?: Promise<ModelInfo[]> | null };

async function fetchModels(): Promise<ModelInfo[]> {
  const client = await getClaudeClient();
  const list: ModelInfo[] = [];
  // The compaction beta adds whether each model can summarize long chats.
  for await (const m of client.models.list({ limit: 100, betas: ["compact-2026-09-04"] })) list.push(infoFromApi(m));
  const models = sortModels(list);
  g.__claudeModels = { at: Date.now(), models };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(MODELS_FILE, JSON.stringify(g.__claudeModels, null, 2)).catch(() => {});
  return models;
}

// Used until the list from your key arrives (e.g. if the Models API can't be reached).
const KNOWN = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

// The Claude models your key can use ([] without a key). Refreshed in the background when old.
export async function claudeModels(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
  if (!(await getSecret("anthropic")).key) return [];
  if (!g.__claudeModels) {
    try {
      g.__claudeModels = JSON.parse(await fs.readFile(MODELS_FILE, "utf8"));
    } catch {}
  }
  const cached = g.__claudeModels;
  const stale = !cached || Date.now() - cached.at > FRESH_MS;
  if (opts.refresh || !cached?.models.length) {
    g.__claudeModelsLoading ??= fetchModels().finally(() => (g.__claudeModelsLoading = null));
    try {
      return await g.__claudeModelsLoading;
    } catch (e) {
      if (opts.refresh) throw e;
      return cached?.models.length ? cached.models : KNOWN.map(guessModelInfo);
    }
  }
  if (stale) g.__claudeModelsLoading ??= fetchModels().catch(() => cached.models).finally(() => (g.__claudeModelsLoading = null));
  return cached.models;
}

export async function forgetClaudeModels() {
  g.__claudeModels = null;
  await fs.rm(MODELS_FILE, { force: true });
}

// One model's details: from your key's list, or a guess from its name.
export async function claudeModelInfo(id: string): Promise<ModelInfo> {
  const list = await claudeModels().catch(() => []);
  return list.find((m) => m.id === id) ?? guessModelInfo(id);
}

// ---------- Small requests ----------

export async function claudeTitle(client: Anthropic, userText: string, replyText: string): Promise<string | null> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 30,
      system: TITLE_SYSTEM,
      messages: [{ role: "user", content: titleRequest(userText, replyText) }],
    });
    return cleanTitle(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  } catch {
    return null;
  }
}

// A file you attached, sent to Claude's Files API so its code sandbox can open it.
export async function uploadForSandbox(client: Anthropic, bytes: Buffer, name: string): Promise<string> {
  const meta = await client.files.upload({ file: await toFile(bytes, name) });
  return meta.id;
}

// A file Claude's code made: downloaded into data/uploads so you can open it from the chat.
export async function downloadOutput(client: Anthropic, fileId: string): Promise<OutputFile | null> {
  try {
    const meta = await client.files.retrieveMetadata(fileId);
    const res = await client.files.download(fileId);
    const bytes = Buffer.from(await res.arrayBuffer());
    const name = path.basename(meta.filename || "file").replace(/[^\w.\- ()]+/g, "_") || "file";
    const upload = await saveUploadBytes(bytes, path.extname(name).slice(1) || "bin");
    return { name, upload, size: bytes.length };
  } catch {
    return null;
  }
}
