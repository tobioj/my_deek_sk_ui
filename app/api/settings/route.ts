// GET /api/settings — settings plus whether API keys are configured (never the keys themselves).
// POST /api/settings — save settings.
import { secretStatus } from "@/lib/secrets";
import { DEFAULT_SYSTEM_PROMPT, getSettings, saveSettings } from "@/lib/storage";

export async function GET() {
  const [settings, key, searchKey, githubKey] = await Promise.all([
    getSettings(),
    secretStatus("deepseek"),
    secretStatus("tavily"),
    secretStatus("github"),
  ]);
  return Response.json({ settings, key, searchKey, githubKey, defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, platform: process.platform });
}

export async function POST(req: Request) {
  const patch = await req.json().catch(() => ({}));
  return Response.json({ settings: await saveSettings(patch) });
}
