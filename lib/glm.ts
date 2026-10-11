// The GLM (Z.ai) API client. Z.ai takes OpenAI-style requests, so this uses the same SDK as
// DeepSeek. The key only ever lives on the server (see secrets.ts).
import "server-only";
import OpenAI, { APIConnectionError, APIError } from "openai";
import { cleanTitle, TITLE_SYSTEM, titleRequest } from "./conversation";
import { SMALL_MODEL } from "./models";
import { forgetCachedSecret, getSecret } from "./secrets";

// Always Z.ai's pay-as-you-go endpoint, billed from your Z.ai balance. Not the GLM Coding Plan's:
// Z.ai only allows the Coding Plan in its supported tools (Claude Code, Cline…), and flags apps
// like this one that call it through an SDK. GLM_API_BASE_URL (only for testing) replaces the host;
// other tools' variables (ZAI_*, ANTHROPIC_*) are ignored so your key only ever goes to Z.ai.
const BASE_URL = `${(process.env.GLM_API_BASE_URL || "https://api.z.ai").replace(/\/+$/, "")}/api/paas/v4`;

export class MissingGlmKeyError extends Error {
  constructor() {
    super("No GLM API key is set. Open Settings (bottom-left) and add your key, or switch this chat to another model.");
  }
}

export async function getGlmClient(): Promise<OpenAI> {
  const { key } = await getSecret("glm");
  if (!key) throw new MissingGlmKeyError();
  return new OpenAI({ apiKey: key, baseURL: BASE_URL, maxRetries: 2, timeout: 10 * 60 * 1000 });
}

// Z.ai's errors carry a code as well as the HTTP status: {"error": {"code": "1113", "message": "…"}}.
function codeOf(err: APIError): string {
  const e = err.error as { code?: string | number; error?: { code?: string | number } } | undefined;
  return String(e?.code ?? e?.error?.code ?? "");
}

// Turn API failures into messages a person can act on.
export function friendlyGlmError(err: unknown): string {
  if (err instanceof MissingGlmKeyError) return err.message;
  if (err instanceof APIConnectionError) return "Can't reach GLM (Z.ai). Check your internet connection and try again.";
  if (err instanceof APIError) {
    const detail = ((err.error as { message?: string } | undefined)?.message ?? err.message).replace(/^\d{3}\s+/, "");
    const code = codeOf(err);
    if (err.status === 401 || code === "1000" || code === "1001" || code === "1002" || code === "1003") {
      forgetCachedSecret("glm");
      return "GLM rejected your API key. Open Settings and check it's correct (create one at z.ai → API Keys).";
    }
    switch (code) {
      case "1113":
        return "Your Z.ai balance has run out. Top up at z.ai, then retry. (A GLM Coding Plan doesn't cover this app: Z.ai only allows it in tools like Claude Code.)";
      case "1311":
        return `Your Z.ai account can't use this model. (${detail})`;
      case "1302":
      case "1303":
        return "GLM is rate-limiting you. Wait a few seconds and retry.";
      case "1305":
        return "GLM's servers are busy right now. Retry in a moment.";
      case "1301":
        return "Z.ai's content filter blocked this request. Rephrase it, or switch this chat to another model.";
      case "1211":
        return `GLM doesn't recognize this model. Pick another model. (${detail})`;
      case "1261":
        return "This chat is too long for GLM's context window. Summarize it (the token meter's menu) or start a new chat.";
    }
    switch (err.status) {
      case 400:
        return `GLM rejected the request: ${detail}`;
      case 403:
        return `Your GLM key can't use this: ${detail}`;
      case 429:
        return `GLM is rate-limiting you, or your quota is used up: ${detail}`;
      case 500:
      case 502:
      case 503:
        return "GLM's servers are busy right now. Retry in a moment.";
      default:
        return `GLM error ${err.status ?? ""}: ${detail}`.trim();
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

// The chat's title, from the fast model. GLM always thinks, so this asks for the lightest
// thinking and leaves room for it.
export async function glmTitle(client: OpenAI, userText: string, replyText: string): Promise<string | null> {
  const ask = (light: boolean) =>
    client.chat.completions.create({
      model: SMALL_MODEL.glm,
      max_tokens: 2000,
      messages: [
        { role: "system", content: TITLE_SYSTEM },
        { role: "user", content: titleRequest(userText, replyText) },
      ],
      ...({ thinking: { type: "enabled" }, ...(light ? { reasoning_effort: "low" } : {}) } as object),
    });
  try {
    const res = await ask(true).catch((e) => (e instanceof APIError && e.status === 400 ? ask(false) : Promise.reject(e)));
    return cleanTitle(res.choices[0]?.message?.content ?? "");
  } catch {
    return null;
  }
}
