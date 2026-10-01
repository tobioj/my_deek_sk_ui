// POST /api/settings/test?provider=… — checks a key works without spending anything.
// DeepSeek and Claude: list models (for Claude, this also refreshes the model picker). Tavily: reads this month's usage.
import { claudeModels, friendlyClaudeError } from "@/lib/claude";
import { friendlyError, getClient } from "@/lib/deepseek";
import { githubAccount, githubRepoExists } from "@/lib/github";
import { tavilyUsage } from "@/lib/websearch";

export async function POST(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider");
  try {
    if (provider === "github") {
      // ?repo=owner/name checks one repo (used when adding a repo by hand).
      const repo = new URL(req.url).searchParams.get("repo");
      if (repo) return Response.json({ ok: await githubRepoExists(repo) });
      return Response.json({ ok: true, ...(await githubAccount()) });
    }
    if (provider === "anthropic") {
      try {
        const models = await claudeModels({ refresh: true });
        return Response.json({ ok: true, models: models.map((m) => m.id) });
      } catch (e) {
        return Response.json({ ok: false, error: friendlyClaudeError(e) });
      }
    }
    if (provider === "tavily") {
      const usage = await tavilyUsage();
      return Response.json({ ok: true, usage });
    }
    const client = await getClient();
    const models = await client.models.list();
    return Response.json({ ok: true, models: models.data.map((m) => m.id) });
  } catch (e) {
    return Response.json({ ok: false, error: provider === "tavily" || provider === "github" ? (e as Error).message : friendlyError(e) });
  }
}
