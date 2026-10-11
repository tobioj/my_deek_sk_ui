// One reply's conversation with the model, whichever provider it is. The chat route runs the
// reply (tools, approvals, messages you send meanwhile) and asks the session for each step.
// DeepSeek's and GLM's sessions are here (both take OpenAI-style requests); Claude's is in claude-session.ts.
import "server-only";
import type OpenAI from "openai";
import { appendUser, userContent } from "./conversation";
import { nearestEffort } from "./models";
import type { AssistantStep, Chat, ToolCall, UserMessage } from "./types";

export interface StepCallbacks {
  onReasoning: (delta: string) => void;
  onText: (delta: string) => void;
  // Claude: text or thinking that comes after a web search or code run in the same step goes in a
  // new step, so things show in the order they happened.
  onSegment: () => void;
  onServerCall: (call: ToolCall) => void; // Claude's servers started a web search, page read or code run
  onServerResult: (id: string, patch: Partial<ToolCall>) => void; // …and here's how it went
}

export interface StepUsage {
  prompt: number; // all input tokens
  completion: number;
  hit: number; // input read from the cache
  miss: number; // input not cached
  write: number; // input written to the cache (Claude)
  reasoning: number;
  searches: number; // Claude web searches
  context: number; // size of the conversation after this step
}

export interface StepResult {
  calls: { id: string; name: string; args: string }[]; // tools the app runs
  finish: "stop" | "length" | "tool_calls" | "pause" | "refusal" | "capacity" | "context" | "other";
  usage: StepUsage | null;
  model?: string; // who answered (Claude may hand a declined request to another Claude model)
  raw?: unknown[]; // Claude: the content blocks exactly as returned
  refusal?: string | null; // Claude declined (category, if given)
  fallback?: string; // e.g. "Opus 5.5 → Opus 5"
  container?: { id: string; expiresAt?: string | null }; // Claude's code sandbox
}

export interface ModelSession {
  // Run one step. Throws on errors and when stopped (check the signals).
  stream(cb: StepCallbacks, signal: AbortSignal): Promise<StepResult>;
  // Messages you sent while it was working.
  addUsers(users: UserMessage[]): Promise<void>;
  // What it said in the step (the steps of one API call). result is null when the step was cut off.
  addAssistant(steps: AssistantStep[], result: StepResult | null): void;
  addToolResults(calls: ToolCall[]): void;
  // A note from the app, then a step where it can't use tools (a helper writing its report).
  forceAnswer(note: string): void;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class DeepSeekSession implements ModelSession {
  constructor(
    protected client: OpenAI,
    protected chat: Chat,
    protected messages: Msg[],
    protected tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  ) {}

  // The request for one step.
  protected params(): Record<string, unknown> {
    const { chat } = this;
    const params: Record<string, unknown> = {
      model: chat.model,
      messages: this.messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: chat.thinking ? "enabled" : "disabled" },
    };
    if (chat.thinking) params.reasoning_effort = chat.effort === "max" ? "max" : "high";
    else params.max_tokens = 32_000;
    if (this.tools.length) params.tools = this.tools;
    if (this.tools.length && this.answerNow) params.tool_choice = "none";
    return params;
  }

  // Whether its thinking goes back with each of its messages.
  protected get thinks() {
    return this.chat.thinking;
  }

  protected finishOf(finish: string | null, calls: number): StepResult["finish"] {
    return finish === "length" ? "length" : finish === "insufficient_system_resource" ? "capacity" : calls ? "tool_calls" : finish === "stop" ? "stop" : "other";
  }

  async stream(cb: StepCallbacks, signal: AbortSignal): Promise<StepResult> {
    const params = this.params();
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: Record<string, unknown> | null = null;
    const response = (await this.client.chat.completions.create(params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, {
      signal,
    })) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    for await (const chunk of response) {
      if (chunk.usage) usage = chunk.usage as unknown as Record<string, unknown>;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] };
      if (delta.reasoning_content) cb.onReasoning(delta.reasoning_content);
      if (delta.content) cb.onText(delta.content);
      for (const tc of delta.tool_calls ?? []) {
        const acc = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        pending.set(tc.index, acc);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    let stepUsage: StepUsage | null = null;
    if (usage) {
      const n = (k: string) => (typeof usage![k] === "number" ? (usage![k] as number) : 0);
      const prompt = n("prompt_tokens");
      const completion = n("completion_tokens");
      // DeepSeek reports cache hits as prompt_cache_hit_tokens, GLM as prompt_tokens_details.cached_tokens.
      const cached = (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0;
      const hit = n("prompt_cache_hit_tokens") || cached;
      const miss = usage.prompt_cache_miss_tokens !== undefined ? n("prompt_cache_miss_tokens") : prompt - hit;
      const details = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined;
      stepUsage = { prompt, completion, hit, miss, write: 0, reasoning: details?.reasoning_tokens ?? n("reasoning_tokens"), searches: 0, context: prompt + completion };
    }
    const calls = [...pending.values()].filter((c) => c.name);
    return { calls, finish: this.finishOf(finish, calls.length), usage: stepUsage };
  }

  async addUsers(users: UserMessage[]) {
    for (const u of users) appendUser(this.messages, await userContent(u, this.chat.model));
  }

  addAssistant(steps: AssistantStep[], result: StepResult | null) {
    const content = steps.map((s) => s.content).filter(Boolean).join("\n\n");
    const reasoning = steps.map((s) => s.reasoning).filter(Boolean).join("\n\n");
    const calls = result ? (steps[steps.length - 1].toolCalls ?? []).filter((c) => !c.server) : [];
    if (!content && !calls.length) return;
    const m: Record<string, unknown> = { role: "assistant", content: content || (calls.length ? null : "") };
    if (this.thinks) m.reasoning_content = reasoning;
    if (calls.length) m.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    this.messages.push(m as unknown as Msg);
  }

  addToolResults(calls: ToolCall[]) {
    for (const c of calls) this.messages.push({ role: "tool", tool_call_id: c.id, content: c.result ?? "" });
  }

  protected answerNow = false;
  forceAnswer(note: string) {
    this.messages.push({ role: "user", content: note });
    this.answerNow = true;
  }
}

// GLM (Z.ai). Like DeepSeek, with these differences: it always thinks (effort low, high or max);
// its thinking is kept across tool calls and replies ("preserved thinking"), so it goes back
// exactly as it came; tool calls stream only when asked (tool_stream); usage comes with the last
// chunk by itself; and tool_choice can only be "auto", so a forced answer is just the note.
export class GlmSession extends DeepSeekSession {
  protected params(): Record<string, unknown> {
    const { chat } = this;
    const params: Record<string, unknown> = {
      model: chat.model,
      messages: this.messages,
      stream: true,
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: nearestEffort(chat.effort, ["low", "high", "max"]) ?? "high",
      max_tokens: 65_536,
    };
    if (this.tools.length) {
      params.tools = this.tools;
      params.tool_stream = true;
    }
    return params;
  }

  protected get thinks() {
    return true;
  }

  async stream(cb: StepCallbacks, signal: AbortSignal): Promise<StepResult> {
    const r = await super.stream(cb, signal);
    return r.finish === "refusal" ? { ...r, refusal: "content_filter" } : r;
  }

  protected finishOf(finish: string | null, calls: number): StepResult["finish"] {
    if (finish === "sensitive") return "refusal"; // Z.ai's content filter stopped it
    if (finish === "model_context_window_exceeded") return "context";
    if (finish === "network_error") return "capacity";
    return super.finishOf(finish, calls);
  }
}
