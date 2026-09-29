// The Running list: every command started by DeepSeek or by ▶ Run, with its output and real status.
// Closing the window doesn't stop anything; you stop commands from the list (or `deepseek-chat stop`,
// which stops them together with the app). Kept on globalThis because each API route is bundled
// separately but runs in the same process.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { nanoid } from "nanoid";
import { killTree, killTreeNow, leftoverGroup, listeningPorts, portFree, sameProcess, spawnCommand, type RunSpec } from "./sandbox";
import type { ProcessInfo } from "./types";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "processes.json"); // what's running, so a crash can be cleaned up
const KEEP_CHARS = 2_000_000; // log kept per command (the end, if it's longer)
const HEAD_CHARS = 8_000; // the start is kept too, for DeepSeek

export interface Proc {
  info: ProcessInfo;
  pid: number;
  head: string; // first part of the output
  text: string; // the output (just the end, if it got very long)
  total: number; // characters printed so far
  listeners: Set<(chunk: string) => void>;
  exited: Promise<void>;
  stopRequested?: "you" | "timeout";
}

interface Store {
  procs: Map<string, Proc>;
  init?: Promise<void>;
  exitHook?: boolean;
  portTimer?: ReturnType<typeof setInterval>;
}
const g = globalThis as unknown as { __processes?: Store };
const store: Store = (g.__processes ??= { procs: new Map() });
const procs = store.procs;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (p: Proc) => p.info.status === "running" || p.info.status === "stopping" || p.info.status === "stop_failed";

// Tidy output for display: no color codes, and progress-bar carriage returns become new lines.
const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "").replace(/\r\n?/g, "\n");

function saveState() {
  const live = [...procs.values()].filter(running).map((p) => ({ id: p.info.id, pid: p.pid, startedAt: p.info.startedAt, command: p.info.command }));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(live, null, 2));
  } catch {}
}

// Once per server start: stop anything a crash left behind, and make sure that when the app
// stops, everything it started stops with it.
export function initProcesses(): Promise<void> {
  store.init ??= (async () => {
    let old: { pid: number; startedAt: string }[] = [];
    try {
      old = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {}
    for (const o of Array.isArray(old) ? old : []) {
      if (typeof o?.pid !== "number") continue;
      if ((await sameProcess(o.pid, o.startedAt)) || leftoverGroup(o.pid)) await killTree(o.pid).catch(() => false);
    }
    saveState();
    if (!store.exitHook) {
      store.exitHook = true;
      process.on("exit", () => {
        for (const p of procs.values()) if (running(p)) killTreeNow(p.pid);
        try {
          fs.writeFileSync(STATE_FILE, "[]");
        } catch {}
      });
    }
  })();
  return store.init;
}

function watchPorts() {
  if (store.portTimer) return;
  store.portTimer = setInterval(async () => {
    const live = [...procs.values()].filter((p) => p.info.status === "running");
    if (!live.length) {
      clearInterval(store.portTimer);
      store.portTimer = undefined;
      return;
    }
    for (const p of live) p.info.ports = await listeningPorts(p.pid).catch(() => p.info.ports);
  }, 4000);
}

export interface StartOptions {
  spec: RunSpec;
  folder: string;
  projectId: string;
  projectName: string;
  chatId: string | null;
  by: "deepseek" | "you";
  background: boolean;
  sandboxed: boolean;
  timeoutMs: number; // 0 = no limit
}

export async function startProcess(o: StartOptions): Promise<Proc> {
  await initProcesses();
  const child = await spawnCommand(o.spec);
  const info: ProcessInfo = {
    id: `cmd_${nanoid(8)}`,
    command: o.spec.command,
    folder: o.folder,
    cwd: o.spec.cwd,
    projectId: o.projectId,
    projectName: o.projectName,
    chatId: o.chatId,
    by: o.by,
    background: o.background,
    sandboxed: o.sandboxed,
    status: "running",
    startedAt: new Date().toISOString(),
    ports: [],
  };
  let resolveExit!: () => void;
  const proc: Proc = { info, pid: child.pid ?? -1, head: "", text: "", total: 0, listeners: new Set(), exited: new Promise((r) => (resolveExit = r)) };
  procs.set(info.id, proc);

  const append = (raw: string) => {
    const chunk = clean(raw);
    if (!chunk) return;
    if (proc.head.length < HEAD_CHARS) proc.head += chunk.slice(0, HEAD_CHARS - proc.head.length);
    proc.text += chunk;
    proc.total += chunk.length;
    if (proc.text.length > KEEP_CHARS + 200_000) proc.text = proc.text.slice(-KEEP_CHARS);
    for (const l of proc.listeners) l(chunk);
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream?.on("data", (b: Buffer) => append(decoder.write(b)));
    stream?.on("end", () => append(decoder.end()));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (o.timeoutMs > 0) timer = setTimeout(() => void stopProcess(info.id, "timeout"), o.timeoutMs);

  let finished = false;
  const finish = async (code: number | null, error?: string) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    // Anything it left running goes too: nothing keeps going out of sight.
    const allGone = proc.pid > 0 ? await killTree(proc.pid).catch(() => false) : true;
    info.exitCode = code;
    info.endedAt = new Date().toISOString();
    if (error) {
      info.status = "failed";
      info.error = error;
    } else if (proc.stopRequested === "timeout") info.status = "timed_out";
    else if (proc.stopRequested === "you") info.status = "stopped";
    else info.status = code === 0 ? "finished" : "failed";
    if (!allGone) {
      info.status = "stop_failed";
      info.error = "Some processes it started are still running.";
    }
    saveState();
    resolveExit();
  };
  child.on("error", (e) => {
    append(`\n[Couldn't start the command: ${e.message}]\n`);
    void finish(null, e.message);
  });
  child.on("exit", (code) => {
    // Give the last output a moment to arrive.
    const done = () => void finish(code);
    if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) done();
    else {
      let pending = 2;
      const one = () => --pending === 0 && done();
      child.stdout?.once("end", one);
      child.stderr?.once("end", one);
      setTimeout(done, 1500);
    }
  });

  saveState();
  watchPorts();
  return proc;
}

