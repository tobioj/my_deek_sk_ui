// POST /api/folder/pick — opens the computer's own "Choose folder" dialog (macOS or Windows).
import { chooseFolder, hasNativeDialogs, UNSUPPORTED } from "@/lib/native";

export async function POST() {
  if (!hasNativeDialogs) return Response.json({ error: UNSUPPORTED }, { status: 400 });
  const r = await chooseFolder("Choose a folder for DeepSeek");
  if (r.cancelled) return Response.json({ cancelled: true });
  if (!r.path) return Response.json({ error: r.error ?? "Couldn't open the folder dialog" }, { status: 500 });
  return Response.json({ path: r.path });
}
