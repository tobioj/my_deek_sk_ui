// POST /api/chat — adds a message (or edits / regenerates), sends the conversation to
// DeepSeek, streams the reply back as newline-delimited JSON, then saves it.
import { nanoid } from "nanoid";
import type OpenAI from "openai";
import { appendUser, buildMessages, buildUserMessage, fallbackTitle, generateTitle, userContent } from "@/lib/conversation";
import { friendlyError, getClient, isAbort } from "@/lib/deepseek";
import { getSecret } from "@/lib/secrets";
import { chatLinkedFolders } from "@/lib/folders";
import { resolveRoots, type Root } from "@/lib/roots";
import path from "node:path";
import { takeEditedCommand, waitForApproval, type Decision } from "@/lib/approvals";
import { applyEdit, describe, EDIT_TOOL_NAMES, EDIT_TOOLS, isEditError, previewEdit } from "@/lib/edits";
import { allowDocAutoSave, allowProjectCommand, discardUploads, getChat, getProject, getSettings, updateChat } from "@/lib/storage";
import { endReply, finishOrTake, setPhase, startReply, takeQueued } from "@/lib/queue";
import { DOC_TOOL_NAMES, DOC_TOOLS, docEdit, docsFolderPath, docsRoot, runDocReadTool } from "@/lib/docs";
import { GITHUB_TOOL_NAMES, GITHUB_TOOLS, reposFor, runGithubTool } from "@/lib/github";
import { costOf } from "@/lib/tokens";
import {
  appPortsFor,
  approvalNeeded,
  COMMAND_TOOL_NAMES,
  COMMAND_TOOLS,
  commandTool,
  executeCommand,
  prepareCommand,
  recheck,
  terminalAccess,
  type Prepared,
} from "@/lib/terminal";
import { runTool, WORKSPACE_TOOLS } from "@/lib/tools";
import { runWebTool, WEB_TOOL_NAMES, WEB_TOOLS } from "@/lib/websearch";
import {
  isEditingMode,
  type AssistantMessage,
  type AssistantStep,
  type Attachment,
  type CommandRun,
  type DiffPreview,
  type Mode,
  type StreamEvent,
  type ToolCall,
  type UserMessage,
} from "@/lib/types";

const MAX_TOOL_ROUNDS = 80;

interface Outcome {
  result: string;
  summary: string;
  ok: boolean;
  sources?: ToolCall["sources"];
}

// Short line for a command's result, e.g. in the notes DeepSeek sees about earlier replies.
function commandSummary(r: CommandRun): string {
  switch (r.status) {
    case "finished":
      return `Ran ${r.command}`;
    case "running":
      return `Started ${r.command} in the background`;
    case "timed_out":
      return `${r.command} hit the time limit`;
    case "stopped":
      return `Stopped ${r.command}`;
    case "denied":
      return `Didn't run ${r.command}`;
    case "blocked":
      return `Blocked ${r.command}`;
    default:
      return `${r.command} failed${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`;
  }
}

