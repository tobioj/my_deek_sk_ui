// Helpers: separate runs of a chat's own model that each research one task for the chat's AI (the
// "brain") and report back. They only read (project folders, the web, GitHub, skills, the Docs
// folder); the brain does all the acting. They run on their own, like background commands: the
// chat's Stop button stops the brain's reply, not them. You stop them in the Agents panel, and the
// brain can stop them too. Quitting the app stops them.
//
// Reports go back to the brain per batch (one start_helpers call), once every helper in it has
// finished: into its reply if it's replying, otherwise in an automatic reply started from the
// open window (see /api/helpers and the chat route's "helpers" action).
//
// Live state is kept on globalThis because each API route is bundled separately but runs in the
// same process. The chat file has each run's task, steps, report and cost.
import "server-only";
import { nanoid } from "nanoid";
import type OpenAI from "openai";
import type { ChatAccess } from "./access";
import { friendlyClaudeError, getClaudeClient } from "./claude";
import { ClaudeSession } from "./claude-session";
import { buildMessages, type ToolAccess } from "./conversation";
import { friendlyError, getClient } from "./deepseek";
import { DOC_TOOLS, DOC_TOOL_NAMES, docsRoot, runDocReadTool } from "./docs";
import { GITHUB_TOOLS, GITHUB_TOOL_NAMES, runGithubTool } from "./github";
import { MAX_ROUNDS_PER_REPLY } from "./helper-tools";
import { providerOf } from "./models";
import { DeepSeekSession, type ModelSession, type StepCallbacks, type StepResult } from "./session";
import { SKILL_TOOLS, SKILL_TOOL_NAMES, runSkillTool } from "./skills";
import { getChat, updateChat } from "./storage";
import { modelInfo } from "./summarize";
import { priceOf } from "./tokens";
import { runTool, WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, type ToolOutcome } from "./tools";
import type { AssistantStep, Chat, HelperRun, Settings, ToolCall, UserMessage } from "./types";
import { runWebTool, WEB_TOOLS, WEB_TOOL_NAMES } from "./websearch";

const MAX_REPORT_CHARS = 30_000;
const MAX_TASK_CHARS = 20_000;
const KEPT_RUNS = 100; // per chat, in the chat file
const REPORT_GRACE_MS = 3 * 60_000; // time to write the report after hitting a limit

interface Live {
  run: HelperRun;
  chatId: string;
  abort: AbortController;
}
const g = globalThis as unknown as { __helpers?: Map<string, Live>; __helperDone?: Map<string, Set<string>> };
const live = (g.__helpers ??= new Map<string, Live>()); // running helpers, by id
const done = (g.__helperDone ??= new Map<string, Set<string>>()); // chat → finished helpers not yet handed to the brain