export function getProc(id: string): Proc | undefined {
  return procs.get(id);
}

// Stop a command and everything it started, then check they're really gone (and their ports free).
export async function stopProcess(id: string, why: "you" | "timeout" = "you"): Promise<ProcessInfo | null> {
  const p = procs.get(id);
  if (!p) return null;
  if (!running(p)) return p.info;
  p.stopRequested ??= why;
  p.info.status = "stopping";
  const ports = [...p.info.ports];
  const gone = await killTree(p.pid).catch(() => false);
  await Promise.race([p.exited, sleep(5000)]);
  const busy: number[] = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  const stillRunning = !gone || p.info.status === "stopping";
  if (stillRunning || busy.length) {
    p.info.status = "stop_failed";
    p.info.error = stillRunning ? "It's still running. Try Stop again." : `Port ${busy.join(", ")} is still in use.`;
  } else p.info.ports = [];
  saveState();
  return p.info;
}

export async function stopAll(): Promise<ProcessInfo[]> {
  const live = [...procs.values()].filter(running);
  return (await Promise.all(live.map((p) => stopProcess(p.info.id)))).filter((x): x is ProcessInfo => !!x);
}

export function listProcesses(): ProcessInfo[] {
  return [...procs.values()].map((p) => p.info).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Take one finished command off the list (DeepSeek's quick commands: their result is in the chat).
export function forgetProcess(id: string) {
  const p = procs.get(id);
  if (p && !running(p)) procs.delete(id);
}

// Remove finished commands from the list (running ones stay).
export function clearFinished(): number {
  let n = 0;
  for (const [id, p] of procs) {
    if (!running(p)) {
      procs.delete(id);
      n++;
    }
  }
  return n;
}

// Output since a position, for the ▶ Run block and the Running list's log.
export function readOutput(id: string, since = 0): { text: string; next: number; skipped: boolean } | null {
  const p = procs.get(id);
  if (!p) return null;
  const base = p.total - p.text.length;
  const from = Math.max(since, base);
  return { text: p.text.slice(from - base), next: p.total, skipped: since < base };
}

// What DeepSeek sees: all of it if short, otherwise the start and the end.
export function outputForModel(p: Proc, max = 20_000): string {
  if (p.total <= max) return p.text;
  const head = p.head.slice(0, 4_000);
  const tail = p.text.slice(-(max - 4_000));
  return `${head}\n\n[… ${(p.total - head.length - tail.length).toLocaleString("en-US")} characters of output left out …]\n\n${tail}`;
}