interface Body {
  chatId: string;
  action?: "send" | "regenerate" | "edit";
  text?: string;
  attachments?: Attachment[];
  messageId?: string;
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
  // (Messages you send while it's working move this along: see deliver() below.)
  let replyToId = chat.messages[chat.messages.length - 1].id;

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
      const newAssistant = (): AssistantMessage => ({
        id: nanoid(12),
        role: "assistant",
        createdAt: new Date().toISOString(),
        model: chat.model,
        steps: [],
        usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, cost: 0 },
      });
      let assistant = newAssistant();
      send({ type: "start", id: assistant.id, model: chat.model });
      startReply(chat.id); // from now on, messages you send in this chat wait for the next step

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
        // Terminal: only in a project with Terminal on, and only in that project's folders.
        const terminal = terminalAccess(project, roots, appPortsFor(req));
        const tools = [
          ...(root ? WORKSPACE_TOOLS : []),
          ...(root && editing ? EDIT_TOOLS : []),
          ...(docsPath ? DOC_TOOLS : []),
          ...(web ? WEB_TOOLS : []),
          ...(github ? GITHUB_TOOLS : []),
          ...(terminal ? COMMAND_TOOLS : []),
        ];
        const useTools = tools.length > 0;
        const messages = await buildMessages(chat, settings, { roots, web, mode, docs: docsPath, github: github ? repos : [], terminal }, project);

        // Messages you sent while DeepSeek was working: save the reply so far and your messages in
        // order, then let it carry on with them in mind. If nothing was written yet (only
        // unfinished thinking), it simply starts again and answers everything together.
        const deliver = async (users: UserMessage[]) => {
          const visible = assistant.steps.some((s) => s.content || s.toolCalls?.length);
          const part = visible ? { ...assistant, steps: assistant.steps.filter((s) => s.content || s.reasoning || s.toolCalls?.length) } : null;
          const after = replyToId;
          await updateChat(chat.id, (c) => {
            const i = c.messages.findIndex((m) => m.id === after);
            if (i === -1) return; // the message was edited away while we were replying
            c.messages.splice(i + 1, 0, ...(part ? [part] : []), ...users);
            c.updatedAt = new Date().toISOString();
          }).catch(() => null);
          replyToId = users[users.length - 1].id;
          if (part) {
            assistant = newAssistant();
            if (root) assistant.mode = mode;
            send({ type: "split", done: part, users, next: { id: assistant.id, model: chat.model } });
          } else {
            assistant.steps = [];
            send({ type: "split", done: null, users, next: null });
          }
          for (const u of users) appendUser(messages, await userContent(u, chat.model));
        };
        let incoming: UserMessage[] = []; // messages to hand DeepSeek before its next step

        // Run one command DeepSeek asked for (after approval, if it needed one), streaming its output.
        const runCommandJob = async (call: ToolCall, prep: Prepared, decision: Decision | undefined): Promise<Outcome> => {
          call.status = undefined; // commands keep their own status in call.command
          let run = prep.run;
          if (decision === "reject") {
            call.command = { ...run, status: "denied" };
            send({ type: "command", id: call.id, command: call.command });
            return {
              result: "The user chose not to run this command. Don't run it again as-is; ask what they'd prefer if it's unclear.",
              summary: commandSummary(call.command),
              ok: false,
            };
          }
          const edited = takeEditedCommand(chat.id, call.id);
          if (edited && edited !== run.command) {
            run = recheck(run, edited, terminal!);
            if (run.level === "blocked") {
              call.command = run;
              send({ type: "command", id: call.id, command: run });
              return { result: `The user edited the command to \`${edited}\`, but that's blocked: ${run.reason}.`, summary: commandSummary(run), ok: false };
            }
          }
          if (decision === "approve_remember" && run.rule && !run.edited) await allowProjectCommand(terminal!.project.id, run.rule);
          // Batch output into a few events a second, however fast the command prints.
          let pendingOut = "";
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const flush = () => {
            flushTimer = null;
            if (pendingOut) send({ type: "command_output", id: call.id, chunk: pendingOut });
            pendingOut = "";
          };
          const ping = setInterval(() => send({ type: "ping" }), 15_000);
          try {
            const done = await executeCommand({
              access: terminal!,
              root: prep.root,
              run,
              chatId: chat.id,
              by: "deepseek",
              signal: abort.signal,
              onStart: (procId) => {
                call.command = { ...run, status: "running", procId, startedAt: new Date().toISOString() };
                send({ type: "command", id: call.id, command: call.command });
              },
              onOutput: (chunk) => {
                pendingOut += chunk;
                flushTimer ??= setTimeout(flush, 150);
              },
            });
            if (flushTimer) clearTimeout(flushTimer);
            flush();
            call.command = done.run;
            send({ type: "command", id: call.id, command: done.run });
            const note = done.run.edited ? `The user changed the command before running it. What ran: ${done.run.command}\n\n` : "";
            const ok = done.run.status === "finished" || (done.run.status === "running" && !!done.run.background);
            return { result: note + done.result, summary: commandSummary(done.run), ok };
          } finally {
            clearInterval(ping);
          }
        };

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          // A break between steps: anything you sent meanwhile goes in now.
          const waiting = incoming.length ? incoming : round > 0 ? takeQueued(chat.id) : [];
          incoming = [];
          if (waiting.length) await deliver(waiting);

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

          // Its own stop switch, so "Answer together now" can cut off just this step.
          const stepAbort = new AbortController();
          const stopStep = () => stepAbort.abort();
          abort.signal.addEventListener("abort", stopStep, { once: true });
          setPhase(chat.id, "model", stepAbort);

          const pending = new Map<number, { id: string; name: string; args: string }>();
          let finish: string | null = null;
          let usage: Record<string, unknown> | null = null;

          try {
            const response = (await client.chat.completions.create(
              params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
              { signal: stepAbort.signal },
            )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

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
          } catch (e) {
            if (!stepAbort.signal.aborted || abort.signal.aborted) throw e; // a real error, or Stop
          } finally {
            abort.signal.removeEventListener("abort", stopStep);
            setPhase(chat.id, "tools");
          }
          // The SDK can end the stream quietly when aborted, so check explicitly.
          if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });

          if (stepAbort.signal.aborted) {
            // "Answer together now": keep what it had written (DeepSeek sees it too), drop anything
            // unfinished, and start again with your messages. (A cut-off step is still billed.)
            incoming = takeQueued(chat.id);
            if (!incoming.length) {
              assistant.steps.pop(); // you took the message back meanwhile: just redo this step
              send({ type: "step_cut", drop: true });
              continue;
            }
            step.toolCalls = undefined;
            if (step.content) {
              step.content = `${step.content.trimEnd()} …`;
              assistant.cutOff = true;
              const m: Record<string, unknown> = { role: "assistant", content: step.content };
              if (chat.thinking) m.reasoning_content = step.reasoning ?? "";
              messages.push(m as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
            } else step.reasoning = undefined;
            send({ type: "step_cut", drop: false });
            continue;
          }

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
            // File changes (code edits and doc saves) and commands are collected as jobs: they may
            // need approval, and run one at a time, in order.
            const outcomes: Outcome[] = new Array(toolCalls.length);
            const jobs: { i: number; tool: string; args: string; roots: Root[]; doc: boolean; command?: Prepared }[] = [];
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
                } else if (COMMAND_TOOL_NAMES.has(c.name)) {
                  if (!terminal) {
                    outcomes[i] = off(
                      "Terminal is off",
                      "the terminal is off here. Commands need a project with Terminal switched on in its settings, and one of its folders linked to this chat.",
                    );
                  } else if (c.name === "run_command") {
                    const prep = prepareCommand(c.args, terminal, mode);
                    if ("error" in prep) outcomes[i] = off(prep.error, prep.error);
                    else {
                      c.command = prep.run;
                      send({ type: "command", id: c.id, command: prep.run });
                      if (prep.run.status === "blocked") {
                        outcomes[i] = { result: `Blocked: ${prep.run.reason}. This command can't run here; don't try to get around it.`, summary: commandSummary(prep.run), ok: false };
                      } else jobs.push({ i, tool: c.name, args: c.args, roots: [prep.root], doc: false, command: prep });
                    }
                  } else outcomes[i] = await commandTool(c.name, c.args, terminal);
                } else {
                  outcomes[i] = root ? await runTool(c.name, c.args, roots) : off("No folder open", "no folder is open");
                }
              }),
            );

            // Preview each change, ask for approval where needed, then apply in order.
            jobs.sort((a, b) => a.i - b.i);
            const previews = new Map<number, DiffPreview>();
            for (const job of jobs) {
              if (job.command) continue; // commands have no preview
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
            const ready = jobs.filter((j) => j.command || previews.has(j.i));
            if (ready.length) {
              const decisions = new Map<number, Decision>();
              // Auto mode never asks about file changes. Docs marked "save without asking" don't either.
              // Commands follow their own rules (look-only, Always allow, always-ask, Windows).
              // (Re-read: "Switch to Auto", "don't ask again" or "Always allow" can happen mid-reply.)
              const [latest, latestSettings, latestProject] = await Promise.all([
                getChat(chat.id),
                getSettings(),
                terminal ? getProject(terminal.project.id) : Promise.resolve(null),
              ]);
              const autoCode = mode === "auto" || latest?.mode === "auto" || !!latest?.autoApprove;
              const commandMode: Mode = autoCode && isEditingMode(mode) ? "auto" : mode;
              const rules = latestProject?.allowedCommands ?? [];
              const docAbs = (j: (typeof jobs)[number]) => path.join(j.roots[0].abs, previews.get(j.i)!.path);
              const needsAsk = ready.filter((j) =>
                j.command
                  ? approvalNeeded(j.command.run, terminal!, commandMode, rules)
                  : !(autoCode || (j.doc && latestSettings.docsAutoSave.includes(docAbs(j)))),
              );
              for (const j of ready) if (!needsAsk.includes(j)) decisions.set(j.i, "approve");
              if (needsAsk.length) {
                for (const j of needsAsk) {
                  toolCalls[j.i].status = "pending";
                  if (j.command) send({ type: "approval", id: toolCalls[j.i].id, command: j.command.run });
                  else send({ type: "approval", id: toolCalls[j.i].id, diff: previews.get(j.i)! });
                }
                const ping = setInterval(() => send({ type: "ping" }), 15_000);
                setPhase(chat.id, "approval");
                try {
                  const results = await Promise.all(
                    needsAsk.map((j) => waitForApproval(chat.id, toolCalls[j.i].id, abort.signal, j.command ? "command" : "edit")),
                  );
                  needsAsk.forEach((j, k) => decisions.set(j.i, results[k]));
                } finally {
                  clearInterval(ping);
                  setPhase(chat.id, "tools");
                }
              }
              for (const j of ready) {
                const call = toolCalls[j.i];
                const decision = decisions.get(j.i);
                if (j.command) {
                  if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
                  outcomes[j.i] = await runCommandJob(call, j.command, decision);
                  continue;
                }
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
          // Messages you sent while it was writing this answer: carry on with them right away.
          const more = finishOrTake(chat.id);
          if (more.length) {
            const m: Record<string, unknown> = { role: "assistant", content: step.content };
            if (chat.thinking) m.reasoning_content = step.reasoning ?? "";
            messages.push(m as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
            incoming = more;
            continue;
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

      // Anything still waiting wasn't delivered (Stop, or an error): the browser puts it back in
      // the message box, so forget it here.
      await discardUploads(endReply(chat.id)).catch(() => {});

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
