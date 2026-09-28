// Web search through Tavily (https://tavily.com). Two tools DeepSeek can call when the
// chat's Search toggle is on: web_search (1 credit) and read_webpage (1 credit per 5 pages).
import "server-only";
import type OpenAI from "openai";
import { forgetCachedSecret, getSecret } from "./secrets";
import type { Source } from "./types";
import type { ToolOutcome } from "./tools";

const TAVILY_URL = process.env.TAVILY_BASE_URL || "https://api.tavily.com";
const MAX_PAGE_CHARS = 60_000;

export const WEB_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Use it for recent events, current facts, prices, documentation, or anything you're not sure about. Returns titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, phrased like a search engine query." },
          topic: { type: "string", enum: ["general", "news"], description: "Use 'news' for current events. Defaults to 'general'." },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this recent period." },
          max_results: { type: "integer", description: "Number of results (1-10). Defaults to 5." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_webpage",
      description: "Read the full text of a web page (for example, a search result that looks relevant).",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The page's full URL." } },
        required: ["url"],
      },
    },
  },
];

export const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

class TavilyError extends Error {}

async function tavily<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }, signal?: AbortSignal): Promise<T> {
  const { key } = await getSecret("tavily");
  if (!key) throw new TavilyError("Web search needs a Tavily key. Add one in Settings → Web search.");
  let res: Response;
  try {
    res = await fetch(`${TAVILY_URL}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new TavilyError("Couldn't reach Tavily. Check your internet connection.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: { error?: string } | string };
    const detail = typeof data.detail === "string" ? data.detail : data.detail?.error;
    if (res.status === 401) {
      forgetCachedSecret("tavily");
      throw new TavilyError("Tavily rejected the key. Check it in Settings → Web search.");
    }
    if (res.status === 429) throw new TavilyError("Tavily is rate-limiting searches. Try again in a moment.");
    if (res.status === 432 || res.status === 433) throw new TavilyError("Your Tavily plan's search limit is used up for this month.");
    throw new TavilyError(`Tavily error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export async function runWebTool(name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolOutcome & { sources?: Source[] }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {}
  try {
    if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new TavilyError("query is required");
      const max = Math.min(Math.max(typeof args.max_results === "number" ? Math.floor(args.max_results) : 5, 1), 10);
      const data = await tavily<{ results: { title: string; url: string; content: string; published_date?: string }[] }>(
        "/search",
        {
          method: "POST",
          body: {
            query,
            max_results: max,
            search_depth: "basic",
            topic: args.topic === "news" ? "news" : "general",
            ...(typeof args.time_range === "string" && ["day", "week", "month", "year"].includes(args.time_range)
              ? { time_range: args.time_range }
              : {}),
          },
        },
        signal,
      );
      const results = data.results ?? [];
      const result = results.length
        ? results
            .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}${r.published_date ? `\nPublished: ${r.published_date}` : ""}\n${r.content}`)
            .join("\n\n")
        : `No results for "${query}".`;
      return {
        result,
        summary: `Searched the web for "${query}" — ${results.length} result${results.length === 1 ? "" : "s"}`,
        ok: true,
        sources: results.map((r) => ({ title: r.title || domain(r.url), url: r.url })),
      };
    }
    if (name === "read_webpage") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) throw new TavilyError("A full http(s) URL is required");
      const data = await tavily<{ results: { url: string; raw_content: string }[]; failed_results?: { url: string; error: string }[] }>(
        "/extract",
        { method: "POST", body: { urls: [url], format: "markdown" } },
        signal,
      );
      const page = data.results?.[0];
      if (!page) throw new TavilyError(`Couldn't read ${domain(url)}${data.failed_results?.[0]?.error ? `: ${data.failed_results[0].error}` : ""}`);
      let text = page.raw_content ?? "";
      if (text.length > MAX_PAGE_CHARS) text = text.slice(0, MAX_PAGE_CHARS) + "\n… [page cut off]";
      return {
        result: `=== PAGE: ${page.url} ===\n${text}\n=== END PAGE ===`,
        summary: `Read ${domain(page.url)}`,
        ok: true,
        sources: [{ title: domain(page.url), url: page.url }],
      };
    }
    throw new TavilyError(`Unknown tool: ${name}`);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    const msg = (e as Error).message;
    return { result: `Error: ${msg}`, summary: msg, ok: false };
  }
}

// Check a Tavily key without spending credits.
export async function tavilyUsage(): Promise<{ used: number; limit: number | null; plan: string | null }> {
  const data = await tavily<{ key?: { usage?: number; limit?: number | null }; account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } }>(
    "/usage",
    { method: "GET" },
  );
  return {
    used: data.account?.plan_usage ?? data.key?.usage ?? 0,
    limit: data.account?.plan_limit ?? data.key?.limit ?? null,
    plan: data.account?.current_plan ?? null,
  };
}
