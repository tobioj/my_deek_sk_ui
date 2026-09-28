// POST /api/chats/:id/undo — { messageId, force? } restores the files a reply changed.
// Returns { conflicts } when files were modified again since, unless force is true.
import { undoChanges } from "@/lib/edits";
import { getChat, updateChat } from "@/lib/storage";
import type { AssistantMessage } from "@/lib/types";

export async function POST(req: Request, ctx: RouteContext<"/api/chats/[id]/undo">) {
  const { id } = await ctx.params;
  const { messageId, force } = (await req.json().catch(() => ({}))) as { messageId?: string; force?: boolean };
  const chat = await getChat(id);
  const msg = chat?.messages.find((m) => m.id === messageId && m.role === "assistant") as AssistantMessage | undefined;
  if (!msg?.changes?.length) return Response.json({ error: "That reply has no file changes to undo." }, { status: 404 });
  if (msg.undone) return Response.json({ error: "Those changes were already undone." }, { status: 409 });
  try {
    const { conflicts } = await undoChanges(id, msg.changes, force === true);
    if (conflicts.length) return Response.json({ conflicts });
  } catch (e) {
    return Response.json({ error: `Couldn't undo: ${(e as Error).message}` }, { status: 500 });
  }
  await updateChat(id, (c) => {
    const m = c.messages.find((x) => x.id === messageId) as AssistantMessage | undefined;
    if (m) m.undone = true;
  });
  return Response.json({ ok: true });
}
