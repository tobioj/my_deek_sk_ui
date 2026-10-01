// GET /api/chats/:id/export — download a chat as Markdown.
import { getChat } from "@/lib/storage";
import { aiName, labelFromId } from "@/lib/models";

export async function GET(_req: Request, ctx: RouteContext<"/api/chats/[id]/export">) {
  const { id } = await ctx.params;
  const chat = await getChat(id);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  const lines = [`# ${chat.title}`, "", `*${new Date(chat.createdAt).toLocaleString()} · ${labelFromId(chat.model)}*`, ""];
  for (const m of chat.messages) {
    if (m.role === "user") {
      lines.push("## You", "");
      if (m.attachments.length) lines.push(`*Attached: ${m.attachments.map((a) => a.name).join(", ")}*`, "");
      lines.push(m.text, "");
    } else {
      lines.push(`## ${aiName(m.model)}`, "");
      for (const s of m.steps) {
        for (const c of s.toolCalls ?? []) lines.push(`> 🔧 ${c.summary ?? c.name}`, "");
        if (s.content) lines.push(s.content, "");
      }
      if (m.error) lines.push(`> ⚠️ ${m.error}`, "");
    }
  }
  const filename = chat.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "chat";
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.md"`,
    },
  });
}
