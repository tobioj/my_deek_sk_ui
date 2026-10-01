// One reply's conversation with Claude: the chat in Claude's format, and each streamed step.
//
// Claude replies are saved with their content blocks exactly as the API returned them (`raw`), and
// sent back unchanged, so Claude keeps its own reasoning between turns and the prompt cache stays
// warm. History the app can't send back as-is (replies from DeepSeek, cut-off replies, tools that
// are switched off now) is sent as plain text instead. Notes from the app (a mode switch) go in as
// system messages where the model accepts them, and stay where they were sent.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type OpenAI from "openai";
import { summaryIntro, summaryStart, systemPrompt, type ToolAccess } from "./conversation";
import {
  acceptsFallbacks,
  acceptsSystemMessages,
  badRequestText,
  bindsThinking,
  downloadOutput,
  newWebTools,
  thinkingOff,
  uploadForSandbox,
} from "./claude";
import { EFFORTS, labelFromId, nearestEffort, type ModelInfo } from "./models";
import { readUpload, updateChat } from "./storage";
import type { ModelSession, StepCallbacks, StepResult } from "./session";
import type { AssistantStep, Chat, OutputFile, Project, Settings, Source, ToolCall, UserMessage } from "./types";

type Msg = BetaMessageParam;
type Block = BetaContentBlockParam;

// Request parts a model turned down (e.g. a setting an older model doesn't know). Remembered while
// the app runs, so the request isn't sent with them again.
const g = globalThis as unknown as { __claudeTurnedDown?: Map<string, Set<string>> };
const turnedDown = (g.__claudeTurnedDown ??= new Map<string, Set<string>>());
const isOff = (model: string, part: string) => turnedDown.get(model)?.has(part) ?? false;
function turnDown(model: string, part: string): boolean {
  const set = turnedDown.get(model) ?? new Set<string>();
  if (set.has(part)) return false;
  set.add(part);
  turnedDown.set(model, set);
  console.warn(`[claude] ${model} turned down "${part}"; retrying without it`);
  return true;
}

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
const SANDBOX_TOOLS = new Set(["code_execution", "bash_code_execution", "text_editor_code_execution"]);
const RESULT_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "code_execution_tool_result",
]);

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function parseInput(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const firstLine = (s: string) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
};

// How a web search, page read or code run went, for its card in the chat.
function describeResult(b: Record<string, unknown>, call: ToolCall | undefined): Partial<ToolCall> & { fileIds?: string[] } {
  const input = parseInput(call?.args ?? "{}");
  const content = b.content as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const err = !Array.isArray(content) && typeof content?.error_code === "string" ? (content.error_code as string).replace(/_/g, " ") : null;
  switch (b.type) {
    case "web_search_tool_result": {
      const q = String(input.query ?? "");
      if (err || !Array.isArray(content)) return { summary: `Web search failed${err ? ` (${err})` : ""}`, ok: false };
      const sources: Source[] = content.filter((r) => r.type === "web_search_result").map((r) => ({ title: String(r.title || r.url), url: String(r.url) }));
      return { summary: `Searched the web for "${q}" (${sources.length} result${sources.length === 1 ? "" : "s"})`, ok: true, sources };
    }
    case "web_fetch_tool_result": {
      const url = String((content as Record<string, unknown>)?.url ?? input.url ?? "");
      if (err) return { summary: `Couldn't read ${hostOf(url) || "the page"} (${err})`, ok: false };
      const doc = (content as Record<string, unknown>)?.content as Record<string, unknown> | undefined;
      return { summary: `Read ${hostOf(url)}`, ok: true, sources: [{ title: String(doc?.title || hostOf(url)), url }] };
    }
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result": {
      if (err || Array.isArray(content) || !content) return { summary: `Code didn't run${err ? ` (${err})` : ""}`, ok: false };
      const code = Number(content.return_code ?? 0);
      const out = [String(content.stdout ?? ""), content.stderr ? `stderr:\n${String(content.stderr)}` : ""].filter(Boolean).join("\n").trim();
      const files = Array.isArray(content.content) ? (content.content as Record<string, unknown>[]).map((f) => String(f.file_id ?? "")).filter(Boolean) : [];
      const src = String(input.command ?? input.code ?? "");
      const result = out || (content.type === "encrypted_code_execution_result" ? "(output kept private by Claude's web search)" : "(no output)");
      // Code web search writes to go through its results (not your code sandbox).
      if (/\bweb_(search|fetch)\s*\(/.test(src))
        return { summary: code === 0 ? "Went through the web results with code" : `Code going through the web results failed (exit ${code})`, ok: code === 0, result, fileIds: files };
      const what = firstLine(src) || "code";
      return { summary: code === 0 ? `Ran ${what}` : `${what} failed (exit ${code})`, ok: code === 0, result, fileIds: files };
    }
    case "text_editor_code_execution_tool_result": {
      const file = String(input.path ?? "a file").split("/").pop();
      if (err || Array.isArray(content) || !content) return { summary: `Couldn't change ${file}${err ? ` (${err})` : ""}`, ok: false };
      const kind = String(content.type ?? "");
      const verb = kind.includes("create") ? (content.is_file_update ? "Rewrote" : "Created") : kind.includes("view") ? "Looked at" : "Edited";
      return { summary: `${verb} ${file} in the sandbox`, ok: true, result: typeof content.content === "string" ? content.content : undefined };
    }
  }
  return { summary: "Done", ok: true };
}

