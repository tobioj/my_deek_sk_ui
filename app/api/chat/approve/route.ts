// POST /api/chat/approve — { chatId, callId?, decision, command? } answers a pending file change
// or command. decision: "approve" | "reject" | "approve_remember" | "approve_all" (approves the
// file changes waiting and switches the chat to Auto mode, so later changes don't ask either).
// command: the command as you edited it on the card.
import { decide, decideAll } from "@/lib/approvals";
import { updateChat } from "@/lib/storage";

export async function POST(req: Request) {
  const { chatId, callId, decision, command } = (await req.json().catch(() => ({}))) as { chatId?: string; callId?: string; decision?: string; command?: string };
  if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  if (decision === "approve_all") {
    await updateChat(chatId, (c) => void (c.mode = "auto")).catch(() => null);
    return Response.json({ ok: true, resolved: decideAll(chatId, "approve") });
  }
  if ((decision !== "approve" && decision !== "reject" && decision !== "approve_remember") || !callId) {
    return Response.json({ error: "callId and a decision of approve or reject are required" }, { status: 400 });
  }
  const found = decide(chatId, callId, decision, typeof command === "string" ? command.slice(0, 20_000) : undefined);
  return found ? Response.json({ ok: true }) : Response.json({ error: "That change is no longer waiting for approval." }, { status: 404 });
}