const nameOf = (t: OpenAI.Chat.Completions.ChatCompletionTool) => (t as { function: { name: string } }).function.name;
const now = () => new Date().toISOString();
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut off)` : s);

// ---------- Reading what's there ----------

// A chat's helpers: what the chat file has, with live ones as they are right now. A helper the
// file says is running but that isn't (the app was closed) counts as stopped.
export async function helperRuns(chatId: string): Promise<HelperRun[]> {
  const chat = await getChat(chatId);
  const saved = chat?.helperRuns ?? [];
  const orphans: string[] = [];
  const runs = saved.map((r) => {
    const l = live.get(r.id);
    if (l) return { ...l.run, steps: [...l.run.steps] };
    if (r.status === "running") {
      orphans.push(r.id);
      return { ...r, status: "stopped" as const, stoppedBy: "app" as const, endedAt: r.endedAt ?? now(), activity: undefined, report: r.report || "(Stopped: the app was closed while it was working.)" };
    }
    return r;
  });
  if (orphans.length) {
    await updateChat(chatId, (c) => {
      c.helperRuns = (c.helperRuns ?? []).map((r) => (orphans.includes(r.id) ? runs.find((x) => x.id === r.id)! : r));
    }).catch(() => {});
    for (const id of orphans) markDone(chatId, id);
  }
  return runs;
}

export const runningCount = (chatId: string) => [...live.values()].filter((l) => l.chatId === chatId).length;

// Chats with helpers running or reports waiting (in this app session).
export function activeChats(): string[] {
  return [...new Set([...[...live.values()].map((l) => l.chatId), ...done.keys()])];
}

function markDone(chatId: string, id: string) {
  const set = done.get(chatId) ?? new Set<string>();
  set.add(id);
  done.set(chatId, set);
}

// Reports ready for the brain: finished helpers whose whole batch is done, not handed over yet.
export async function readyReports(chatId: string): Promise<HelperRun[]> {
  if (!done.has(chatId) && !runningCount(chatId)) {
    // Nothing in memory: only a restarted app's leftovers could be waiting.
    const chat = await getChat(chatId);
    if (!chat?.helperRuns?.some((r) => !r.delivered)) return [];
  }
  const runs = await helperRuns(chatId);
  const busy = new Set(runs.filter((r) => r.status === "running").map((r) => r.batch));
  return runs.filter((r) => r.status !== "running" && !r.delivered && !busy.has(r.batch));
}

// Hand reports to the brain: they won't be handed over again.
export async function markDelivered(chatId: string, runs: HelperRun[]): Promise<void> {
  if (!runs.length) return;
  const ids = new Set(runs.map((r) => r.id));
  await updateChat(chatId, (c) => {
    for (const r of c.helperRuns ?? []) if (ids.has(r.id)) r.delivered = true;
  }).catch(() => {});
  const set = done.get(chatId);
  if (set) {
    for (const id of ids) set.delete(id);
    if (!set.size) done.delete(chatId);
  }
}

// Quick check (memory only) for the reply loop: could reports be ready?
export const mayHaveReports = (chatId: string) => done.has(chatId);

// Take the ready reports (whole batches) for the brain.
const taking = ((globalThis as unknown as { __helperTaking?: Set<string> }).__helperTaking ??= new Set<string>()); // chats being handed reports
export async function takeReadyReports(chatId: string): Promise<HelperRun[]> {
  if (taking.has(chatId)) return [];
  taking.add(chatId);
  try {
    const runs = await readyReports(chatId);
    await markDelivered(chatId, runs);
    return runs;
  } finally {
    taking.delete(chatId);
  }
}

const STATUS_WORD: Record<HelperRun["status"], string> = {
  running: "still working",
  done: "finished",
  limit: "hit its limit",
  stopped: "stopped",
  failed: "failed",
};

export function reportsText(runs: HelperRun[]): string {
  return runs
    .map((r) => {
      const why = r.status === "limit" ? ` (${r.limit === "time" ? "ran out of time" : "ran out of steps"})` : r.status === "stopped" ? ` (stopped by ${r.stoppedBy === "brain" ? "you" : r.stoppedBy === "app" ? "the app closing" : "the user"})` : "";
      return `### ${r.title} — helper ${r.id}, ${STATUS_WORD[r.status]}${why}\n${r.report || r.error || "(no report)"}`;
    })
    .join("\n\n");
}

// The message from the app that hands reports to the brain (shown as a small line in the chat).
export function reportsMessage(runs: HelperRun[]): UserMessage {
  return {
    id: nanoid(12),
    role: "user",
    createdAt: now(),
    auto: "helpers",
    text:
      `[From the app, not the user: ${runs.length === 1 ? "a helper you sent has" : `the ${runs.length} helpers you sent have`} finished. ` +
      `Review ${runs.length === 1 ? "its report" : "their reports"}, act on what they found if that's what the user asked for, and tell the user what you found.]\n\n` +
      reportsText(runs),
    attachments: [],
  };
}

// ---------- Starting and stopping ----------

export interface HelperContext {
  chat: Chat; // the brain's chat: model, thinking, effort
  settings: Settings;
  access: ChatAccess; // what the brain can read right now; helpers get the read-only part
}

