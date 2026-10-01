// GET /api/settings — settings, whether API keys are configured (never the keys themselves), and
// the models you can use: DeepSeek's, and the Claude models your Claude key can use.
// POST /api/settings — save settings.
import { claudeModels } from "@/lib/claude";
import { DEEPSEEK_MODELS } from "@/lib/models";
import { secretStatus } from "@/lib/secrets";
import { DEFAULT_SYSTEM_PROMPT, getSettings, saveSettings } from "@/lib/storage";

export async function GET() {
  const [settings, key, claudeKey, searchKey, githubKey, claude] = await Promise.all([
    getSettings(),
    secretStatus("deepseek"),
    secretStatus("anthropic"),
    secretStatus("tavily"),
    secretStatus("github"),
    claudeModels().catch(() => []),
  ]);
  return Response.json({
    settings,
    key,
    claudeKey,
    searchKey,
    githubKey,
    models: { deepseek: DEEPSEEK_MODELS, claude },
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    platform: process.platform,
  });
}

export async function POST(req: Request) {
  const patch = await req.json().catch(() => ({}));
  return Response.json({ settings: await saveSettings(patch) });
}
