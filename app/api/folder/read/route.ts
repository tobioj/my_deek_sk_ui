// POST /api/folder/read — { root, paths[] } → labeled file contents to attach.
import { assertFolder, readFilesFromFolder } from "@/lib/files";
import { getSettings } from "@/lib/storage";

export async function POST(req: Request) {
  const { root, paths } = (await req.json().catch(() => ({}))) as { root?: string; paths?: string[] };
  if (!root || !Array.isArray(paths)) return Response.json({ error: "root and paths are required" }, { status: 400 });
  try {
    const abs = await assertFolder(root);
    const { maxFileChars } = await getSettings();
    return Response.json({ root: abs, files: await readFilesFromFolder(abs, paths.slice(0, 2000), maxFileChars) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
