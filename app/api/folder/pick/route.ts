// POST /api/folder/pick — opens the native macOS "Choose folder" dialog.
import { execFile } from "node:child_process";

export async function POST() {
  if (process.platform !== "darwin") {
    return Response.json({ error: "The folder dialog is only available on macOS. Type the path instead." }, { status: 400 });
  }
  // `activate` brings the dialog to the front without needing extra macOS permissions.
  const script = ["activate", 'POSIX path of (choose folder with prompt "Choose a folder for DeepSeek")'];
  return new Promise<Response>((resolve) => {
    execFile(
      "osascript",
      script.flatMap((line) => ["-e", line]),
      { timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          // -128 means the person clicked Cancel.
          if (/-128/.test(stderr) || /User canceled/i.test(stderr)) return resolve(Response.json({ cancelled: true }));
          return resolve(Response.json({ error: stderr.trim() || err.message }, { status: 500 }));
        }
        const p = stdout.trim().replace(/\/$/, "");
        resolve(Response.json({ path: p || "/" }));
      },
    );
  });
}
