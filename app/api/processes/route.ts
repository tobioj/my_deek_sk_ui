// GET /api/processes — the Running list (?format=text for the deepseek-chat command).
// POST /api/processes — { action: "stop_all" | "clear" }: stop everything, or clear finished ones.
import { clearFinished, initProcesses, listProcesses, stopAll } from "@/lib/processes";
import type { ProcessInfo } from "@/lib/types";

const line = (p: ProcessInfo) =>
  `${p.status === "running" ? "running " : p.status.padEnd(8)} ${p.command}  (${p.projectName} · ${p.folder}${p.ports.length ? ` · localhost:${p.ports.join(", ")}` : ""})`;

export async function GET(req: Request) {
  await initProcesses();
  const list = listProcesses();
  if (new URL(req.url).searchParams.get("format") === "text") {
    const live = list.filter((p) => p.status === "running" || p.status === "stopping" || p.status === "stop_failed");
    return new Response(live.length ? live.map(line).join("\n") + "\n" : "", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return Response.json(list);
}

export async function POST(req: Request) {
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "stop_all") {
    const stopped = await stopAll();
    return Response.json({ stopped, failed: stopped.filter((p) => p.status === "stop_failed").length });
  }
  if (action === "clear") return Response.json({ cleared: clearFinished() });
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
