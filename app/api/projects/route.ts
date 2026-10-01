// GET /api/projects — list projects. POST /api/projects — create one.
import { validFolders } from "@/lib/validate";
import { createProject, listProjects } from "@/lib/storage";
import type { Project } from "@/lib/types";
import { cleanFiles, repoList, skillFields, terminalFields } from "./shared";

export async function GET() {
  return Response.json(await listProjects());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Project>;
  let folders: string[] = [];
  try {
    folders = await validFolders(body.folders);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const project = await createProject({
    name: typeof body.name === "string" ? body.name.slice(0, 100) : undefined,
    context: typeof body.context === "string" ? body.context : "",
    folders,
    files: cleanFiles(body.files),
    isolated: body.isolated === true,
    docsFolder: typeof body.docsFolder === "string" && body.docsFolder.trim() ? body.docsFolder.trim() : null,
    githubRepos: repoList(body.githubRepos),
    ...terminalFields(body as Record<string, unknown>),
    ...skillFields(body as Record<string, unknown>),
  });
  return Response.json(project);
}
