// POST /api/chat/queue — messages you send while DeepSeek is still replying in that chat.
//   { chatId, text, attachments }  add one: DeepSeek reads it at the reply's next step
//                                  (409 if the reply has just finished: send it normally)
//   { chatId, cancel: id }         take one back
//   { chatId, now: true }          "Answer together now": cut off what it's writing and start again
//                                  with your messages
import { buildUserMessage } from "@/lib/conversation";
import { answerNow, cancelQueued, enqueue, isReplying } from "@/lib/queue";
import { discardUploads, getSettings } from "@/lib/storage";
import type { Attachment } from "@/lib/types";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { chatId?: string; text?: string; attachments?: Attachment[]; cancel?: string; now?: boolean };
  if (!body.chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  if (typeof body.cancel === "string") {
    const m = cancelQueued(body.chatId, body.cancel);
    if (m) await discardUploads([m]);
    return Response.json({ ok: !!m });
  }
  if (body.now === true) return Response.json(answerNow(body.chatId));

  const text = (body.text ?? "").trim();
  if (!text && !body.attachments?.length) return Response.json({ error: "Empty message" }, { status: 400 });
  if (!isReplying(body.chatId)) return Response.json({ error: "DeepSeek isn't replying in this chat any more." }, { status: 409 });
  const message = await buildUserMessage(text, body.attachments ?? [], (await getSettings()).maxFileChars);
  if (!enqueue(body.chatId, message)) {
    await discardUploads([message]);
    return Response.json({ error: "DeepSeek isn't replying in this chat any more." }, { status: 409 });
  }
  return Response.json({ message });
}
