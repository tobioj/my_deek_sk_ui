// Helpers for the Agents panel and the automatic replies to their reports.
// GET  ?chatId=…   that chat's helpers, and whether finished reports are waiting for the AI
//                  (ready: the window should start an automatic reply; paused: 3 in a row already)
// GET             chats with helpers running or reports waiting
// POST {chatId, stop: "all" | ids[]}   stop helpers (you; the chat's own Stop doesn't)
import { MAX_AUTO_ROUNDS } from "@/lib/helper-tools";
import { activeChats, helperRuns, readyReports, runningCount, stopHelpers } from "@/lib/helpers";
import { isReplying } from "@/lib/queue";
import { getChat } from "@/lib/storage";

async function state(chatId: string) {
  const chat = await getChat(chatId);
  if (!chat) return null;
  const waiting = (await readyReports(chatId)).length;
  const replying = isReplying(chatId);
  const paused = (chat.helperAutoRounds ?? 0) >= MAX_AUTO_ROUNDS;
  return {
    chatId,
    running: runningCount(chatId),
    waiting, // reports whose whole round has finished, not yet with the AI
    ready: waiting > 0 && !replying && !paused,
    paused: waiting > 0 && !replying && paused,
  };
}

export async function GET(req: Request) {
  const chatId = new URL(req.url).searchParams.get("chatId");
  if (chatId) {
    const s = await state(chatId);
    if (!s) return Response.json({ error: "Chat not found" }, { status: 404 });
    return Response.json({ ...s, runs: (await helperRuns(chatId)).slice(-50) });
  }
  const chats = (await Promise.all(activeChats().map(state))).filter((s) => s && (s.running || s.waiting));
  return Response.json({ chats });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { chatId?: string; stop?: "all" | string[] };
  if (typeof body.chatId !== "string") return Response.json({ error: "chatId is required" }, { status: 400 });
  const ids = body.stop === "all" ? null : Array.isArray(body.stop) ? body.stop.filter((x): x is string => typeof x === "string") : [];
  return Response.json({ stopped: stopHelpers(body.chatId, ids, "you") });
}
