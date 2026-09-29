// Terminal commands in a project's folders: DeepSeek's tools, when they're available, and
// running one. Only chats in a project with Terminal switched on get these, and commands only
// ever run in that project's folders.
import "server-only";
import type OpenAI from "openai";
import { classifyCommand, matchesRule, needsApproval, platformOf, type Platform } from "./commands";
import { forgetProcess, getProc, listProcesses, outputForModel, readOutput, startProcess, stopProcess, type Proc } from "./processes";
import type { Root } from "./roots";
import { listeningPorts, sandboxAvailable, shellName } from "./sandbox";
import { DATA_DIR } from "./storage";
import type { CommandRun, Mode, ProcessInfo, Project } from "./types";

export const COMMAND_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a terminal command in one of the project's folders and get its exit code and output. Look-only commands (ls, cat, grep, git status/diff/log…) run straight away; others may ask the user first.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run, exactly as you'd type it in the terminal." },
          folder: { type: "string", description: "Which folder to run it in (its short name). Only needed when there are several." },
          background: {
            type: "boolean",
            description:
              "true for servers and watchers that keep running (e.g. npm run dev). Returns after a few seconds with the first output; then use check_command and stop_command.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_command",
      description: "See the latest output and status of a command running in the background. Without an id, lists this project's commands.",
      parameters: { type: "object", properties: { id: { type: "string", description: "The id run_command gave you, e.g. cmd_ab12cd34." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_command",
      description: "Stop a command running in the background (and everything it started).",
      parameters: { type: "object", properties: { id: { type: "string", description: "The command's id." } }, required: ["id"] },
    },
  },
];
export const COMMAND_TOOL_NAMES = new Set(COMMAND_TOOLS.map((t) => (t as { function: { name: string } }).function.name));

export const TERMINAL_MINUTES = [10, 30, 60];
export const terminalMinutes = (p: Pick<Project, "terminalMinutes"> | null | undefined) =>
  TERMINAL_MINUTES.includes(p?.terminalMinutes ?? 0) ? p!.terminalMinutes! : 10;

export interface TerminalAccess {
  project: Project;
  roots: Root[]; // the project's folders in this chat (commands never run anywhere else)
  platform: Platform; // "mac" only when the sandbox is there; otherwise every command asks
  sandboxed: boolean;
  internet: boolean;
  minutes: number;
  shell: string;
  appPorts: number[];
}

export function terminalAccess(project: Project | null, roots: Root[], appPorts: number[]): TerminalAccess | null {
  if (!project?.terminal) return null;
  const own = roots.filter((r) => r.source === "project");
  if (!own.length) return null;
  const os = platformOf(process.platform);
  const sandboxed = os === "mac" && sandboxAvailable;
  return {
    project,
    roots: own,
    platform: os === "mac" && !sandboxed ? "other" : os,
    sandboxed,
    internet: sandboxed ? !!project.terminalInternet : true, // without a sandbox it can't be switched off
    minutes: terminalMinutes(project),
    shell: shellName(),
    appPorts,
  };
}

export const appPortsFor = (req: Request) => {
  let port = 0;
  try {
    port = Number(new URL(req.url).port) || 0;
  } catch {}
  return [...new Set([3455, 3456, port].filter((n) => n > 0))];
};

// ---------- Preparing a command DeepSeek asked for ----------

export interface Prepared {
  run: CommandRun;
  root: Root;
}

export function prepareCommand(rawArgs: string, access: TerminalAccess, mode: Mode): Prepared | { error: string } {
  let a: { command?: unknown; folder?: unknown; background?: unknown } = {};
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {
    return { error: "the arguments weren't valid JSON" };
  }
  const command = typeof a.command === "string" ? a.command.trim() : "";
  if (!command) return { error: "command is required" };
  let root = access.roots[0];
  if (typeof a.folder === "string" && a.folder.trim()) {
    const want = a.folder.trim().replace(/\/+$/, "").toLowerCase();
    const found = access.roots.find((r) => r.name.toLowerCase() === want || r.abs.toLowerCase() === want);
    if (!found) return { error: `there's no project folder called "${a.folder}". Use one of: ${access.roots.map((r) => r.name).join(", ")}` };
    root = found;
  }
  const readOnly = mode === "ask" || mode === "plan";
  const v = classifyCommand(command, access.platform, access.appPorts);
  const run: CommandRun = {
    command,
    folder: root.name,
    status: v.level === "blocked" ? "blocked" : "pending",
    level: v.level,
    sandboxed: access.sandboxed,
    readOnly,
    internet: access.internet,
    ...(v.reason ? { reason: v.reason } : {}),
    ...(v.rule && !readOnly ? { rule: v.rule } : {}),
    ...(a.background === true ? { background: true } : {}),
  };
  return { run, root };
}

// Re-check a command you edited on the approval card.
export function recheck(run: CommandRun, command: string, access: TerminalAccess): CommandRun {
  const v = classifyCommand(command, access.platform, access.appPorts);
  return { ...run, command, edited: true, level: v.level, reason: v.reason, rule: undefined, status: v.level === "blocked" ? "blocked" : run.status };
}

export function approvalNeeded(run: CommandRun, access: TerminalAccess, mode: Mode, rules: string[]): boolean {
  const allowed = matchesRule(run.command, rules, access.platform);
  return needsApproval({ level: run.level }, { mode, platform: access.platform, allowed });
}

// ---------- Running it ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function statusOf(info: ProcessInfo): CommandRun["status"] {
  switch (info.status) {
    case "finished":
      return "finished";
    case "stopped":
      return "stopped";
    case "timed_out":
      return "timed_out";
    case "running":
    case "stopping":
      return "running";
    default:
      return "failed";
  }
}

