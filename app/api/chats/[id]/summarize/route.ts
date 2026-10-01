// POST /api/chats/:id/summarize — "Summarize now": the AI summarizes the chat so far and continues
// from the summary next time (you still see every message).
import { resolveAccess } from "@/lib/access";
import { friendlyClaudeError } from "@/lib/claude";
import { friendlyError } from "@/lib/deepseek";
import { providerOf } from "@/lib/models";
import { isReplying } from "@/lib/queue";
import { getChat, getSettings, updateChat } from "@/lib/storage";
import { modelInfo, summarizeChat } from "@/lib/summarize";

export async function POST(req: Request, ctx: RouteContext<"/api/chats/[id]/summarize">) {
  const { id } = await ctx.params;
  const chat = await getChat(id);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  if (isReplying(id)) return Response.json({ error: "Wait for the reply to finish first." }, { status: 409 });
  const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
  if (!last || chat.summary?.upto === last.id) return Response.json({ error: "There's nothing new to summarize yet." }, { status: 400 });
  const settings = await getSettings();
  try {
    const access = await resolveAccess(chat, settings, req);
    const { summary, cost } = await summarizeChat({ chat, settings, access, info: await modelInfo(chat.model), upto: last.id, signal: req.signal });
    const saved = await updateChat(id, (c) => {
      if (c.messages.some((m) => m.id === summary.upto)) c.summary = summary;
      c.extraCost = (c.extraCost ?? 0) + cost;
    });
    return Response.json({ summary, extraCost: saved?.extraCost ?? cost });
  } catch (e) {
    return Response.json({ error: providerOf(chat.model) === "claude" ? friendlyClaudeError(e) : friendlyError(e) }, { status: 500 });
  }
}
