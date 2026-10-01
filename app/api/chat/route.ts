// POST /api/chat — adds a message (or edits / regenerates), sends the conversation to the chat's
// model (DeepSeek or Claude), streams the reply back as newline-delimited JSON, then saves it.
import { nanoid } from "nanoid";
import path from "node:path";
import { resolveAccess, type ChatAccess } from "@/lib/access";
import { takeEditedCommand, waitForApproval, type Decision } from "@/lib/approvals";
import { claudeTitle, friendlyClaudeError, getClaudeClient, isClaudeAbort } from "@/lib/claude";
import { ClaudeSession } from "@/lib/claude-session";
import { buildMessages, buildUserMessage, fallbackTitle, generateTitle, modeSwitchNote } from "@/lib/conversation";
import { friendlyError, getClient, isAbort } from "@/lib/deepseek";
import { DOC_TOOL_NAMES, docEdit, docsRoot, runDocReadTool } from "@/lib/docs";
import { applyEdit, describe, EDIT_TOOL_NAMES, isEditError, previewEdit } from "@/lib/edits";
import { GITHUB_TOOL_NAMES, runGithubTool } from "@/lib/github";
import { PROVIDER_NAME } from "@/lib/models";
import { endReply, finishOrTake, setPhase, startReply, takeQueued } from "@/lib/queue";
import type { Root } from "@/lib/roots";
import { DeepSeekSession, type ModelSession, type StepCallbacks } from "@/lib/session";
import { allowDocAutoSave, allowProjectCommand, discardUploads, getChat, getProject, getSettings, updateChat } from "@/lib/storage";
import { modelInfo, summarizeChat, summaryDue } from "@/lib/summarize";
import { COMMAND_TOOL_NAMES, approvalNeeded, commandTool, executeCommand, prepareCommand, recheck, type Prepared } from "@/lib/terminal";
import { priceOf } from "@/lib/tokens";
import { runSkillTool, SKILL_TOOL_NAMES } from "@/lib/skills";
import { runTool } from "@/lib/tools";
import { runWebTool, WEB_TOOL_NAMES } from "@/lib/websearch";
import {
  isEditingMode,
  type AssistantMessage,
  type AssistantStep,
  type Attachment,
  type Chat,
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

// Short line for a command's result, e.g. in the notes the AI sees about earlier replies.
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

const REFUSAL_REASON: Record<string, string> = {
  cyber: "cybersecurity",
  bio: "biology",
  reasoning_extraction: "a request to reveal its reasoning",
  frontier_llm: "AI model development",
  general_harms: "possible harm",
};

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
    let changedAt = -1; // the first message that changed (a summary covering it no longer fits)
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
      changedAt = i;
    }
    if (c.summary) {
      const s = c.messages.findIndex((m) => m.id === c.summary!.upto);
      if (s === -1 || (changedAt !== -1 && changedAt <= s)) delete c.summary;
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
  const provider = chat.model.startsWith("deepseek") ? "deepseek" : "claude";
  const ai = PROVIDER_NAME[provider];

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

      let titleFor: ((seed: string, reply: string) => Promise<string | null>) | null = null;
      let a: ChatAccess | null = null;
      try {
        a = await resolveAccess(chat, settings, req);
        const { roots, mode, editing, docsPath, repos, github, terminal, web, skills } = a;
        const root = roots.length > 0;
        if (root) assistant.mode = mode;
        let docs: Root | null = null;
        const getDocs = async () => (docs ??= await docsRoot(docsPath!));
        const info = await modelInfo(chat.model);

        // A long chat: summarize the earlier messages first, so the reply stays fast and affordable.
        const upto = summaryDue(chat, settings, info);
        if (upto) {
          send({ type: "status", text: "Summarizing earlier messages…" });
          try {
            const { summary, cost } = await summarizeChat({ chat, settings, access: a, info, upto, signal: abort.signal });
            chat.summary = summary;
            chat.extraCost = (chat.extraCost ?? 0) + cost;
            const saved = await updateChat(chat.id, (c) => {
              if (c.messages.some((m) => m.id === upto)) c.summary = summary;
              c.extraCost = (c.extraCost ?? 0) + cost;
            });
            send({ type: "summary", summary, extraCost: saved?.extraCost ?? chat.extraCost });
          } catch (e) {
            if (abort.signal.aborted) throw e;
            // Couldn't summarize: carry on with the full chat.
          }
          send({ type: "status", text: null });
        }

        // The session: DeepSeek's or Claude's way of talking about this chat.
        let session: ModelSession;
        let claude: ClaudeSession | null = null;
        if (provider === "claude") {
          const client = await getClaudeClient();
          titleFor = (seed, reply) => claudeTitle(client, seed, reply);
          // A note about a mode switch goes in once, just before this reply, and stays there.
          const note = modeSwitchNote(chat, a.access);
          if (note) assistant.note = note;
          claude = await ClaudeSession.create({ client, chat, settings, info, access: a.access, project: a.project, tools: a.tools, note });
          session = claude;
        } else {
          const client = await getClient();
          titleFor = (seed, reply) => generateTitle(client, seed, reply);
          session = new DeepSeekSession(client, chat, await buildMessages(chat, settings, a.access, a.project), a.tools);
        }

        // Messages you sent while it was working: save the reply so far and your messages in
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
          await session.addUsers(users);
        };
        let incoming: UserMessage[] = []; // messages to hand the model before its next step

        // Run one command the AI asked for (after approval, if it needed one), streaming its output.
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
              by: provider,
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

          const head = assistant.steps.length; // this API call's first step
          assistant.steps.push({ content: "" });
          send({ type: "step" });
          const cur = () => assistant.steps[assistant.steps.length - 1];
          const findCall = (id: string) => assistant.steps.flatMap((s) => s.toolCalls ?? []).find((c) => c.id === id);

          const callbacks: StepCallbacks = {
            onReasoning: (delta) => {
              const s = cur();
              s.reasoning = (s.reasoning ?? "") + delta;
              send({ type: "reasoning", delta });
            },
            onText: (delta) => {
              cur().content += delta;
              send({ type: "text", delta });
            },
            onSegment: () => {
              assistant.steps.push({ content: "", cont: true });
              send({ type: "step" });
            },
            onServerCall: (call) => {
              (cur().toolCalls ??= []).push(call);
              send({ type: "tool_call", call: { ...call } });
            },
            onServerResult: (id, patch) => {
              const call = findCall(id);
              if (call) Object.assign(call, patch);
              send({
                type: "tool_result",
                id,
                summary: call?.summary ?? patch.summary ?? "",
                ok: call?.ok ?? patch.ok ?? true,
                ...(call?.sources ? { sources: call.sources } : {}),
                ...(call?.result ? { result: call.result } : {}),
                ...(call?.files ? { files: call.files } : {}),
              });
            },
          };

          // Its own stop switch, so "Answer together now" can cut off just this step.
          const stepAbort = new AbortController();
          const stopStep = () => stepAbort.abort();
          abort.signal.addEventListener("abort", stopStep, { once: true });
          setPhase(chat.id, "model", stepAbort);

          let result: Awaited<ReturnType<ModelSession["stream"]>> | null = null;
          try {
            result = await session.stream(callbacks, stepAbort.signal);
          } catch (e) {
            if (!stepAbort.signal.aborted || abort.signal.aborted) throw e; // a real error, or Stop
          } finally {
            abort.signal.removeEventListener("abort", stopStep);
            setPhase(chat.id, "tools");
          }
          // The SDK can end the stream quietly when aborted, so check explicitly.
          if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          const callSteps = assistant.steps.slice(head);

          if (stepAbort.signal.aborted || !result) {
            // "Answer together now": keep what it had written (the model sees it too), drop anything
            // unfinished, and start again with your messages. (A cut-off step is still billed.)
            incoming = takeQueued(chat.id);
            if (!incoming.length) {
              assistant.steps.length = head; // you took the message back meanwhile: just redo this step
              send({ type: "step_cut", drop: true, count: callSteps.length });
              continue;
            }
            const last = callSteps[callSteps.length - 1];
            for (const s of callSteps) s.toolCalls = s.toolCalls?.filter((c) => c.server && c.summary !== undefined);
            if (last.content) {
              last.content = `${last.content.trimEnd()} …`;
              assistant.cutOff = true;
            } else if (!last.toolCalls?.length) last.reasoning = undefined;
            session.addAssistant(callSteps, null);
            send({ type: "step_cut", drop: false });
            continue;
          }

          const headStep = assistant.steps[head];
          if (result.raw) headStep.raw = result.raw;
          if (result.fallback) assistant.fallback = result.fallback;
          if (result.container && claude) chat.container = result.container;
          if (result.usage) {
            const r = result.usage;
            const u = assistant.usage!;
            u.promptTokens += r.prompt;
            u.completionTokens += r.completion;
            u.cacheHitTokens += r.hit;
            u.cacheMissTokens += r.miss;
            u.reasoningTokens += r.reasoning;
            if (r.write) u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + r.write;
            if (r.searches) u.searches = (u.searches ?? 0) + r.searches;
            const cost = priceOf(result.model ?? chat.model, { cacheHitTokens: r.hit, cacheMissTokens: r.miss, cacheWriteTokens: r.write, completionTokens: r.completion, searches: r.searches });
            if (cost === null) u.priceUnknown = true;
            u.cost += cost ?? 0;
            assistant.contextTokens = r.context;
            send({ type: "usage", usage: { ...u }, contextTokens: assistant.contextTokens });
          }

          const last = cur();
          if (result.calls.length) {
            const toolCalls: ToolCall[] = result.calls.map((c) => ({ id: c.id || `call_${nanoid(8)}`, name: c.name, args: c.args }));
            last.toolCalls = [...(last.toolCalls ?? []), ...toolCalls];
            for (const call of toolCalls) send({ type: "tool_call", call: { ...call } });
            session.addAssistant(callSteps, result);

            // A tool call that was cut off (the reply hit its length limit) or that came with a
            // declined reply never runs.
            if (result.finish === "length" || result.finish === "refusal") {
              const why =
                result.finish === "length"
                  ? "this tool call was cut off because the reply hit its length limit, so it didn't run. Try again in smaller pieces."
                  : "the reply was declined, so this tool call didn't run.";
              for (const call of toolCalls) {
                Object.assign(call, { result: `Error: ${why}`, summary: "Didn't run", ok: false });
                send({ type: "tool_result", id: call.id, summary: "Didn't run", ok: false });
              }
              session.addToolResults(toolCalls);
              if (result.finish === "refusal") {
                assistant.refusal = result.refusal ?? "unspecified";
                break;
              }
              continue;
            }

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
                } else if (SKILL_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = skills.length ? await runSkillTool(c.name, c.args, skills) : off("No skills", "there are no skills set up.");
                } else if (GITHUB_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = github ? await runGithubTool(c.name, c.args, repos) : off("GitHub is off", "GitHub isn't turned on for this chat.");
                } else if (WEB_TOOL_NAMES.has(c.name)) {
                  outcomes[i] = web && provider === "deepseek" ? await runWebTool(c.name, c.args, abort.signal) : off("Web search is off", "web search is turned off");
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
            jobs.sort((x, y) => x.i - y.i);
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
              // (Re-read: "Switch to Auto", "don't ask again" or "Always allow" can happen mid-reply.
              // Auto still has to be allowed for this provider in Settings.)
              const [latest, latestSettings, latestProject] = await Promise.all([
                getChat(chat.id),
                getSettings(),
                terminal ? getProject(terminal.project.id) : Promise.resolve(null),
              ]);
              const autoCode = latestSettings.limits[provider].auto && (mode === "auto" || latest?.mode === "auto" || !!latest?.autoApprove);
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
            });
            session.addToolResults(toolCalls);
            if (abort.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            continue;
          }

          // Claude's servers paused a long run of searches or code: let it carry on.
          if (result.finish === "pause") {
            session.addAssistant(callSteps, result);
            continue;
          }
          if (result.finish === "refusal") {
            const why = result.refusal ? REFUSAL_REASON[result.refusal] : null;
            assistant.refusal = result.refusal ?? "unspecified";
            const note = `${last.content ? "\n\n" : ""}*${ai} declined to answer this${why ? ` (its safety checks flagged ${why})` : ""}. You can rephrase, or switch this chat to another model.*`;
            last.content += note;
            send({ type: "text", delta: note });
            break;
          }
          if (result.finish === "length") {
            const note = "\n\n*[Reply cut off: it hit the maximum length. Say “continue” to get the rest.]*";
            last.content += note;
            send({ type: "text", delta: note });
          } else if (result.finish === "context") {
            throw new Error(`This chat is too long for ${ai}'s context window. Summarize it (the token meter's menu) or start a new chat.`);
          } else if (result.finish === "capacity") {
            throw new Error("DeepSeek ran out of capacity mid-reply. Retry in a moment.");
          }
          // Messages you sent while it was writing this answer: carry on with them right away.
          const more = finishOrTake(chat.id);
          if (more.length) {
            session.addAssistant(callSteps, result);
            incoming = more;
            continue;
          }
          break;
        }
      } catch (err) {
        if (isAbort(err) || isClaudeAbort(err) || abort.signal.aborted) {
          assistant.stopped = true;
        } else {
          assistant.error = provider === "claude" ? friendlyClaudeError(err) : friendlyError(err);
          send({ type: "error", message: assistant.error });
        }
      }

      // Anything still waiting wasn't delivered (Stop, or an error): the browser puts it back in
      // the message box, so forget it here.
      await discardUploads(endReply(chat.id)).catch(() => {});

      // Drop empty steps (e.g. a step that was cancelled before producing anything), but keep
      // Claude's content blocks with the step that follows.
      const kept: AssistantStep[] = [];
      for (const s of assistant.steps) {
        if (s.content || s.reasoning || s.toolCalls?.length) kept.push(s);
        else if (s.raw) {
          const next = assistant.steps[assistant.steps.indexOf(s) + 1];
          if (next?.cont) {
            next.raw = s.raw;
            next.cont = false;
          }
        }
      }
      assistant.steps = kept;

      const saved = await updateChat(chat.id, (c: Chat) => {
        const i = c.messages.findIndex((m) => m.id === replyToId);
        if (chat.container) c.container = chat.container;
        if (i === -1) return; // the message was edited away while we were replying
        c.messages.splice(i + 1, 0, assistant);
        c.updatedAt = new Date().toISOString();
      }).catch(() => null);

      // Auto-title new chats from the first exchange.
      if (saved && saved.title === "New chat") {
        const firstUser = saved.messages.find((m) => m.role === "user") as UserMessage | undefined;
        const reply = assistant.steps.map((s) => s.content).join("\n");
        const seed = firstUser?.text || firstUser?.attachments.map((x) => x.name).join(", ") || "";
        const attached = firstUser?.text && firstUser.attachments.length ? `\n(Attached: ${firstUser.attachments.map((x) => x.name).join(", ")})` : "";
        let title = titleFor && !assistant.error && reply ? await titleFor(seed + attached, reply) : null;
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

