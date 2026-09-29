// GET /api/processes/:id?since=N — a command's status and its output from position N.
// POST /api/processes/:id — { action: "stop" }: stop it and everything it started.
import { getProc, readOutput, stopProcess } from "@/lib/processes";

export async function GET(req: Request, ctx: RouteContext<"/api/processes/[id]">) {
  const { id } = await ctx.params;
  const proc = getProc(id);
  if (!proc) return Response.json({ error: "That command isn't in the Running list any more." }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get("since")) || 0;
  return Response.json({ info: proc.info, ...readOutput(id, since) });
}

export async function POST(req: Request, ctx: RouteContext<"/api/processes/[id]">) {
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== "stop") return Response.json({ error: "Unknown action" }, { status: 400 });
  const info = await stopProcess(id);
  return info ? Response.json(info) : Response.json({ error: "That command isn't in the Running list any more." }, { status: 404 });
}
