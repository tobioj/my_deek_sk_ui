// Long chats: the earlier messages are summarized, and the AI continues from the summary.
// Claude models that support it write the summary themselves (on-demand compaction); for DeepSeek
// and the other Claude models the app asks the model to summarize a transcript. You still see the
// whole chat; only what's sent to the AI gets shorter.
import "server-only";
import type { ChatAccess } from "./access";
import { claudeModelInfo, getClaudeClient } from "./claude";
import { ClaudeSession } from "./claude-session";
import { getClient } from "./deepseek";
import { DEEPSEEK_MODELS, providerOf, type ModelInfo } from "./models";
import { summaryStart } from "./conversation";
import { priceOf } from "./tokens";
import type { Chat, ChatSummaryNote, Settings } from "./types";

const INSTRUCTIONS =
  "Summarize the conversation so far so it can continue from your summary alone: the earlier messages will be removed. " +
  "Keep everything a later turn may need: the user's goals, preferences and instructions; decisions made and why; " +
  "important facts, numbers, names, file paths, code identifiers and commands; what was done (files changed, commands " +
  "run and their results); problems found and open questions; and exactly where things stand, including the user's " +
  "latest request. If there's an earlier summary, fold it in. Write compact notes. Don't call tools; reply with the summary only.";

export async function modelInfo(model: string): Promise<ModelInfo> {
  return providerOf(model) === "claude" ? claudeModelInfo(model) : (DEEPSEEK_MODELS.find((m) => m.id === model) ?? DEEPSEEK_MODELS[0]);
}

// Should this reply start by summarizing? Yes once the last reply's conversation passed the
// size set in Settings (or most of the model's context window), unless that's already summarized.
export function summaryDue(chat: Chat, settings: Settings, info: ModelInfo): string | null {
  if (settings.summarizeAt <= 0) return null;
  const limit = Math.min(settings.summarizeAt, Math.floor(info.context * 0.8));
  let i = chat.messages.length - 1;
  while (i >= 0 && chat.messages[i].role === "user") i--; // the messages being answered now
  const last = chat.messages[i];
  if (!last || last.role !== "assistant" || (last.contextTokens ?? 0) < limit) return null;
  if (chat.summary?.upto === last.id) return null;
  return last.id;
}

// A plain-text transcript of the chat up to `upto`, for models that summarize from text.
function transcript(chat: Chat, upto: string, maxChars: number): string {
  const { start, text } = summaryStart(chat);
  const end = chat.messages.findIndex((m) => m.id === upto);
  const parts: string[] = text ? [`[Earlier summary]\n${text}`] : [];
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[${s.length - n} more characters]` : s);
  for (const m of chat.messages.slice(start, end + 1)) {
    if (m.role === "user") {
      const names = m.attachments.map((a) => a.name);
      parts.push(
        `User: ${m.text}${names.length ? `\n(attached: ${names.join(", ")})` : ""}` +
          (m.files ? `\n${cut(m.files, 4000)}` : "") +
          (m.pdfText ? `\n${cut(m.pdfText, 4000)}` : ""),
      );
    } else {
      const lines: string[] = [];
      for (const s of m.steps) {
        if (s.content) lines.push(s.content);
        for (const c of s.toolCalls ?? []) lines.push(`  [${c.summary ?? c.name}]${c.result ? ` ${cut(c.result, 1500)}` : ""}`);
      }
      if (m.undone) lines.push("  [The user undid this reply's file changes.]");
      if (lines.length) parts.push(`Assistant: ${lines.join("\n")}`);
    }
  }
  let out = parts.join("\n\n");
  if (out.length > maxChars) {
    // Keep the start (earlier summary, the original request) and the most recent part.
    const head = Math.floor(maxChars * 0.3);
    out = `${out.slice(0, head)}\n\n[… ${out.length - maxChars} characters of older conversation left out …]\n\n${out.slice(out.length - (maxChars - head))}`;
  }
  return out;
}

// Summarize a chat's messages up to (and including) `upto`.
export async function summarizeChat(o: {
  chat: Chat;
  settings: Settings;
  access: ChatAccess;
  info: ModelInfo;
  upto: string;
  signal?: AbortSignal;
}): Promise<{ summary: ChatSummaryNote; cost: number }> {
  const { chat, settings, info, upto } = o;
  const end = chat.messages.findIndex((m) => m.id === upto);
  if (end === -1) throw new Error("Nothing to summarize.");
  const now = new Date().toISOString();

  if (info.provider === "claude") {
    const client = await getClaudeClient();
    if (info.summarize === "native") {
      // Claude summarizes the conversation exactly as it sees it, with the same tools and prompt.
      const upTo = { ...chat, messages: chat.messages.slice(0, end + 1) };
      const session = await ClaudeSession.create({ client, chat: upTo, settings, info, access: o.access.access, project: o.access.project, tools: o.access.tools, note: null });
      const r = await session.compact(INSTRUCTIONS, o.signal);
      if (r) {
        const cost = priceOf(chat.model, { cacheMissTokens: r.tokens.input, cacheHitTokens: r.tokens.hit, cacheWriteTokens: r.tokens.write, completionTokens: r.tokens.output }) ?? 0;
        return { summary: { upto, text: r.text, block: r.block, model: chat.model, createdAt: now, cost }, cost };
      }
      // No summary came back: fall through to summarizing a transcript.
    }
    const res = await client.messages.create(
      {
        model: chat.model,
        max_tokens: 8000,
        system: INSTRUCTIONS,
        messages: [{ role: "user", content: transcript(chat, upto, Math.floor(info.context * 2.4)) }],
      },
      { signal: o.signal },
    );
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) throw new Error("Claude didn't return a summary.");
    const u = res.usage;
    const cost =
      priceOf(chat.model, {
        cacheMissTokens: u.input_tokens,
        cacheHitTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        completionTokens: u.output_tokens,
      }) ?? 0;
    return { summary: { upto, text, model: chat.model, createdAt: now, cost }, cost };
  }

  // DeepSeek: Flash writes the summary (cheap and fast, with a 1M-token window).
  const client = await getClient();
  const res = await client.chat.completions.create(
    {
      model: "deepseek-flash",
      max_tokens: 8000,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: transcript(chat, upto, 2_400_000) },
      ],
      ...({ thinking: { type: "disabled" } } as object),
    },
    { signal: o.signal },
  );
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("DeepSeek didn't return a summary.");
  const u = res.usage as unknown as Record<string, number> | undefined;
  const hit = u?.prompt_cache_hit_tokens ?? 0;
  const cost = costOfDeepSeek(u, hit);
  return { summary: { upto, text, model: "deepseek-flash", createdAt: now, cost }, cost };
}

function costOfDeepSeek(u: Record<string, number> | undefined, hit: number): number {
  if (!u) return 0;
  const prompt = u.prompt_tokens ?? 0;
  return priceOf("deepseek-flash", { cacheHitTokens: hit, cacheMissTokens: u.prompt_cache_miss_tokens ?? prompt - hit, completionTokens: u.completion_tokens ?? 0 }) ?? 0;
}
