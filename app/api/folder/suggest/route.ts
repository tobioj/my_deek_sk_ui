// GET /api/folder/suggest?root=…&q=… — file name suggestions for @-mentions.
import { assertFolder, suggestFiles } from "@/lib/files";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const root = url.searchParams.get("root");
  if (!root) return Response.json([]);
  try {
    return Response.json(await suggestFiles(await assertFolder(root), url.searchParams.get("q") ?? ""));
  } catch {
    return Response.json([]);
  }
}