export async function executeCommand(o: {
  access: TerminalAccess;
  root: Root;
  run: CommandRun;
  chatId: string | null;
  by: "deepseek" | "you";
  signal?: AbortSignal;
  onStart?: (procId: string) => void;
  onOutput?: (chunk: string) => void;
}): Promise<{ run: CommandRun; result: string; proc?: Proc }> {
  const { access, root } = o;
  const run: CommandRun = { ...o.run };
  const readOnly = run.readOnly && o.by === "deepseek";
  const background = !!run.background;
  let proc: Proc;
  try {
    proc = await startProcess({
      spec: {
        command: run.command,
        cwd: root.abs,
        writable: readOnly ? [] : access.roots.map((r) => r.abs),
        protect: readOnly ? access.roots.map((r) => r.abs) : [],
        internet: access.internet,
        appPorts: access.appPorts,
        dataDir: DATA_DIR,
      },
      folder: root.name,
      projectId: access.project.id,
      projectName: access.project.name,
      chatId: o.chatId,
      by: o.by,
      background: background || o.by === "you",
      sandboxed: access.sandboxed,
      timeoutMs: o.by === "deepseek" && !background ? access.minutes * 60_000 : 0,
    });
  } catch (e) {
    run.status = "failed";
    return { run, result: `Error: the command couldn't start: ${(e as Error).message}` };
  }
  const started = Date.now();
  run.status = "running";
  run.procId = proc.info.id;
  o.onStart?.(proc.info.id);
  const listener = (chunk: string) => o.onOutput?.(chunk);
  proc.listeners.add(listener);
  const onAbort = () => void stopProcess(proc.info.id);
  if (!background) o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (background) {
      // Wait until it's up: it opens a port, exits, or 8 seconds pass.
      for (let i = 0; i < 8 && proc.info.status === "running"; i++) {
        await Promise.race([proc.exited, sleep(1000)]);
        if (proc.info.status !== "running") break;
        proc.info.ports = await listeningPorts(proc.pid).catch(() => proc.info.ports);
        if (proc.info.ports.length) {
          await sleep(500);
          break;
        }
      }
    } else await proc.exited;
  } finally {
    proc.listeners.delete(listener);
    o.signal?.removeEventListener("abort", onAbort);
  }

  const info = proc.info;
  run.status = statusOf(info);
  run.exitCode = info.exitCode ?? null;
  run.durationMs = Date.now() - started;
  run.output = outputForModel(proc, 40_000);
  const out = outputForModel(proc) || "(no output)";
  const time = took(run.durationMs);
  let result: string;
  if (background && run.status === "running") {
    const ports = info.ports.length ? ` It's listening on ${info.ports.map((p) => `http://localhost:${p}`).join(", ")}.` : "";
    result =
      `Started in the background as ${info.id}. It's still running and shows in the user's Running list.${ports}\n` +
      `Use check_command with this id to see new output, and stop_command when you're done with it.\n\nOutput so far:\n${out}`;
  } else if (run.status === "timed_out") {
    result = `Stopped: it hit the ${access.minutes}-minute time limit for commands in this project. Output before it stopped:\n${out}`;
  } else if (run.status === "stopped") {
    result = `The user stopped this command after ${time}. Output before it stopped:\n${out}`;
  } else if (info.error && info.exitCode == null) {
    result = `Error: ${info.error}\n${out}`;
  } else {
    result = `Exit code ${info.exitCode ?? "unknown"} · took ${time}${info.status === "stop_failed" ? ` · ${info.error}` : ""}\n\n${out}`;
  }
  // DeepSeek's quick commands leave the Running list once they're done (the chat shows the result).
  // Background ones and the ones you run stay until you clear them.
  if (o.by === "deepseek" && !background && info.status !== "stop_failed") forgetProcess(info.id);
  return { run, result, proc };
}