export async function startHelpers(ctx: HelperContext, tasks: { title: string; task: string }[]): Promise<{ started: HelperRun[]; skipped: number }> {
  const room = Math.max(0, ctx.settings.helpersMax - runningCount(ctx.chat.id));
  const batch = nanoid(8);
  const started: HelperRun[] = tasks.slice(0, room).map((t, i) => ({
    id: `h${nanoid(5)}`,
    batch,
    title: (t.title || `Helper ${i + 1}`).trim().slice(0, 80),
    task: t.task.trim().slice(0, MAX_TASK_CHARS),
    model: ctx.chat.model,
    status: "running",
    startedAt: now(),
    activity: "Starting",
    steps: [],
    cost: 0,
  }));
  // Live first, so a look at the chat file in between doesn't take them for leftovers.
  const lives = started.map((run) => ({ run, chatId: ctx.chat.id, abort: new AbortController() }));
  for (const l of lives) live.set(l.run.id, l);
  await updateChat(ctx.chat.id, (c) => {
    c.helperRuns = [...(c.helperRuns ?? []), ...started.map((r) => ({ ...r, steps: [] }))].slice(-KEPT_RUNS);
  });
  for (const l of lives) void runHelper(l, ctx);
  return { started, skipped: tasks.length - started.length };
}

export function stopHelpers(chatId: string, ids: string[] | null, by: "you" | "brain"): number {
  let n = 0;
  for (const l of live.values()) {
    if (l.chatId !== chatId || (ids && !ids.includes(l.run.id))) continue;
    l.run.stoppedBy = by;
    l.abort.abort();
    n++;
  }
  return n;
}

