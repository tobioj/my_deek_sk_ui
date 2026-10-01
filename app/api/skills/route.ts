// Skills for Settings and Project settings.
// GET  ?library=1          your skills (data/skills)
//      ?project=<id>       a project's own skills (data/project-skills/<id>)
//      ?folder=<path>      a folder on this computer (Settings' optional extra folder)
//      ?code=<path>        .claude/skills inside a project folder
//      (nothing)           where Claude Code keeps its skills, if you have that folder
// POST {action:"new", name, project?}      a new skill from a template (then "edit" opens it)
//      {action:"edit", dir}                open a skill's SKILL.md in your text editor
//      {action:"reveal", project?}         show your (or the project's) skills folder in Finder / File Explorer
//      {action:"import", path, project?}   copy the skills in a folder (or one skill) in
//      a .zip / .skill file as the body (Content-Type: application/zip), ?project= optional
import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "@/lib/files";
import { openFolder, openInEditor } from "@/lib/native";
import { claudeCodeSkillsFolder, codeSkillsFolder, createSkill, importSkills, importZip, libraryFolder, scanSkills, skillMarkdown } from "@/lib/skills";
import { getProject } from "@/lib/storage";
import type { SkillSource } from "@/lib/types";

const MAX_ZIP = 20 * 1024 * 1024;

async function found(folder: string, source: SkillSource) {
  const abs = path.resolve(expandHome(folder));
  const exists = await fs
    .stat(abs)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return Response.json({ folder: abs, exists, skills: exists ? await scanSkills(abs, source) : [] });
}

// Your skills, or a project's own (which must exist).
async function library(projectId: unknown): Promise<string> {
  if (projectId === undefined || projectId === null || projectId === "") return libraryFolder(null);
  if (typeof projectId !== "string" || !(await getProject(projectId).catch(() => null))) throw new Error("That project doesn't exist (save it first)");
  return libraryFolder(projectId);
}

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("library")) return await found(libraryFolder(null), "library");
    if (q.get("project")) return await found(await library(q.get("project")), "project");
    if (q.get("code")?.trim()) return await found(codeSkillsFolder(q.get("code")!), "code");
    if (q.get("folder")?.trim()) return await found(q.get("folder")!, "folder");
    return Response.json({ claudeCode: await claudeCodeSkillsFolder() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    if (/zip|octet-stream/.test(req.headers.get("content-type") ?? "")) {
      const lib = await library(new URL(req.url).searchParams.get("project"));
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length > MAX_ZIP) throw new Error("That file is too big (over 20 MB)");
      return Response.json(await importZip(bytes, lib));
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "new":
        return Response.json(await createSkill(await library(body.project), String(body.name ?? "")));
      case "edit": {
        const why = await openInEditor(await skillMarkdown(String(body.dir ?? "")));
        if (why) throw new Error(`Couldn't open it in your text editor: ${why}`);
        return Response.json({ ok: true });
      }
      case "reveal": {
        const dir = await library(body.project);
        await fs.mkdir(dir, { recursive: true });
        const why = await openFolder(dir);
        if (why) throw new Error(`Couldn't open the folder: ${why}`);
        return Response.json({ ok: true, folder: dir });
      }
      case "import":
        if (typeof body.path !== "string" || !body.path.trim()) throw new Error("Choose a folder to import");
        return Response.json(await importSkills(body.path, await library(body.project)));
      default:
        throw new Error("Unknown action");
    }
  } catch (e) {
    return fail(e);
  }
}
