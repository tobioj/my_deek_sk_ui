// POST /api/settings/key — { key, provider? } saves an API key (Keychain on macOS).
// DELETE /api/settings/key?provider=… removes it. provider is "deepseek" (default) or "tavily".
import { removeSecret, saveSecret, type SecretName } from "@/lib/secrets";

const provider = (v: unknown): SecretName => (v === "tavily" ? "tavily" : v === "github" ? "github" : "deepseek");

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { key?: string; provider?: string };
  try {
    return Response.json(await saveSecret(provider(body.provider), body.key ?? ""));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  return Response.json(await removeSecret(provider(new URL(req.url).searchParams.get("provider"))));
}
