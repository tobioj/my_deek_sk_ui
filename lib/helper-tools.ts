// The tools a chat's AI (the "brain") uses to send helpers to research for it. Kept apart from
// helpers.ts (which runs them) so the instructions code can list them without importing it.
import type OpenAI from "openai";

export const HELPER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "start_helpers",
      description:
        "Send helpers to research in parallel. Each helper is a separate run of you with a fresh, empty context: it sees only the task " +
        "you write (not this conversation), can read what this chat can (project folders, the web, GitHub, skills, the Docs folder) and " +
        "can't change anything. It reports back to you, and you act on the reports. Helpers run on their own: call wait_for_helpers to " +
        "get their reports in this reply; if you don't, their reports come to you automatically once they've all finished.",
      parameters: {
        type: "object",
        properties: {
          helpers: {
            type: "array",
            description: "One entry per helper.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "A short name for the task (a few words), shown to the user." },
                task: {
                  type: "string",
                  description:
                    "The whole task. It must stand on its own: give the context, file paths or links, what to look for, and what the report should contain.",
                },
              },
              required: ["title", "task"],
            },
          },
        },
        required: ["helpers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_helpers",
      description:
        "Wait for your running helpers to finish and get their reports. It returns early if the user sends a message; the rest of the " +
        "reports then come to you automatically when they're done.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_helpers",
      description: "See how your helpers are doing, and get the reports of the ones that have finished.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_helpers",
      description: "Stop helpers that are still running: all of them, or the ones you name. A stopped helper's report has what it found so far.",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, description: "The ids of the helpers to stop (default: every running one)." } },
      },
    },
  },
];

export const HELPER_TOOL_NAMES = new Set(HELPER_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

// Automatic replies to helper reports in a row before the app waits for you.
export const MAX_AUTO_ROUNDS = 3;
// Rounds of helpers (start_helpers calls) in one reply.
export const MAX_ROUNDS_PER_REPLY = 3;
