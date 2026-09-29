// Starting and stopping one command.
// macOS: inside the system sandbox (sandbox-exec), which the OS enforces on the command and
// everything it starts: it can change files only in the project folders, can't read your keys
// and logins, and (unless allowed) can't reach the internet.
// Windows: in PowerShell with no sandbox, so every command that changes anything asks first.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const isMac = process.platform === "darwin";
export const isWindows = process.platform === "win32";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const sandboxAvailable = isMac && fs.existsSync(SANDBOX_EXEC);

export interface RunSpec {
  command: string;
  cwd: string;
  writable: string[]; // folders the command may change (empty = read-only)
  protect?: string[]; // folders it must never change, even inside a temp folder (Ask/Plan mode)
  internet: boolean;
  appPorts: number[]; // this app's own ports: always off limits
  dataDir: string; // this app's data (chats, keys): never readable
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const run = (file: string, args: string[], timeout = 10_000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4_000_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") })),
  );

// ---------- Windows: PowerShell ----------

const g = globalThis as unknown as { __loginPath?: Promise<string>; __pwsh?: { exe: string; name: string } };

function windowsShell(): { exe: string; name: string } {
  if (g.__pwsh) return g.__pwsh;
  const found = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const pwsh = found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
  g.__pwsh = pwsh
    ? { exe: pwsh, name: "PowerShell 7" }
    : { exe: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), name: "Windows PowerShell 5.1" };
  return g.__pwsh;
}

// Which shell commands run in (for DeepSeek's instructions).
export function shellName(): string {
  if (isWindows) return windowsShell().name;
  return "zsh";
}

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

export function powerShell(script: string, timeout = 15_000) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return run(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], timeout);
}

// ---------- The environment commands get ----------

// Your login shell's PATH (so Homebrew, nvm, pyenv… work), read once.
function loginPath(): Promise<string> {
  const home = os.homedir();
  const fallback = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter(Boolean)
    .join(":");
  const dedupe = (p: string) => [...new Set(p.split(":").filter(Boolean))].join(":");
  g.__loginPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-ilc", 'printf "__DSPATH__%s__DSEND__" "$PATH"'],
      { timeout: 8000, env: { HOME: home, USER: process.env.USER, SHELL: shell, TERM: "dumb", LANG: process.env.LANG || "en_US.UTF-8" } as unknown as NodeJS.ProcessEnv },
      (_err: unknown, stdout: string) => {
        const m = /__DSPATH__([\s\S]*?)__DSEND__/.exec(String(stdout ?? ""));
        resolve(dedupe(m?.[1] ? `${m[1]}:${fallback}` : fallback));
      },
    );
  });
  return g.__loginPath;
}

const WINDOWS_ENV = [
  "SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP",
  "TMP", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData",
  "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER", "OS", "PSModulePath", "SystemDrive", "ALLUSERSPROFILE", "PUBLIC",
];

