// What differs between providers on the server, in one place: the client, the session, titles and
// error messages. Claude's session takes more setup, so callers create it themselves.
import "server-only";
import type OpenAI from "openai";
import { friendlyClaudeError } from "./claude";
import { generateTitle } from "./conversation";
import { friendlyError, getClient } from "./deepseek";
import { friendlyGlmError, getGlmClient, glmTitle } from "./glm";
import type { OpenAIProvider, Provider } from "./models";
import { DeepSeekSession, GlmSession } from "./session";
import type { Chat } from "./types";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export const openAIClient = (provider: OpenAIProvider): Promise<OpenAI> => (provider === "glm" ? getGlmClient() : getClient());

export function openAISession(provider: OpenAIProvider, client: OpenAI, chat: Chat, messages: Msg[], tools: Tool[]): DeepSeekSession {
  return provider === "glm" ? new GlmSession(client, chat, messages, tools) : new DeepSeekSession(client, chat, messages, tools);
}

export function openAITitle(provider: OpenAIProvider, client: OpenAI) {
  return (userText: string, replyText: string) => (provider === "glm" ? glmTitle(client, userText, replyText) : generateTitle(client, userText, replyText));
}

export function friendlyErrorFor(provider: Provider, err: unknown): string {
  if (provider === "claude") return friendlyClaudeError(err);
  if (provider === "glm") return friendlyGlmError(err);
  return friendlyError(err);
}
