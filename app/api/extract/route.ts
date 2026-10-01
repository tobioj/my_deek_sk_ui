// POST /api/extract — multipart file upload → plain text (PDF and Word documents).
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return Response.json({ error: "No file uploaded" }, { status: 400 });
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    if (name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text, totalPages } = await extractText(pdf, { mergePages: false });
      const pages = (text as string[]).map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join("\n\n");
      if (!pages.replace(/--- Page \d+ ---/g, "").trim()) {
        // A scan: Claude can still read it (it sees the pages); DeepSeek only gets this note.
        return Response.json({ text: `(${file.name} has no selectable text: it looks like a scan. Only models that read PDFs themselves, like Claude, can see it.)`, pages: totalPages, scanned: true });
      }
      return Response.json({ text: pages, pages: totalPages });
    }
    if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return Response.json({ text: value });
    }
    return Response.json({ error: `Can't read ${file.name} — only PDF and .docx documents are supported.` }, { status: 415 });
  } catch (e) {
    return Response.json({ error: `Couldn't read ${file.name}: ${(e as Error).message}` }, { status: 422 });
  }
}