// Wait until this chat's helpers have all finished, the reply is stopped, or you send a message.
export async function waitForHelpers(chatId: string, signal: AbortSignal, interrupted: () => boolean, tick: (running: number) => void): Promise<"done" | "interrupted" | "stopped"> {
  let last = 0;
  let pinged = 0;
  for (;;) {
    const n = runningCount(chatId);
    if (!n) return "done";
    if (signal.aborted) return "stopped";
    if (interrupted()) return "interrupted";
    if (n !== last || Date.now() - pinged > 15_000) {
      tick(n); // also keeps the reply's connection alive
      pinged = Date.now();
    }
    last = n;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------- Running one ----------

// The read-only part of what the brain can use.
function helperSetup(ctx: HelperContext) {
  const { access, settings } = ctx;
  const provider = providerOf(ctx.chat.model);
  const repos = access.github ? access.repos : [];
  const tools = [
    ...(access.roots.length ? WORKSPACE_TOOLS : []),
    ...(access.docsPath ? DOC_TOOLS.filter((t) => nameOf(t) !== "save_document") : []),
    ...(access.web && provider === "deepseek" ? WEB_TOOLS : []),
    ...(repos.length ? GITHUB_TOOLS : []),
    ...(access.skills.length ? SKILL_TOOLS : []),
  ];
  const toolAccess: ToolAccess = {
    provider,
    roots: access.roots,
    web: access.web,
    mode: "ask",
    docs: null,
    github: repos,
    terminal: null,
    code: false,
    skills: access.skills,
    helperRole: { steps: settings.helperSteps, minutes: settings.helperMinutes, docs: access.docsPath },
  };
  return { provider, tools, toolAccess, repos };
}

async function readTool(c: ToolCall, ctx: HelperContext, repos: string[], signal: AbortSignal): Promise<ToolOutcome> {
  const { access } = ctx;
  const off = (why: string): ToolOutcome => ({ result: `Error: ${why}`, summary: why, ok: false });
  try {
    if (DOC_TOOL_NAMES.has(c.name)) {
      if (c.name === "save_document" || !access.docsPath) return off("Helpers can only read the Docs folder");
      return await runDocReadTool(c.name, c.args, await docsRoot(access.docsPath));
    }
    if (SKILL_TOOL_NAMES.has(c.name)) return access.skills.length ? await runSkillTool(c.name, c.args, access.skills) : off("No skills");
    if (GITHUB_TOOL_NAMES.has(c.name)) return repos.length ? await runGithubTool(c.name, c.args, repos) : off("GitHub is off");
    if (WEB_TOOL_NAMES.has(c.name)) return access.web ? await runWebTool(c.name, c.args, signal) : off("Web search is off");
    if (WORKSPACE_TOOL_NAMES.has(c.name)) return access.roots.length ? await runTool(c.name, c.args, access.roots) : off("No folder open");
    return off(`Helpers can't use ${c.name}: they only read and research`);
  } catch (e) {
    return off((e as Error).message);
  }
}

const doing = (calls: ToolCall[]) => {
  const first = calls[0];
  let what = first.name.replace(/_/g, " ");
  try {
    const a = JSON.parse(first.args || "{}") as Record<string, unknown>;
    const target = a.path ?? a.query ?? a.url ?? a.pattern ?? a.name ?? a.repo;
    if (typeof target === "string" && target) what += `: ${target.slice(0, 60)}`;
  } catch {}
  return calls.length > 1 ? `${what} (+${calls.length - 1} more)` : what;
};

async function runHelper(l: Live, ctx: HelperContext): Promise<void> {
  const { run } = l;
  const { chat, settings } = ctx;
  const { provider, tools, toolAccess, repos } = helperSetup(ctx);
  const task: UserMessage = { id: nanoid(12), role: "user", createdAt: now(), text: run.task, attachments: [] };
  // A chat of its own: just the task, the brain's model and its thinking settings.
  const own: Chat = { ...chat, messages: [task], summary: undefined, container: undefined, code: false, helpersOn: false, helperRuns: undefined, mode: "ask" };
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), settings.helperMinutes * 60_000);
  let limit: "steps" | "time" | null = null;
  let used = 0;
  let forced = false; // asked to write its report now
  let wrote = ""; // the last thing it wrote (for a stopped helper's report)

  const price = (r: StepResult) => {
    if (!r.usage) return;
    const u = r.usage;
    run.cost += priceOf(r.model ?? chat.model, { cacheHitTokens: u.hit, cacheMissTokens: u.miss, cacheWriteTokens: u.write, completionTokens: u.completion, searches: u.searches }) ?? 0;
  };

  try {
    let session: ModelSession;
    if (provider === "claude") {
      const client = await getClaudeClient();
      session = await ClaudeSession.create({ client, chat: own, settings, info: await modelInfo(chat.model), access: toolAccess, project: ctx.access.project, tools, note: null });
    } else {
      session = new DeepSeekSession(await getClient(), own, await buildMessages(own, settings, toolAccess, ctx.access.project), tools);
    }

    for (let round = 0; round < 300; round++) {
      if (l.abort.signal.aborted) throw new Error("stopped");
      const final = !!limit;
      if (final && !forced) {
        forced = true;
        session.forceAnswer(
          `[Note from the app: you've reached your ${limit === "steps" ? `limit of ${settings.helperSteps} tool uses` : `time limit of ${settings.helperMinutes} minutes`}. ` +
            `Stop researching now and write your report from what you found, saying what you didn't get to.]`,
        );
      }
      run.activity = final ? "Writing its report" : run.steps.length ? "Thinking" : "Starting";
      const signal = final ? AbortSignal.any([l.abort.signal, AbortSignal.timeout(REPORT_GRACE_MS)]) : AbortSignal.any([l.abort.signal, timer.signal]);
      const step: AssistantStep = { content: "" };
      const server: ToolCall[] = [];
      const cb: StepCallbacks = {
        onReasoning: () => {},
        onText: (d) => {
          step.content += d;
          if (!final) run.activity = "Writing";
        },
        onSegment: () => {},
        onServerCall: (c) => {
          server.push(c);
          run.activity = c.name === "web_search" ? "Searching the web" : c.name === "web_fetch" ? "Reading a web page" : "Running code";
        },
        onServerResult: (id, patch) => {
          const c = server.find((x) => x.id === id);
          if (c) Object.assign(c, patch);
          if (patch.summary) {
            run.steps.push({ summary: patch.summary, ok: patch.ok ?? true });
            used++;
          }
        },
      };
      let result: StepResult;
      try {
        result = await session.stream(cb, signal);
      } catch (e) {
        // Out of time mid-step: ask for the report instead.
        if (!final && timer.signal.aborted && !l.abort.signal.aborted) {
          limit = "time";
          continue;
        }
        throw e;
      }
      price(result);
      if (step.content.trim()) wrote = step.content.trim();
      // The SDK can end a stopped stream quietly, so check explicitly.
      if (l.abort.signal.aborted) throw new Error("stopped");
      if (!final && timer.signal.aborted) {
        limit = "time";
        continue;
      }
      step.toolCalls = [...server];

      if (result.calls.length && !final) {
        const calls: ToolCall[] = result.calls.map((c) => ({ id: c.id || `call_${nanoid(8)}`, name: c.name, args: c.args }));
        step.toolCalls = [...server, ...calls];
        session.addAssistant([step], result);
        run.activity = doing(calls);
        const outs = await Promise.all(calls.map((c) => readTool(c, ctx, repos, l.abort.signal)));
        calls.forEach((c, i) => {
          Object.assign(c, { result: outs[i].result, summary: outs[i].summary, ok: outs[i].ok });
          run.steps.push({ summary: outs[i].summary, ok: outs[i].ok });
        });
        session.addToolResults(calls);
        used += calls.length;
        if (l.abort.signal.aborted) throw new Error("stopped");
        if (used >= settings.helperSteps) limit = "steps";
        else if (timer.signal.aborted) limit = "time";
        continue;
      }
      if (result.finish === "pause" && !final) {
        session.addAssistant([step], result);
        if (timer.signal.aborted) limit = "time";
        continue;
      }
      run.report = cap(step.content.trim() || wrote, MAX_REPORT_CHARS) || "(It finished without writing a report.)";
      run.status = limit ? "limit" : "done";
      if (limit) run.limit = limit;
      break;
    }
    if (run.status === "running") {
      run.status = "done";
      run.report = cap(wrote, MAX_REPORT_CHARS) || "(It finished without writing a report.)";
    }
  } catch (e) {
    const looked = run.steps.length ? `\n\nWhat it had looked at:\n${run.steps.slice(-20).map((s) => `- ${s.summary}`).join("\n")}` : "";
    const sofar = wrote ? `\n\nWhat it had written so far:\n${cap(wrote, 10_000)}` : "";
    if (l.abort.signal.aborted) {
      run.status = "stopped";
      run.report = `(Stopped before it finished.)${sofar}${looked}`;
    } else {
      run.status = "failed";
      run.error = provider === "claude" ? friendlyClaudeError(e) : friendlyError(e);
      run.report = `(It failed: ${run.error})${sofar}${looked}`;
    }
  } finally {
    clearTimeout(timeout);
    run.activity = undefined;
    run.endedAt = now();
    run.steps = run.steps.slice(-200);
    await updateChat(l.chatId, (c) => {
      c.helperRuns = (c.helperRuns ?? []).map((r) => (r.id === run.id ? { ...run, delivered: r.delivered || run.delivered } : r));
      c.extraCost = (c.extraCost ?? 0) + run.cost;
    }).catch(() => {});
    markDone(l.chatId, run.id);
    live.delete(run.id);
  }
}

