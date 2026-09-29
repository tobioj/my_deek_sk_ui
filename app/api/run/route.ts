// POST /api/run — { chatId, command, folder?, confirmed? }: the ▶ Run button on a code block.
// You clicked it, so it runs without asking — but only in a project with Terminal on, only in
// the project's folders, in the same sandbox, and never a blocked command. Risky ones
// (deleting folders, secret files…) need `confirmed: true` after the browser asks you.
import { classifyCommand } from "@/lib/commands";
import { chatLinkedFolders } from "@/lib/folders";
import { resolveRoots } from "@/lib/roots";
import { getChat, getProject } from "@/lib/storage";
import { appPortsFor, startUserCommand, terminalAccess } from "@/lib/terminal";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { chatId?: string; command?: string; folder?: string; confirmed?: boolean };
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!body.chatId || !command) return Response.json({ error: "chatId and command are required" }, { status: 400 });
  const chat = await getChat(body.chatId);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  const project = chat.projectId ? await getProject(chat.projectId) : null;
  const access = terminalAccess(project, await resolveRoots(chatLinkedFolders(chat, project)), appPortsFor(req));
  if (!access) {
    return Response.json({ error: "Commands only run in a project with Terminal switched on (Project settings → Terminal) and one of its folders linked." }, { status: 403 });
  }
  const root = access.roots.find((r) => r.name === body.folder) ?? access.roots[0];
  const verdict = classifyCommand(command, access.platform, access.appPorts);
  if (verdict.level === "blocked") return Response.json({ error: `Can't run this: ${verdict.reason}.`, blocked: true }, { status: 400 });
  if (verdict.level === "always_ask" && body.confirmed !== true) return Response.json({ confirm: verdict.reason }, { status: 409 });
  try {
    return Response.json(await startUserCommand(access, root, command, chat.id));
  } catch (e) {
    return Response.json({ error: `The command couldn't start: ${(e as Error).message}` }, { status: 500 });
  }
}
