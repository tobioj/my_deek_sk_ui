// Messages you send while DeepSeek is still replying in that chat. The chat route hands them to
// DeepSeek at the reply's next break (between steps), so it takes them into account in the same
// reply. "Answer together now" cuts off what it's writing so it starts again with them.
// Kept on globalThis because each API route is bundled separately but runs in the same process.
import "server-only";
import type { UserMessage } from "./types";

// What the reply is doing right now: writing (a model call), running tools, or waiting for your approval.
export type Phase = "model" | "tools" | "approval";

interface Reply {
  queue: UserMessage[];
  phase: Phase;
  step: AbortController | null; // cuts off the model call in progress
}

const g = globalThis as unknown as { __replyQueues?: Map<string, Reply> };
const replies = (g.__replyQueues ??= new Map<string, Reply>());

// Has a message of yours arrived that the reply hasn't taken yet?
export const hasQueued = (chatId: string) => (replies.get(chatId)?.queue.length ?? 0) > 0;

export function startReply(chatId: string) {
  replies.set(chatId, { queue: [], phase: "model", step: null });
}

// The reply is over: anything still waiting is handed back (the browser puts it back in the message box).
export function endReply(chatId: string): UserMessage[] {
  const r = replies.get(chatId);
  replies.delete(chatId);
  return r?.queue ?? [];
}

export function enqueue(chatId: string, message: UserMessage): boolean {
  const r = replies.get(chatId);
  if (!r) return false; // not replying (any more): send it as a normal message
  r.queue.push(message);
  return true;
}

export function cancelQueued(chatId: string, id: string): UserMessage | null {
  const r = replies.get(chatId);
  const i = r?.queue.findIndex((m) => m.id === id) ?? -1;
  return i === -1 ? null : r!.queue.splice(i, 1)[0];
}

export function takeQueued(chatId: string): UserMessage[] {
  const r = replies.get(chatId);
  if (!r?.queue.length) return [];
  const q = r.queue;
  r.queue = [];
  return q;
}

// When DeepSeek has finished writing: take anything that arrived meanwhile (so the reply carries
// on), or close the queue in the same moment, so nothing sent right then can slip through.
export function finishOrTake(chatId: string): UserMessage[] {
  const q = takeQueued(chatId);
  if (!q.length) replies.delete(chatId);
  return q;
}

export function setPhase(chatId: string, phase: Phase, step: AbortController | null = null) {
  const r = replies.get(chatId);
  if (r) Object.assign(r, { phase, step });
}

// "Answer together now": if DeepSeek is writing, cut it off so it starts again with your message.
// If it's running tools or waiting for your approval, the message goes in as soon as that's done.
export function answerNow(chatId: string): { cut: boolean; phase?: Phase } {
  const r = replies.get(chatId);
  if (!r || !r.queue.length) return { cut: false };
  if (r.phase === "model" && r.step) {
    r.step.abort();
    return { cut: true };
  }
  return { cut: false, phase: r.phase };
}

export const isReplying = (chatId: string) => replies.has(chatId);
