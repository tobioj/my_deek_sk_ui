// POST /api/chat/approve — { chatId, callId?, decision } answers a pending file change.
// decision: "approve" | "reject" | "approve_all" (approves everything waiting and switches
// the chat to Auto mode, so later changes don't ask either).
import { decide, decideAll } from "@/lib/approvals";
import { updateChat } from "@/lib/storage";

export async function POST(req: Request) {
  const { chatId, callId, decision } = (await req.json().catch(() => ({}))) as { chatId?: string; callId?: string; decision?: string };
  if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  if (decision === "approve_all") {
    await updateChat(chatId, (c) => void (c.mode = "auto")).catch(() => null);
    return Response.json({ ok: true, resolved: decideAll(chatId, "approve") });
  }
  if ((decision !== "approve" && decision !== "reject" && decision !== "approve_remember") || !callId) {
    return Response.json({ error: "callId and a decision of approve or reject are required" }, { status: 400 });
  }
  const found = decide(chatId, callId, decision);
  return found ? Response.json({ ok: true }) : Response.json({ error: "That change is no longer waiting for approval." }, { status: 404 });
}
