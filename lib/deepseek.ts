// The DeepSeek API client. The key only ever lives on the server (see secrets.ts).
import "server-only";
import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from "openai";
import { forgetCachedSecret, getSecret } from "./secrets";

const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

export class MissingKeyError extends Error {
  constructor() {
    super("No DeepSeek API key is set. Open Settings (bottom-left) and add your key, or switch this chat to a Claude model.");
  }
}

export async function getClient(): Promise<OpenAI> {
  const { key } = await getSecret("deepseek");
  if (!key) throw new MissingKeyError();
  return new OpenAI({ apiKey: key, baseURL: BASE_URL, maxRetries: 2, timeout: 10 * 60 * 1000 });
}

export function isAbort(err: unknown): boolean {
  return err instanceof APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}

// Turn API failures into messages a person can act on.
export function friendlyError(err: unknown): string {
  if (err instanceof MissingKeyError) return err.message;
  if (err instanceof APIConnectionError) {
    return "Can't reach DeepSeek. Check your internet connection and try again.";
  }
  if (err instanceof APIError) {
    const detail = (err.error as { message?: string } | undefined)?.message ?? err.message;
    switch (err.status) {
      case 400:
        return `DeepSeek rejected the request: ${detail}`;
      case 401:
        forgetCachedSecret("deepseek");
        return "DeepSeek rejected your API key. Open Settings and check it's correct.";
      case 402:
        return "Your DeepSeek balance has run out. Top up at platform.deepseek.com, then retry.";
      case 422:
        return `DeepSeek couldn't use one of the request settings: ${detail}`;
      case 429:
        return "DeepSeek is rate-limiting you. Wait a few seconds and retry.";
      case 500:
      case 502:
      case 503:
        return "DeepSeek's servers are busy right now. Retry in a moment.";
      default:
        return `DeepSeek error ${err.status ?? ""}: ${detail}`.trim();
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