// Only what programs need: never this app's keys, and not its own settings (PORT, NODE_ENV…),
// which would confuse your project's dev server.
async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  const nul = isWindows ? "NUL" : "/dev/null";
  const extra: Record<string, string> = {
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PYTHONUNBUFFERED: "1",
    npm_config_update_notifier: "false",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    // GitHub stays read-only, even for scripts: no saved git logins, and every push goes to an
    // address that doesn't exist (this also catches remote URLs with a token in them).
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "url.blocked-push-https://.pushInsteadOf",
    GIT_CONFIG_VALUE_1: "https://",
    GIT_CONFIG_KEY_2: "url.blocked-push-http://.pushInsteadOf",
    GIT_CONFIG_VALUE_2: "http://",
    GIT_CONFIG_KEY_3: "url.blocked-push-ssh://.pushInsteadOf",
    GIT_CONFIG_VALUE_3: "ssh://",
    GIT_CONFIG_KEY_4: "url.blocked-push-scp:.pushInsteadOf",
    GIT_CONFIG_VALUE_4: "git@",
    GIT_SSH_COMMAND: `ssh -F ${nul} -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=${nul} -o BatchMode=yes`,
  };
  if (isWindows) {
    const env: Record<string, string> = {};
    for (const k of WINDOWS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    return { ...env, ...extra } as unknown as NodeJS.ProcessEnv;
  }
  const home = os.homedir();
  return {
    PATH: await loginPath(),
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    SHELL: process.env.SHELL || "/bin/zsh",
    LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

// ---------- The macOS sandbox ----------

// Readable by nothing a command runs: keys, logins, browser data, shell history, this app's data.
function secretPaths(dataDir: string): string[] {
  const h = real(os.homedir());
  const lib = `${h}/Library`;
  return [
    `${h}/.ssh`, `${h}/.aws`, `${h}/.azure`, `${h}/.gnupg`, `${h}/.kube`, `${h}/.config/gh`, `${h}/.config/hub`, `${h}/.config/gcloud`,
    `${h}/.password-store`, `${h}/.netrc`, `${h}/.git-credentials`, `${h}/.npmrc`, `${h}/.pypirc`, `${h}/.zsh_history`,
    `${h}/.bash_history`, `${h}/.zsh_sessions`, `${h}/.python_history`, `${h}/.node_repl_history`, `${h}/.psql_history`,
    `${h}/.claude`, `${h}/.codex`, `${lib}/Keychains`, `${lib}/Cookies`, `${lib}/Safari`, `${lib}/Mail`, `${lib}/Messages`,
    `${lib}/Application Support/Google/Chrome`, `${lib}/Application Support/Firefox`, `${lib}/Application Support/BraveSoftware`,
    `${lib}/Application Support/Microsoft Edge`, `${lib}/Application Support/Arc`, `${lib}/Application Support/Claude`,
    real(dataDir),
  ];
}

// Where commands may write besides the project: temp folders and package-manager caches.
function scratchPaths(): string[] {
  const h = real(os.homedir());
  return [
    "/private/tmp", "/private/var/folders", real(os.tmpdir()), `${h}/Library/Caches`, `${h}/.npm`, `${h}/.cache`, `${h}/.yarn`,
    `${h}/Library/pnpm`, `${h}/.pnpm-store`, `${h}/.bun/install/cache`, `${h}/.cargo/registry`, `${h}/.cargo/git`, `${h}/go/pkg/mod`,
    `${h}/.gradle`, `${h}/.m2`, `${h}/.nuget`, `${h}/.deno`,
  ];
}

// Programs that could get around the sandbox or reach your Keychain.
const NO_EXEC = ["/usr/bin/security", "/usr/bin/osascript", "/usr/bin/open", "/usr/bin/sudo", "/usr/bin/su", "/bin/launchctl", "/usr/bin/defaults", "/usr/bin/shortcuts", "/usr/bin/automator"];

const q = (s: string) => JSON.stringify(s); // sandbox profiles use the same string escapes as JSON

export function sandboxProfile(spec: RunSpec): string {
  const writable = [...spec.writable.map(real), ...scratchPaths()];
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (require-not (require-any ${writable.map((p) => `(subpath ${q(p)})`).join(" ")} (regex #"^/dev/"))))`,
    `(deny file-read* file-write* ${secretPaths(spec.dataDir).map((p) => `(subpath ${q(p)})`).join(" ")})`,
    `(deny process-exec ${NO_EXEC.map((p) => `(literal ${q(p)})`).join(" ")})`,
    '(deny process-exec (regex #"/(gh|hub)$"))', // the GitHub command line, wherever it's installed
    "(deny appleevent-send)",
  ];
  // Later rules win: keep read-only project folders read-only even if they sit inside /tmp.
  if (spec.protect?.length) lines.push(`(deny file-write* ${spec.protect.map((p) => `(subpath ${q(real(p))})`).join(" ")})`);
  if (!spec.internet) {
    lines.push(
      '(deny network-outbound (remote ip "*:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))', // no lookups of internet names
    );
  }
  for (const port of spec.appPorts) lines.push(`(deny network-outbound (remote ip "localhost:${port}"))`);
  return lines.join("\n");
}

// ---------- Starting ----------

export async function spawnCommand(spec: RunSpec): Promise<ChildProcess> {
  const env = await commandEnv();
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"]; // no input: commands can't wait for you to type
  if (isWindows) {
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      "& {",
      spec.command,
      "}",
      "$ok = $?",
      "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
      "if (-not $ok) { exit 1 }",
    ].join("\n");
    const shell = windowsShell().exe;
    return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(script)], {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      stdio,
    });
  }
  if (sandboxAvailable) {
    // detached: its own process group, so Stop can end it and everything it started.
    return spawn(SANDBOX_EXEC, ["-p", sandboxProfile(spec), "/bin/zsh", "-f", "-c", spec.command], { cwd: spec.cwd, env, detached: true, stdio });
  }
  return spawn(process.env.SHELL || "/bin/sh", ["-c", spec.command], { cwd: spec.cwd, env, detached: true, stdio });
}

// ---------- Stopping ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// macOS: is anything in the command's process group still running?
const groupAlive = (pgid: number) => alive(-pgid);

// Windows: processes started by this one that are still running after it ended.
async function windowsChildren(pid: number): Promise<number[]> {
  const r = await powerShell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`);
  return r.out.split(/\s+/).map(Number).filter((n) => n > 0);
}

// Stop a command and everything it started. True once the system confirms they're all gone.
export async function killTree(pid: number): Promise<boolean> {
  if (isWindows) {
    await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    for (const child of await windowsChildren(pid)) await run("taskkill.exe", ["/PID", String(child), "/T", "/F"]);
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    return !alive(pid) && (await windowsChildren(pid)).length === 0;
  }
  if (!groupAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 30 && groupAlive(pid); i++) await sleep(100);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    for (let i = 0; i < 30 && groupAlive(pid); i++) await sleep(100);
  }
  return !groupAlive(pid);
}

// Last resort when the app itself is shutting down (must be synchronous).
export function killTreeNow(pid: number) {
  if (isWindows) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}

// ---------- Ports (e.g. a dev server on 3000) ----------

export async function listeningPorts(pid: number): Promise<number[]> {
  let out = "";
  if (isWindows) {
    const script =
      `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $ids = @(${pid}); $queue = @(${pid});` +
      `while ($queue.Count -gt 0) { $p = $queue[0]; $queue = @($queue | Select-Object -Skip 1); $kids = @($all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_.ProcessId }); $ids += $kids; $queue += $kids };` +
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique`;
    out = (await powerShell(script)).out;
    return out.split(/\s+/).map(Number).filter((n) => n > 0);
  }
  out = (await run("/usr/sbin/lsof", ["-nP", "-a", "-g", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).out;
  const ports = out
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => Number(l.slice(l.lastIndexOf(":") + 1)))
    .filter((n) => n > 0);
  return [...new Set(ports)].sort((a, b) => a - b);
}

export async function portFree(port: number): Promise<boolean> {
  if (isWindows) {
    const r = await powerShell(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).Count`);
    return r.out.trim() === "0" || r.out.trim() === "";
  }
  const r = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return !r.out.trim();
}

// ---------- Leftovers after a crash ----------

// Is `pid` still the command we started at `startedAt` (and not a new process that reused the number)?
export async function sameProcess(pid: number, startedAt: string): Promise<boolean> {
  if (!alive(pid)) return false;
  let started = NaN;
  if (isWindows) {
    const r = await powerShell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString("o")`);
    started = Date.parse(r.out.trim());
  } else {
    const r = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    started = Date.parse(r.out.trim());
  }
  return Number.isFinite(started) && Math.abs(started - Date.parse(startedAt)) < 10_000;
}

// macOS: a crash can leave part of a command's process group running after its first process
// ended. (If that first process is still there but started at a different time, the number was
// reused by an unrelated program: leave it alone.)
export const leftoverGroup = (pid: number) => !isWindows && !alive(pid) && groupAlive(pid);