// ---------- check_command / stop_command ----------

function describeProcess(info: ProcessInfo): string {
  const state =
    info.status === "running"
      ? `running since ${new Date(info.startedAt).toLocaleTimeString("en-US")}`
      : info.status === "finished" || info.status === "failed"
        ? `ended with exit code ${info.exitCode ?? "unknown"}`
        : info.status.replace("_", " ");
  const ports = info.ports.length ? `, listening on ${info.ports.map((p) => `localhost:${p}`).join(", ")}` : "";
  return `${info.id} (${info.folder}): \`${info.command}\` — ${state}${ports}`;
}

export async function commandTool(name: string, rawArgs: string, access: TerminalAccess): Promise<{ result: string; summary: string; ok: boolean }> {
  let a: { id?: unknown } = {};
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {}
  const id = typeof a.id === "string" ? a.id.trim() : "";
  const mine = (p: Proc | undefined) => (p && p.info.projectId === access.project.id ? p : undefined);
  if (name === "check_command" && !id) {
    const list = listProcesses().filter((p) => p.projectId === access.project.id);
    return {
      result: list.length ? list.map(describeProcess).join("\n") : "No commands have run in this project since the app started.",
      summary: `Checked running commands (${list.filter((p) => p.status === "running").length} running)`,
      ok: true,
    };
  }
  const proc = mine(getProc(id));
  if (!proc) return { result: `Error: no command with id "${id}" in this project.`, summary: "Command not found", ok: false };
  if (name === "stop_command") {
    const info = await stopProcess(id);
    const ok = info?.status !== "stop_failed";
    return {
      result: ok ? `Stopped ${describeProcess(info!)}` : `Error: couldn't stop it: ${info?.error}`,
      summary: ok ? `Stopped ${proc.info.command}` : `Couldn't stop ${proc.info.command}`,
      ok,
    };
  }
  const out = readOutput(id, Math.max(0, proc.total - 8_000));
  return {
    result: `${describeProcess(proc.info)}\n\nLatest output:\n${out?.text || "(no output yet)"}`,
    summary: `Checked ${proc.info.command}`,
    ok: true,
  };
}

// ---------- ▶ Run (you clicked it) ----------

export async function startUserCommand(access: TerminalAccess, root: Root, command: string, chatId: string): Promise<ProcessInfo> {
  const proc = await startProcess({
    spec: { command, cwd: root.abs, writable: access.roots.map((r) => r.abs), internet: access.internet, appPorts: access.appPorts, dataDir: DATA_DIR },
    folder: root.name,
    projectId: access.project.id,
    projectName: access.project.name,
    chatId,
    by: "you",
    background: true,
    sandboxed: access.sandboxed,
    timeoutMs: 0,
  });
  return proc.info;
}