export class ClaudeSession implements ModelSession {
  private messages: Msg[] = [];
  private system = "";
  private tools: { name: string; description: string; input_schema: Record<string, unknown> }[] = [];
  private toolNames = new Set<string>();
  private compaction = false; // the history starts with a summary block from Claude
  // Web searches and code runs in this reply, by id. Kept across steps: a paused turn's search
  // gets its result in the next step.
  private serverCalls = new Map<string, ToolCall & { fileIds?: string[] }>();
  container: { id: string; expiresAt?: string | null } | undefined;

  private constructor(
    private client: Anthropic,
    private chat: Chat,
    private settings: Settings,
    private info: ModelInfo,
    private access: ToolAccess,
  ) {}

  static async create(o: {
    client: Anthropic;
    chat: Chat;
    settings: Settings;
    info: ModelInfo;
    access: ToolAccess;
    project: Project | null;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    note: string | null; // a note for this reply (sent after your message)
  }): Promise<ClaudeSession> {
    const s = new ClaudeSession(o.client, o.chat, o.settings, o.info, o.access);
    s.system = await systemPrompt(o.chat, o.settings, o.access, o.project);
    s.tools = o.tools.map((t) => {
      const f = (t as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
      return { name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object", properties: {} } };
    });
    s.toolNames = new Set(s.tools.map((t) => t.name));
    const c = o.chat.container;
    s.container = c && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now() + 60_000) ? c : undefined;
    s.messages = await s.history(o.note);
    return s;
  }

  // ---------- The chat so far ----------

  // Whether a saved reply's server tool blocks can be sent back as they are. The newer web search
  // runs code itself to go through results, so those code blocks are fine whenever it's on.
  private serverToolOn(name: string) {
    if (WEB_TOOLS.has(name)) return this.access.web;
    if (SANDBOX_TOOLS.has(name)) return !!this.access.code || (this.access.web && newWebTools(this.info.id) && !isOff(this.info.id, "newweb"));
    return false;
  }

  private async history(note: string | null): Promise<Msg[]> {
    const { chat } = this;
    const out: Msg[] = [];
    const uploads: { message: string; attachment: string; fileId: string }[] = [];
    const { start, text } = summaryStart(chat);
    let intro: string | null = null;
    if (text) {
      if (chat.summary?.block && this.info.summarize === "native") {
        out.push({ role: "assistant", content: [chat.summary.block as Block] });
        this.compaction = true;
      } else intro = summaryIntro(text);
    }
    for (const m of chat.messages.slice(start)) {
      if (m.role === "user") {
        const blocks = await this.userBlocks(m, uploads);
        if (intro) blocks.unshift({ type: "text", text: intro });
        intro = null;
        out.push({ role: "user", content: blocks });
        continue;
      }
      if (m.note) out.push({ role: "system", content: m.note });
      this.assistantTurns(m.steps, out);
      if (m.undone && m.changes?.length) out.push({ role: "user", content: [{ type: "text", text: "[The user undid all file changes from this reply.]" }] });
    }
    if (intro) out.push({ role: "user", content: [{ type: "text", text: intro }] });
    if (note) out.push({ role: "system", content: note });
    await this.saveFileIds(uploads);
    return out;
  }

  // One reply: each API call's steps become an assistant message (as returned, when possible),
  // followed by the results of the app's tools it called.
  private assistantTurns(steps: AssistantStep[], out: Msg[]) {
    const groups: AssistantStep[][] = [];
    for (const s of steps) {
      if (s.cont && groups.length) groups[groups.length - 1].push(s);
      else groups.push([s]);
    }
    for (const group of groups) {
      const raw = group[0].raw as { type: string; name?: string; id?: string }[] | undefined;
      const calls = group.flatMap((s) => s.toolCalls ?? []);
      const usable =
        !!raw?.length &&
        raw.every((b) => (b.type !== "tool_use" || this.toolNames.has(b.name ?? "")) && (b.type !== "server_tool_use" || this.serverToolOn(b.name ?? "")));
      let answered: ToolCall[];
      if (usable) {
        out.push({ role: "assistant", content: raw as unknown as Block[] });
        answered = raw
          .filter((b) => b.type === "tool_use")
          .map((b) => calls.find((c) => c.id === b.id) ?? { id: b.id!, name: b.name ?? "", args: "{}", result: "(cancelled before the tool ran)", ok: false });
      } else {
        // Sent as text: what it said, with a short note for each tool that's off now.
        answered = calls.filter((c) => !c.server && this.toolNames.has(c.name));
        const notes = calls.filter((c) => !answered.includes(c)).map((c) => `[Earlier: ${c.summary ?? c.name}]`);
        const text = [...notes, ...group.map((s) => s.content)].filter(Boolean).join("\n\n").trim();
        const blocks: Block[] = text ? [{ type: "text", text }] : [];
        for (const c of answered) blocks.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: parseInput(c.args) });
        if (!blocks.length) continue;
        out.push({ role: "assistant", content: blocks });
      }
      if (answered.length) out.push({ role: "user", content: answered.map((c) => this.toolResult(c)) });
    }
  }

  private toolResult(c: ToolCall): Block {
    return {
      type: "tool_result",
      tool_use_id: safeId(c.id),
      content: c.result || (c.ok === false ? "(failed)" : "(cancelled before the tool ran)"),
      ...(c.ok === false ? { is_error: true } : {}),
    };
  }

  // Your message: its images and PDFs (which Claude reads itself), files for the code sandbox,
  // attached text, and what you typed.
  private async userBlocks(m: UserMessage, uploads: { message: string; attachment: string; fileId: string }[]): Promise<Block[]> {
    const blocks: Block[] = [];
    const notes: string[] = [];
    let pdfText = false; // some PDF couldn't be sent as a PDF: send the text instead
    for (const a of m.attachments) {
      if (a.kind === "image" && a.upload) {
        const type = IMAGE_TYPES[a.upload.split(".").pop() ?? ""];
        const bytes = this.info.vision && type ? await readUpload(a.upload) : null;
        if (bytes) blocks.push({ type: "image", source: { type: "base64", media_type: type, data: bytes.toString("base64") } });
        else if (!this.info.vision) notes.push(`[An image was attached, but ${this.info.label} can't see images.]`);
      } else if (a.upload?.endsWith(".pdf")) {
        const bytes = this.info.pdf ? await readUpload(a.upload) : null;
        if (bytes) {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") }, title: a.name.split("/").pop() });
        } else pdfText = true;
      } else if (a.sandbox && a.upload && this.access.code) {
        let fileId = a.fileId;
        if (!fileId) {
          const bytes = await readUpload(a.upload);
          if (!bytes) continue;
          fileId = await uploadForSandbox(this.client, bytes, a.name.split("/").pop() || "file");
          a.fileId = fileId;
          uploads.push({ message: m.id, attachment: a.id, fileId });
        }
        blocks.push({ type: "container_upload", file_id: fileId });
      }
    }
    const text = [m.files, pdfText || !m.attachments.some((a) => a.upload?.endsWith(".pdf")) ? m.pdfText : null, m.text, ...notes]
      .filter(Boolean)
      .join("\n\n");
    if (text) blocks.push({ type: "text", text });
    if (!blocks.length) blocks.push({ type: "text", text: "(empty message)" });
    return blocks;
  }

  // Files uploaded for the sandbox keep their id, so they aren't uploaded again next time.
  private async saveFileIds(uploads: { message: string; attachment: string; fileId: string }[]) {
    if (!uploads.length) return;
    await updateChat(this.chat.id, (c) => {
      for (const u of uploads) {
        const m = c.messages.find((x) => x.id === u.message);
        const a = m?.role === "user" ? m.attachments.find((x) => x.id === u.attachment) : undefined;
        if (a) a.fileId = u.fileId;
      }
    }).catch(() => {});
  }

  // ---------- During the reply ----------

  async addUsers(users: UserMessage[]) {
    const uploads: { message: string; attachment: string; fileId: string }[] = [];
    for (const u of users) this.messages.push({ role: "user", content: await this.userBlocks(u, uploads) });
    await this.saveFileIds(uploads);
  }

  addAssistant(steps: AssistantStep[], result: StepResult | null) {
    if (result?.raw?.length) {
      this.messages.push({ role: "assistant", content: result.raw as Block[] });
      return;
    }
    // Cut off: only what it had written (and a note for searches it made) goes back.
    const notes = steps.flatMap((s) => s.toolCalls ?? []).filter((c) => c.server && c.summary).map((c) => `[Earlier: ${c.summary}]`);
    const text = [...notes, ...steps.map((s) => s.content)].filter(Boolean).join("\n\n").trim();
    if (text) this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
  }

  addToolResults(calls: ToolCall[]) {
    if (calls.length) this.messages.push({ role: "user", content: calls.map((c) => this.toolResult(c)) });
  }

  // Notes become system messages where the model takes them; otherwise text after your message.
  private materialize(): Msg[] {
    const id = this.chat.model;
    if (acceptsSystemMessages(id) && !isOff(id, "system")) return this.messages;
    const out: Msg[] = [];
    for (const m of this.messages) {
      if (m.role !== "system") {
        out.push(m);
        continue;
      }
      const note: Block = { type: "text", text: typeof m.content === "string" ? m.content : "" };
      const prev = out[out.length - 1];
      if (prev?.role === "user") out[out.length - 1] = { ...prev, content: [...(typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content), note] };
      else out.push({ role: "user", content: [note] });
    }
    return out;
  }

  private params(): MessageCreateParamsStreaming {
    const id = this.chat.model;
    const info = this.info;
    const off = (part: string) => isOff(id, part);
    const betas = new Set<string>();
    const maxTokens = Math.min(info.maxOutput || 64_000, 64_000);
    let effort = !off("effort") ? nearestEffort(this.chat.effort, info.efforts) : null;
    let thinking: Record<string, unknown> | undefined;
    const think = info.thinking === "always" || (info.thinking === "toggle" && this.chat.thinking);
    if (info.thinkingType === "adaptive") {
      const offMode = thinkingOff(id, "adaptive");
      if (think || !offMode || off("thinkoff")) {
        thinking = { type: "adaptive", ...(off("display") ? {} : { display: "summarized" }) };
        // Editing history (Edit, Retry, a switched-off tool) drops Claude's earlier reasoning
        // instead of failing the request.
        if (bindsThinking(id) && !off("binding")) {
          thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
          betas.add("thinking-binding-controls-2026-08-01");
        }
      } else {
        thinking = { type: offMode };
        if (effort && EFFORTS.indexOf(effort) > EFFORTS.indexOf("high")) effort = "high"; // thinking off allows up to High
      }
    } else if (info.thinkingType === "enabled" && think && !off("budget")) {
      thinking = { type: "enabled", budget_tokens: Math.min(16_000, maxTokens - 4_000) };
    }

    const tools: Record<string, unknown>[] = [...this.tools];
    if (this.access.web) {
      const fresh = newWebTools(id) && !off("newweb");
      const blocked = this.settings.claudeBlockedSites.length ? { blocked_domains: this.settings.claudeBlockedSites } : {};
      tools.push({ type: fresh ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: this.settings.claudeMaxSearches, ...blocked });
      if (!off("webfetch")) {
        tools.push({ type: fresh ? "web_fetch_20260209" : "web_fetch_20250910", name: "web_fetch", max_uses: 10, max_content_tokens: 60_000, ...blocked });
        if (!fresh) betas.add("web-fetch-2025-09-10");
      }
    }
    if (this.access.code && !off("code")) tools.push({ type: "code_execution_20260120", name: "code_execution" });
    if (this.compaction) betas.add("compact-2026-09-04");
    const fallback = this.settings.claudeFallback && acceptsFallbacks(id) && !off("fallbacks");
    if (fallback) betas.add("server-side-fallback-2026-07-01");

    return {
      model: id,
      max_tokens: maxTokens,
      stream: true,
      // The system prompt has its own cache point; the growing conversation is cached automatically.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      messages: this.materialize(),
      ...(tools.length ? { tools } : {}),
      ...(off("autocache") ? {} : { cache_control: { type: "ephemeral" } }),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(this.container && this.access.code ? { container: this.container.id } : {}),
      ...(fallback ? { fallbacks: "default" } : {}),
      ...(betas.size ? { betas: [...betas] } : {}),
    } as unknown as MessageCreateParamsStreaming;
  }

  // A model that doesn't accept part of the request says so: leave that part out and try again.
  private learn(why: string): boolean {
    const id = this.chat.model;
    const has = (...words: string[]) => words.some((w) => why.includes(w));
    if (has("fallbacks")) return turnDown(id, "fallbacks");
    if (has("block_binding", "prefix_mismatch_behavior", "thinking-binding-controls")) return turnDown(id, "binding");
    if (has("thinking.display") || (why.includes("display") && why.includes("thinking"))) return turnDown(id, "display");
    if (has("thinking.type.disabled", "between_tools")) return turnDown(id, "thinkoff");
    if (has("budget_tokens", "thinking.type.enabled")) return turnDown(id, "budget");
    if (has("role 'system'", 'role "system"', "system role", "system message")) return turnDown(id, "system");
    if (has("output_config.effort", "effort is not supported", "effort level")) return turnDown(id, "effort");
    if (has("eager_input_streaming")) return turnDown(id, "eager");
    if (why.includes("compaction") && this.compaction) {
      // This model can't read Claude's summary block: send the summary as text instead.
      this.compaction = false;
      this.messages[0] = { role: "user", content: [{ type: "text", text: summaryIntro(this.chat.summary?.text ?? "") }] };
      return true;
    }
    // Tool versions the model doesn't take (the error names the tool type).
    if (has("web_search_20260209", "web_fetch_20260209")) return turnDown(id, "newweb");
    if (has("web_fetch_20250910")) return turnDown(id, "webfetch");
    if (has("code_execution_20260120")) return turnDown(id, "code");
    if (this.container && why.includes("container") && !why.includes("container_upload")) {
      this.container = undefined; // the old sandbox is gone: start a new one
      return true;
    }
    if (has("cache_control")) return turnDown(id, "autocache");
    return false;
  }

  // Ask Claude to summarize the conversation so far (on-demand compaction). The block it returns
  // replaces those messages from then on. null if no summary came back.
  async compact(instructions: string, signal?: AbortSignal): Promise<{ block: unknown; text: string; tokens: { input: number; output: number; hit: number; write: number } } | null> {
    for (let attempt = 0; ; attempt++) {
      const p = this.params() as unknown as Record<string, unknown>;
      delete p.stream;
      delete p.fallbacks;
      delete p.container;
      const betas = new Set([...((p.betas as string[] | undefined) ?? []), "compact-2026-09-04"]);
      betas.delete("server-side-fallback-2026-07-01");
      p.betas = [...betas];
      p.max_tokens = Math.min(16_000, this.info.maxOutput || 16_000);
      p.compaction = { type: "summarize", instructions };
      try {
        const res = await this.client.beta.messages.create(p as unknown as Parameters<Anthropic["beta"]["messages"]["create"]>[0], { signal });
        const msg = res as unknown as { stop_reason: string; content: { type: string; content?: string | null }[]; usage: { iterations?: Record<string, number>[] | null } };
        const block = msg.content.find((b) => b.type === "compaction");
        if (msg.stop_reason !== "compaction" || !block?.content) return null;
        const tokens = { input: 0, output: 0, hit: 0, write: 0 };
        for (const it of msg.usage.iterations ?? []) {
          tokens.input += it.input_tokens ?? 0;
          tokens.output += it.output_tokens ?? 0;
          tokens.hit += it.cache_read_input_tokens ?? 0;
          tokens.write += it.cache_creation_input_tokens ?? 0;
        }
        return { block, text: block.content, tokens };
      } catch (e) {
        const why = badRequestText(e);
        if (why && attempt < 6 && this.learn(why)) continue;
        throw e;
      }
    }
  }

  async stream(cb: StepCallbacks, signal: AbortSignal): Promise<StepResult> {
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        return await this.run(cb, signal, () => (started = true));
      } catch (e) {
        const why = badRequestText(e);
        if (why && !started && attempt < 6 && this.learn(why)) continue;
        throw e;
      }
    }
  }

  private async run(cb: StepCallbacks, signal: AbortSignal, started: () => void): Promise<StepResult> {
    const stream = this.client.beta.messages.stream(this.params(), { signal });
    const tracked = new Map<number, { id: string; name: string; json: string; input?: unknown }>();
    const servers = this.serverCalls;
    let afterServer = false; // a web search or code run just happened: what follows is a new step
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block as BetaContentBlock;
        if (b.type === "text" || b.type === "thinking" || b.type === "redacted_thinking") {
          if (afterServer) cb.onSegment();
          afterServer = false;
          if (b.type === "text" && b.text) {
            started();
            cb.onText(b.text);
          } else if (b.type === "thinking" && b.thinking) {
            started();
            cb.onReasoning(b.thinking);
          }
        } else if (b.type === "server_tool_use") {
          // Calls Claude makes from inside its own code (e.g. a search during web search's filtering)
          // arrive with their input here instead of as deltas.
          tracked.set(ev.index, { id: b.id, name: b.name, json: "", input: b.input });
        } else if (RESULT_TYPES.has(b.type)) {
          const r = b as unknown as Record<string, unknown>;
          const call = servers.get(String(r.tool_use_id));
          const { fileIds, ...patch } = describeResult(r, call);
          if (call) Object.assign(call, patch, fileIds?.length ? { fileIds } : {});
          cb.onServerResult(String(r.tool_use_id), patch);
          afterServer = true;
        }
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "text_delta") {
          started();
          cb.onText(d.text);
        } else if (d.type === "thinking_delta") {
          started();
          cb.onReasoning(d.thinking);
        } else if (d.type === "input_json_delta") {
          const t = tracked.get(ev.index);
          if (t) t.json += d.partial_json;
        }
      } else if (ev.type === "content_block_stop") {
        const t = tracked.get(ev.index);
        if (t) {
          const name = WEB_TOOLS.has(t.name) ? t.name : "code_execution";
          const given = t.input && typeof t.input === "object" && Object.keys(t.input).length ? JSON.stringify(t.input) : "";
          const call: ToolCall = { id: t.id, name, args: t.json || given || "{}", server: true };
          servers.set(t.id, call);
          started();
          cb.onServerCall({ ...call });
          afterServer = true;
        }
      }
    }
    const final = await stream.finalMessage();

    // Files Claude's code made: save them so you can open them from the chat.
    for (const call of servers.values()) {
      if (!call.fileIds?.length || call.files) continue;
      const files = (await Promise.all(call.fileIds.map((f) => downloadOutput(this.client, f)))).filter((f): f is OutputFile => !!f);
      call.files = files;
      if (files.length) cb.onServerResult(call.id, { files });
    }

    const u = final.usage;
    const hit = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const miss = u.input_tokens;
    const calls = final.content
      .filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) }));
    const fallbacks = final.content.filter((b): b is Extract<BetaContentBlock, { type: "fallback" }> => b.type === "fallback");
    const last = fallbacks[fallbacks.length - 1];
    if (final.container) this.container = { id: final.container.id, expiresAt: final.container.expires_at };
    const stop = final.stop_reason;
    return {
      calls,
      finish:
        stop === "tool_use"
          ? "tool_calls"
          : stop === "max_tokens"
            ? "length"
            : stop === "pause_turn"
              ? "pause"
              : stop === "refusal"
                ? "refusal"
                : stop === "model_context_window_exceeded"
                  ? "context"
                  : "stop",
      usage: {
        prompt: miss + hit + write,
        completion: u.output_tokens,
        hit,
        miss,
        write,
        reasoning: 0,
        searches: u.server_tool_use?.web_search_requests ?? 0,
        context: miss + hit + write + u.output_tokens,
      },
      model: final.model,
      raw: final.content as unknown[],
      refusal: stop === "refusal" ? (final.stop_details?.category ?? null) : undefined,
      fallback: last ? `${labelFromId(last.from.model)} → ${labelFromId(last.to.model)}` : undefined,
      container: this.container,
    };
  }
}
