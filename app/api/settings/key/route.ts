// POST /api/settings/key — { key, provider? } saves an API key (Keychain on macOS, encrypted on Windows).
// DELETE /api/settings/key?provider=… removes it.
// provider: "deepseek" (default), "anthropic" (Claude), "tavily" or "github".
import { forgetClaudeModels } from "@/lib/claude";
import { removeSecret, saveSecret, type SecretName } from "@/lib/secrets";

const PROVIDERS: SecretName[] = ["deepseek", "anthropic", "tavily", "github"];
const provider = (v: unknown): SecretName => (PROVIDERS.includes(v as SecretName) ? (v as SecretName) : "deepseek");

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { key?: string; provider?: string };
  const name = provider(body.provider);
  try {
    const status = await saveSecret(name, body.key ?? "");
    if (name === "anthropic") await forgetClaudeModels(); // a new key may see other models
    return Response.json(status);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const name = provider(new URL(req.url).searchParams.get("provider"));
  const status = await removeSecret(name);
  if (name === "anthropic") await forgetClaudeModels();
  return Response.json(status);
}
