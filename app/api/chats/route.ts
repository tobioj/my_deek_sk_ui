// GET /api/chats?q=… — list saved chats (optionally searching titles and messages)
// POST /api/chats — create a new chat
import { createChat, getProject, listChats } from "@/lib/storage";
import type { Chat } from "@/lib/types";
import { stringList, validFolders } from "@/lib/validate";
import { isEffort, validModelId } from "@/lib/models";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return Response.json(await listChats(q));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Chat>;
  const project = typeof body.projectId === "string" ? await getProject(body.projectId) : null;
  let folders: string[] = [];
  try {
    folders = await validFolders(body.folders);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const chat = await createChat({
    model: validModelId(body.model) ? body.model : undefined,
    thinking: typeof body.thinking === "boolean" ? body.thinking : undefined,
    effort: isEffort(body.effort) ? body.effort : undefined,
    folders,
    hiddenProjectFolders: stringList(body.hiddenProjectFolders),
    webSearch: body.webSearch === true,
    github: body.github === true,
    code: body.code === true,
    mode: body.mode === "plan" || body.mode === "edit" || body.mode === "auto" ? body.mode : "ask",
    runWithoutAsking: body.runWithoutAsking === true,
    projectId: project?.id ?? null,
  });
  return Response.json(chat);
}
