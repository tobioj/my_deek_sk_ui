// GET /api/folder/git?root=… — is the folder a Git repo, and does it have uncommitted changes?
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertFolder } from "@/lib/files";

const run = promisify(execFile);

export async function GET(req: Request) {
  const rootParam = new URL(req.url).searchParams.get("root");
  if (!rootParam) return Response.json({ repo: false });
  try {
    const root = await assertFolder(rootParam);
    const { stdout: inside } = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
    if (inside.trim() !== "true") return Response.json({ repo: false });
    const { stdout } = await run("git", ["-C", root, "status", "--porcelain"], { timeout: 10000 });
    const changed = stdout.split("\n").filter(Boolean).length;
    return Response.json({ repo: true, dirty: changed > 0, changed });
  } catch {
    return Response.json({ repo: false });
  }
}
