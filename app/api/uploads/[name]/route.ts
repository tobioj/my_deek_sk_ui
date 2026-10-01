// GET /api/uploads/:name — serve a saved attachment, or a file Claude's code made.
// Images and PDFs open in the browser; everything else downloads (?as=filename sets its name).
import fs from "node:fs/promises";
import path from "node:path";
import { UPLOADS_DIR } from "@/lib/storage";

const INLINE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export async function GET(req: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  const { name } = await ctx.params;
  const safe = path.basename(name);
  if (!/^[\w-]+\.[a-z0-9]{1,10}$/.test(safe)) return new Response("Not found", { status: 404 });
  const type = INLINE[path.extname(safe)];
  const as = (new URL(req.url).searchParams.get("as") ?? safe).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || safe;
  try {
    const buf = await fs.readFile(path.join(UPLOADS_DIR, safe));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": type ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
        ...(type ? {} : { "Content-Disposition": `attachment; filename="${as}"` }),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
