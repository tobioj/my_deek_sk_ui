// POST /api/chat — adds a message (or edits / regenerates), sends the conversation to
// DeepSeek, streams the reply back as newline-delimited JSON, then saves it.
import { nanoid } from "nanoid";
import type OpenAI from "openai";
import { buildMessages, fallbackTitle, generateTitle } from "@/lib/conversation";
import { friendlyError, getClient, isAbort } from "@/lib/deepseek";
import { getSecret } from "@/lib/secrets";
import { chatLinkedFolders } from "@/lib/folders";
import { resolveRoots, type Root } from "@/lib/roots";
import path from "node:path";
import { fileBlock, truncateText } from "@/lib/skip";
import { waitForApproval, type Decision } from "@/lib/approvals";
import { applyEdit, describe, EDIT_TOOL_NAMES, EDIT_TOOLS, isEditError, previewEdit } from "@/lib/edits";
import { allowDocAutoSave, getChat, getProject, getSettings, saveUpload, updateChat } from "@/lib/storage";
import { DOC_TOOL_NAMES, DOC_TOOLS, docEdit, docsFolderPath, docsRoot, runDocReadTool } from "@/lib/docs";
import { GITHUB_TOOL_NAMES, GITHUB_TOOLS, reposFor, runGithubTool } from "@/lib/github";
import { costOf } from "@/lib/tokens";
import { runTool, WORKSPACE_TOOLS } from "@/lib/tools";
import { runWebTool, WEB_TOOL_NAMES, WEB_TOOLS } from "@/lib/websearch";
import { isEditingMode, type AssistantMessage, type AssistantStep, type Attachment, type DiffPreview, type Mode, type StreamEvent, type ToolCall, type UserMessage } from "@/lib/types";

const MAX_TOOL_ROUNDS = 80;

interface Outcome {
  result: string;
  summary: string;
  ok: boolean;
  sources?: ToolCall["sources"];
}

interface Body {
  chatId: string;
  action?: "send" | "regenerate" | "edit";
  text?: string;
  attachments?: Attachment[];
  messageId?: string;
}

