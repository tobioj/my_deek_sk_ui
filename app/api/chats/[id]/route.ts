// GET / PATCH / DELETE a single chat.
import { stringList, validFolders } from "@/lib/validate";
import { deleteChat, getChat, updateChat } from "@/lib/storage";
import { isEffort, validModelId } from "@/lib/models";
import type { Chat } from "@/lib/types";

export async function GET(_req: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const { id } = await ctx.params;
  const chat = await getChat(id);
  return chat ? Response.json(chat) : Response.json({ error: "Chat not found" }, { status: 404 });
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Partial<Chat>;
  let folders: string[] | undefined;
  if (body.folders !== undefined) {
    try {
      folders = await validFolders(body.folders);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  const chat = await updateChat(id, (c) => {
    if (typeof body.title === "string" && body.title.trim()) c.title = body.title.trim().slice(0, 120);
    if (validModelId(body.model)) c.model = body.model;
    if (typeof body.thinking === "boolean") c.thinking = body.thinking;
    if (isEffort(body.effort)) c.effort = body.effort;
    if (folders !== undefined) {
      c.folders = folders;
      delete c.workspace; // replaced by the folders list
    }
    if (body.hiddenProjectFolders !== undefined) c.hiddenProjectFolders = stringList(body.hiddenProjectFolders);
    if (typeof body.webSearch === "boolean") c.webSearch = body.webSearch;
    if (typeof body.github === "boolean") c.github = body.github;
    if (typeof body.code === "boolean") c.code = body.code;
    if (typeof body.runWithoutAsking === "boolean") c.runWithoutAsking = body.runWithoutAsking;
    if (body.mode === "ask" || body.mode === "plan" || body.mode === "edit" || body.mode === "auto") {
      c.mode = body.mode;
      c.autoApprove = false; // picking a mode replaces the old "always approve" flag
    }
    if (typeof body.autoApprove === "boolean") c.autoApprove = body.autoApprove;
    if (body.projectId === null || typeof body.projectId === "string") c.projectId = body.projectId;
  });
  return chat ? Response.json(chat) : Response.json({ error: "Chat not found" }, { status: 404 });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const { id } = await ctx.params;
  await deleteChat(id);
  return Response.json({ ok: true });
}
