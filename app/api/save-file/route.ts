// POST /api/save-file — { content, name?, mode: "new" | "append" }
// Opens the computer's own Save / Open dialog (macOS or Windows) so *you* choose where a
// reply goes, then writes it.
import fs from "node:fs/promises";
import os from "node:os";
import { chooseExistingFile, chooseSaveFile, hasNativeDialogs } from "@/lib/native";
import { isBinaryName } from "@/lib/skip";

export async function POST(req: Request) {
  const { content, name, mode } = (await req.json().catch(() => ({}))) as { content?: string; name?: string; mode?: string };
  if (typeof content !== "string" || !content.trim()) return Response.json({ error: "Nothing to save" }, { status: 400 });
  if (!hasNativeDialogs) return Response.json({ error: "The save dialog is only available on macOS and Windows", fallback: true }, { status: 400 });

  const fileName = (name || "DeepSeek reply.md").replace(/[/:\\*?"<>|]/g, "-").slice(0, 120);
  const picked =
    mode === "append"
      ? await chooseExistingFile("Add this reply to the end of which file?")
      : await chooseSaveFile("Save this reply as", fileName);
  if (picked.cancelled) return Response.json({ cancelled: true });
  if (!picked.path) return Response.json({ error: picked.error ?? "Couldn't open the dialog" }, { status: 500 });

  const target = picked.path;
  try {
    if (mode === "append") {
      if (isBinaryName(target)) return Response.json({ error: "That isn't a text file, so the reply can't be added to it." }, { status: 400 });
      const existing = await fs.readFile(target, "utf8").catch(() => "");
      const sep = !existing ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      await fs.appendFile(target, sep + content.trimEnd() + "\n");
    } else {
      await fs.writeFile(target, content.trimEnd() + "\n"); // the dialog already asked before replacing
    }
  } catch (e) {
    return Response.json({ error: `Couldn't save: ${(e as Error).message}` }, { status: 500 });
  }
  const home = os.homedir();
  return Response.json({ path: target, display: target.startsWith(home) ? "~" + target.slice(home.length) : target });
}