async function buildUserMessage(text: string, attachments: Attachment[], maxChars: number): Promise<UserMessage> {
  const blocks: string[] = [];
  const meta: Attachment[] = [];
  let pasted = 0;
  for (const a of attachments) {
    if (a.kind === "image" && a.dataUrl) {
      const upload = await saveUpload(a.dataUrl);
      meta.push({ id: a.id, name: a.name, kind: "image", size: a.size, upload });
    } else if (typeof a.content === "string") {
      const label = a.kind === "pasted" ? `Pasted text ${++pasted}` : a.name;
      const { text: body, truncated } = truncateText(a.content, maxChars);
      blocks.push(fileBlock(label, body));
      meta.push({ id: a.id, name: label, kind: a.kind, size: a.content.length, truncated: truncated || a.truncated });
    }
  }
  return {
    id: nanoid(12),
    role: "user",
    createdAt: new Date().toISOString(),
    text,
    ...(blocks.length ? { files: blocks.join("\n\n") } : {}),
    attachments: meta,
  };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const settings = await getSettings();
  const existing = await getChat(body.chatId);
  if (!existing) return Response.json({ error: "Chat not found" }, { status: 404 });

  // 1. Update the conversation before calling the model.
  const action = body.action ?? "send";
  let userMessage: UserMessage | null = null;
  if (action === "send") {
    const text = (body.text ?? "").trim();
    if (!text && !body.attachments?.length) return Response.json({ error: "Empty message" }, { status: 400 });
    userMessage = await buildUserMessage(text, body.attachments ?? [], settings.maxFileChars);
  }
  const chat = await updateChat(body.chatId, (c) => {
    if (action === "send" && userMessage) {
      c.messages.push(userMessage);
    } else if (action === "regenerate") {
      while (c.messages.length && c.messages[c.messages.length - 1].role === "assistant") c.messages.pop();
    } else if (action === "edit") {
      const i = c.messages.findIndex((m) => m.id === body.messageId && m.role === "user");
      if (i === -1) throw new Error("Message not found");
      const m = c.messages[i] as UserMessage;
      m.text = (body.text ?? "").trim();
      c.messages = c.messages.slice(0, i + 1);
    }
    c.updatedAt = new Date().toISOString();
  }).catch((e: Error) => e);
  if (!chat || chat instanceof Error) {
    return Response.json({ error: chat instanceof Error ? chat.message : "Chat not found" }, { status: 400 });
  }
  if (!chat.messages.length || chat.messages[chat.messages.length - 1].role !== "user") {
    return Response.json({ error: "Nothing to reply to" }, { status: 400 });
  }

  // The reply is saved right after this message, even if another message arrives meanwhile.
  const replyToId = chat.messages[chat.messages.length - 1].id;

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // The browser went away (e.g. Stop was pressed). Keep going so we can save.
        }
      };

      if (userMessage) send({ type: "user", message: userMessage });
      const assistant: AssistantMessage = {
        id: nanoid(12),
        role: "assistant",
        createdAt: new Date().toISOString(),
        model: chat.model,
        steps: [],
        usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, cost: 0 },
      };
      send({ type: "start", id: assistant.id, model: chat.model });

      let client: OpenAI | null = null;
      try {
        client = await getClient();
        // Folders DeepSeek can use: the project's (unless switched off here) plus the chat's own.
        // Folders that were moved or deleted are skipped.
        const project = chat.projectId ? await getProject(chat.projectId) : null;
        const roots = await resolveRoots(chatLinkedFolders(chat, project));
        const root = roots.length > 0;
        // Web search needs the Settings flag, the chat's Search toggle, and a Tavily key.
        const web = settings.webSearch && !!chat.webSearch && !!(await getSecret("tavily")).key;
        // Folder modes only apply when a project folder is open.
        // Older chats stored "Edit + always approve" as a flag; that's Auto mode now.
        const mode: Mode = root ? (chat.mode === "edit" && chat.autoApprove ? "auto" : (chat.mode ?? "ask")) : "ask";
        const editing = isEditingMode(mode);
        if (root) assistant.mode = mode;
        // Docs folder: DeepSeek may save documents there in any mode. Created on first use.
        const docsPath = docsFolderPath(settings, project);
        let docs: Root | null = null;
        const getDocs = async () => (docs ??= await docsRoot(docsPath!));
        // GitHub (read-only): the chat's toggle, a token, and repos allowed for this chat.
        const repos = reposFor(settings, project);
        const github = !!chat.github && repos.length > 0 && !!(await getSecret("github")).key;
        const tools = [
          ...(root ? WORKSPACE_TOOLS : []),
          ...(root && editing ? EDIT_TOOLS : []),
          ...(docsPath ? DOC_TOOLS : []),
          ...(web ? WEB_TOOLS : []),
          ...(github ? GITHUB_TOOLS : []),
        ];
        const useTools = tools.length > 0;
        const messages = await buildMessages(chat, settings, { roots, web, mode, docs: docsPath, github: github ? repos : [] }, project);

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const step: AssistantStep = { content: "" };
          assistant.steps.push(step);
          send({ type: "step" });

          const params: Record<string, unknown> = {
            model: chat.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            thinking: { type: chat.thinking ? "enabled" : "disabled" },
          };
          if (chat.thinking) params.reasoning_effort = chat.effort;
          else params.max_tokens = 32_000;
          if (useTools) params.tools = tools;

          const response = (await client.chat.completions.create(
            params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            { signal: abort.signal },
          )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

          const pending = new Map<number, { id: string; name: string; args: string }>();
          let finish: string | null = null;
          let usage: Record<string, unknown> | null = null;

          for await (const chunk of response) {
            if (chunk.usage) usage = chunk.usage as unknown as Record<string, unknown>;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta as { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] };
            if (delta.reasoning_content) {
              step.reasoning = (step.reasoning ?? "") + delta.reasoning_content;
              send({ type: "reasoning", delta: delta.reasoning_content });
            }
            if (delta.content) {
              step.content += delta.content;
              send({ type: "text", delta: delta.content });
            }
            for (const tc of delta.tool_calls ?? []) {
              const acc = pending.get(tc.index) ?? { id: "", name: "", args: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
              pending.set(tc.index, acc);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          // The SDK can end the stream quietly when aborted, so check explicitly.
          if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });

          if (usage) {
            const n = (k: string) => (typeof usage![k] === "number" ? (usage![k] as number) : 0);
            const prompt = n("prompt_tokens");
            const completion = n("completion_tokens");
            const hit = n("prompt_cache_hit_tokens");
            const miss = usage.prompt_cache_miss_tokens !== undefined ? n("prompt_cache_miss_tokens") : prompt - hit;
            const details = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined;
            const reasoning = details?.reasoning_tokens ?? n("reasoning_tokens");
            const u = assistant.usage!;
            u.promptTokens += prompt;
            u.completionTokens += completion;
            u.cacheHitTokens += hit;
            u.cacheMissTokens += miss;
            u.reasoningTokens += reasoning;
            u.cost += costOf(chat.model, { cacheHitTokens: hit, cacheMissTokens: miss, completionTokens: completion });
            assistant.contextTokens = prompt + completion;
            send({ type: "usage", usage: { ...u }, contextTokens: assistant.contextTokens });
          }

          const calls = [...pending.values()].filter((c) => c.name);
          if (useTools && calls.length) {
            const toolCalls: ToolCall[] = calls.map((c) => ({ id: c.id || `call_${nanoid(8)}`, name: c.name, args: c.args }));
            step.toolCalls = toolCalls;
            for (const call of toolCalls) send({ type: "tool_call", call: { ...call } });

            const assistantMsg: Record<string, unknown> = {
              role: "assistant",
              content: step.content || null,
              tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
            };
            if (chat.thinking) assistantMsg.reasoning_content = step.reasoning ?? "";
            messages.push(assistantMsg as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);

            // Reading tools (folders, docs, web, GitHub) run right away, in parallel.
            // File changes (code edits and doc saves) are collected as jobs for approval.
            const outcomes: Outcome[] = new Array(toolCalls.length);
            const jobs: { i: number; tool: string; args: string; roots: Root[]; doc: boolean }[] = [];
            const off = (summary: string, result: string): Outcome => ({ result: `Error: ${result}`, summary, ok: false });
            await Promise.all(
              toolCalls.map(async (c, i) => {
                if (EDIT_TOOL_NAMES.has(c.name)) {
                  if (root && editing) jobs.push({ i, tool: c.name, args: c.args, roots, doc: false });
                  else outcomes[i] = off("Editing is off", "editing is off. The user must switch the chat to Edit or Auto mode.");
                } else if (c.name === "save_document") {
                  if (!docsPath) outcomes[i] = off("Docs folder is off", "the Docs folder is turned off in Settings.");
                  else {
                    try {
                      const d = docEdit(c.args);
                      jobs.push({ i, tool: d.name, args: d.args, roots: [await getDocs()], doc: true });
                    } catch (e) {
                      outcomes[i] = off((e as Error).message, (e as Error).message);
                    }
                  }
                } else if (DOC_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = docsPath ? await runDocReadTool(c.name, c.args, await getDocs()) : off("Docs folder is off", "the Docs folder is turned off.");
                } else if (GITHUB_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = github ? await runGithubTool(c.name, c.args, repos) : off("GitHub is off", "GitHub isn't turned on for this chat.");
                } else if (WEB_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = web ? await runWebTool(c.name, c.args, abort.signal) : off("Web search is off", "web search is turned off");
                } else {
                  outcomes[i] = root ? await runTool(c.name, c.args, roots) : off("No folder open", "no folder is open");
                }
              }),
            );

            // Preview each change, ask for approval where needed, then apply in order.
            jobs.sort((a, b) => a.i - b.i);
            const previews = new Map<number, DiffPreview>();
            for (const job of jobs) {
              const call = toolCalls[job.i];
              try {
                call.diff = { ...(await previewEdit(job.roots, job.tool, job.args)), ...(job.doc ? { doc: true } : {}) };
                previews.set(job.i, call.diff);
              } catch (e) {
                const msg = isEditError(e) ? e.message : `Couldn't prepare the change: ${(e as Error).message}`;
                outcomes[job.i] = { result: `Error: ${msg}`, summary: msg, ok: false };
                send({ type: "tool_result", id: call.id, summary: msg, ok: false }); // show it now, not after approvals
              }
            }
            const ready = jobs.filter((j) => previews.has(j.i));
            if (ready.length) {
              const decisions = new Map<number, Decision>();
              // Auto mode never asks. Docs marked "save without asking" don't either.
              // (Re-read: "Switch to Auto" or "don't ask again" can happen mid-reply.)
              const [latest, latestSettings] = await Promise.all([getChat(chat.id), getSettings()]);
              const autoCode = mode === "auto" || latest?.mode === "auto" || !!latest?.autoApprove;
              const docAbs = (j: (typeof jobs)[number]) => path.join(j.roots[0].abs, previews.get(j.i)!.path);
              const needsAsk = ready.filter((j) => !(autoCode || (j.doc && latestSettings.docsAutoSave.includes(docAbs(j)))));
              for (const j of ready) if (!needsAsk.includes(j)) decisions.set(j.i, "approve");
              if (needsAsk.length) {
                for (const j of needsAsk) {
                  toolCalls[j.i].status = "pending";
                  send({ type: "approval", id: toolCalls[j.i].id, diff: previews.get(j.i)! });
                }
                const ping = setInterval(() => send({ type: "ping" }), 15_000);
                try {
                  const results = await Promise.all(needsAsk.map((j) => waitForApproval(chat.id, toolCalls[j.i].id, abort.signal)));
                  needsAsk.forEach((j, k) => decisions.set(j.i, results[k]));
                } finally {
                  clearInterval(ping);
                }
              }
              for (const j of ready) {
                const call = toolCalls[j.i];
                const decision = decisions.get(j.i);
                if (decision === "reject") {
                  call.status = "rejected";
                  outcomes[j.i] = {
                    result: j.doc
                      ? "The user chose not to save this document."
                      : "The user rejected this change, so it was not made. Don't retry it as-is; ask what they'd prefer if it's unclear.",
                    summary: `Rejected: ${describe(previews.get(j.i)!)}`,
                    ok: false,
                  };
                  continue;
                }
                if (decision === "approve_remember" && j.doc) await allowDocAutoSave(docAbs(j));
                try {
                  const { change, preview } = await applyEdit(j.roots, chat.id, j.tool, j.args);
                  call.diff = { ...preview, ...(j.doc ? { doc: true } : {}) };
                  call.status = "applied";
                  (assistant.changes ??= []).push(change);
                  outcomes[j.i] = { result: `Done: ${describe(call.diff)}.`, summary: describe(call.diff), ok: true };
                } catch (e) {
                  const msg = isEditError(e) ? e.message : `Couldn't apply the change: ${(e as Error).message}`;
                  call.status = undefined;
                  outcomes[j.i] = { result: `Error: ${msg}`, summary: msg, ok: false };
                }
              }
            }

            toolCalls.forEach((call, i) => {
              const o = outcomes[i];
              call.result = o.result;
              call.summary = o.summary;
              call.ok = o.ok;
              if (o.sources?.length) call.sources = o.sources;
              send({
                type: "tool_result",
                id: call.id,
                summary: o.summary,
                ok: o.ok,
                ...(o.sources?.length ? { sources: o.sources } : {}),
                ...(call.diff ? { diff: call.diff } : {}),
                ...(call.status ? { status: call.status } : {}),
              });
              messages.push({ role: "tool", tool_call_id: call.id, content: o.result });
            });
            if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            continue;
          }

          if (finish === "length") {
            const note = "\n\n*[Reply cut off: it hit the maximum length. Say “continue” to get the rest.]*";
            step.content += note;
            send({ type: "text", delta: note });
          } else if (finish === "insufficient_system_resource") {
            throw new Error("DeepSeek ran out of capacity mid-reply. Retry in a moment.");
          }
          break;
        }
      } catch (err) {
        if (isAbort(err) || abort.signal.aborted) {
          assistant.stopped = true;
        } else {
          assistant.error = friendlyError(err);
          send({ type: "error", message: assistant.error });
        }
      }

      // Drop empty steps (e.g. a step that was cancelled before producing anything).
      assistant.steps = assistant.steps.filter((s) => s.content || s.reasoning || s.toolCalls?.length);

      const saved = await updateChat(chat.id, (c) => {
        const i = c.messages.findIndex((m) => m.id === replyToId);
        if (i === -1) return; // the message was edited away while we were replying
        c.messages.splice(i + 1, 0, assistant);
        c.updatedAt = new Date().toISOString();
      }).catch(() => null);

      // Auto-title new chats from the first exchange.
      if (saved && saved.title === "New chat") {
        const firstUser = saved.messages.find((m) => m.role === "user") as UserMessage | undefined;
        const reply = assistant.steps.map((s) => s.content).join("\n");
        const seed = firstUser?.text || firstUser?.attachments.map((a) => a.name).join(", ") || "";
        let title = client && !assistant.error && reply ? await generateTitle(client, seed, reply) : null;
        title = title || fallbackTitle(seed);
        await updateChat(chat.id, (c) => {
          if (c.title === "New chat") c.title = title!;
        }).catch(() => null);
        send({ type: "title", title });
      }

      send({ type: "done", message: assistant });
      try {
        controller.close();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