// ---------- The brain's tools ----------

export interface BrainContext extends HelperContext {
  rounds: { n: number }; // start_helpers calls in this reply
  signal: AbortSignal; // the reply's (Stop)
  interrupted: () => boolean; // you sent a message
  status: (text: string | null) => void;
  ping: () => void;
}

const parse = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

export async function runHelperTool(name: string, rawArgs: string, ctx: BrainContext): Promise<ToolOutcome> {
  const chatId = ctx.chat.id;
  const a = parse(rawArgs);
  if (name === "start_helpers") {
    if (ctx.rounds.n >= MAX_ROUNDS_PER_REPLY) {
      return { result: `Error: you've already sent ${MAX_ROUNDS_PER_REPLY} rounds of helpers in this reply. Work with what you have.`, summary: "No more helper rounds in this reply", ok: false };
    }
    const list = (Array.isArray(a.helpers) ? a.helpers : [])
      .filter((h): h is { title?: unknown; task: string } => !!h && typeof (h as { task?: unknown }).task === "string" && !!(h as { task: string }).task.trim())
      .map((h) => ({ title: typeof h.title === "string" ? h.title : "", task: h.task }));
    if (!list.length) return { result: "Error: give at least one helper a task.", summary: "No helper tasks given", ok: false };
    const { started, skipped } = await startHelpers(ctx, list);
    if (!started.length) {
      return {
        result: `Error: ${ctx.settings.helpersMax} helpers are already running in this chat (the most at once). Wait for them, or stop some.`,
        summary: "Too many helpers running",
        ok: false,
      };
    }
    ctx.rounds.n++;
    return {
      result:
        `Started ${started.length} helper${started.length === 1 ? "" : "s"}:\n${started.map((r) => `- ${r.id}: ${r.title}`).join("\n")}` +
        (skipped ? `\n\n${skipped} more didn't start: at most ${ctx.settings.helpersMax} helpers can work at once. Send them after these finish.` : "") +
        `\n\nCall wait_for_helpers to get their reports.`,
      summary: `Sent ${started.length} helper${started.length === 1 ? "" : "s"}: ${started.map((r) => r.title).join(", ")}${skipped ? ` (${skipped} didn't fit)` : ""}`,
      ok: true,
    };
  }
  if (name === "wait_for_helpers") {
    const started = Date.now();
    const how = await waitForHelpers(chatId, ctx.signal, ctx.interrupted, (n) => {
      ctx.status(`Waiting for ${n} helper${n === 1 ? "" : "s"}…`);
      ctx.ping();
    });
    ctx.status(null);
    const runs = (await helperRuns(chatId)).filter((r) => r.status !== "running" && !r.delivered);
    await markDelivered(chatId, runs);
    const still = runningCount(chatId);
    const secs = Math.round((Date.now() - started) / 1000);
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const note =
      how === "interrupted"
        ? `\n\n[The user sent a message while you were waiting, so you stopped waiting. ${still} helper${still === 1 ? " is" : "s are"} still working; their reports come to you automatically when they're done.]`
        : "";
    return {
      result: (runs.length ? reportsText(runs) : "No new reports.") + note,
      summary: how === "interrupted" ? `Stopped waiting for helpers (you wrote)` : `Got ${runs.length} helper report${runs.length === 1 ? "" : "s"} (${took})`,
      ok: true,
    };
  }
  if (name === "check_helpers") {
    const runs = await helperRuns(chatId);
    const ready = runs.filter((r) => r.status !== "running" && !r.delivered);
    await markDelivered(chatId, ready);
    const working = runs.filter((r) => r.status === "running");
    return {
      result:
        (working.length ? `Still working:\n${working.map((r) => `- ${r.id}: ${r.title} (${r.steps.length} steps so far${r.activity ? `; ${r.activity}` : ""})`).join("\n")}\n\n` : "No helpers are working.\n\n") +
        (ready.length ? `New reports:\n\n${reportsText(ready)}` : "No new reports."),
      summary: `Checked on helpers: ${working.length} working, ${ready.length} new report${ready.length === 1 ? "" : "s"}`,
      ok: true,
    };
  }
  if (name === "stop_helpers") {
    const ids = Array.isArray(a.ids) && a.ids.length ? a.ids.filter((x): x is string => typeof x === "string") : null;
    const n = stopHelpers(chatId, ids, "brain");
    return { result: n ? `Stopped ${n} helper${n === 1 ? "" : "s"}. Their reports (what they found so far) come with your next wait_for_helpers or check_helpers.` : "No matching helpers were running.", summary: `Stopped ${n} helper${n === 1 ? "" : "s"}`, ok: true };
  }
  return { result: `Error: unknown tool ${name}`, summary: `Unknown tool ${name}`, ok: false };
}
