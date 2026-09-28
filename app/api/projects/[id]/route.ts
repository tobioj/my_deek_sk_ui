// GET / PATCH / DELETE a project. Deleting keeps its chats (they become ungrouped).
import { validFolders } from "@/lib/validate";
import { deleteProject, getProject, saveProject } from "@/lib/storage";
import type { Project } from "@/lib/types";
import { cleanFiles, repoList } from "../shared";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  return project ? Response.json(project) : Response.json({ error: "Project not found" }, { status: 404 });
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Partial<Project>;
  if (typeof body.name === "string" && body.name.trim()) project.name = body.name.trim().slice(0, 100);
  if (typeof body.context === "string") project.context = body.context;
  if (body.folders !== undefined) {
    try {
      project.folders = await validFolders(body.folders);
      delete project.workspace; // replaced by the folders list
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  if (Array.isArray(body.files)) project.files = cleanFiles(body.files);
  if (typeof body.isolated === "boolean") project.isolated = body.isolated;
  if (body.docsFolder === null || typeof body.docsFolder === "string") project.docsFolder = body.docsFolder?.trim() || null;
  if (Array.isArray(body.githubRepos)) project.githubRepos = repoList(body.githubRepos);
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return Response.json(project);
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  await deleteProject(id);
  return Response.json({ ok: true });
}
