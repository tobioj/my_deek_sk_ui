// POST /api/folder — { path } → folder map + checklist of files.
import { scanFolder } from "@/lib/files";

export async function POST(req: Request) {
  const { path } = (await req.json().catch(() => ({}))) as { path?: string };
  if (!path?.trim()) return Response.json({ error: "Enter a folder path" }, { status: 400 });
  try {
    return Response.json(await scanFolder(path));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
