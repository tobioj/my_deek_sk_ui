// Rules for terminal commands: which ones run straight away, which ask first, which never run.
// Shared by the server (the real check) and the browser (the ▶ Run button's warnings).
// Keep this file free of Node imports.
import { isSecretFile } from "./skip";
import type { Mode } from "./types";

export type Platform = "mac" | "windows" | "other";
// look: only looks inside the project, runs without asking.
// ask: asks first (except in Auto mode on macOS, or when you've said "Always allow").
// always_ask: asks every time, even in Auto mode.
// blocked: never runs, even if approved.
export type Level = "look" | "ask" | "always_ask" | "blocked";

export interface Verdict {
  level: Level;
  reason?: string; // why it always asks or is blocked
  rule?: string; // what "Always allow" would save (only for plain, single commands)
}

export const platformOf = (p: string): Platform => (p === "darwin" ? "mac" : p === "win32" ? "windows" : "other");

// ---------- Splitting a command into words ----------

interface Segment {
  words: string[];
  envPrefix: boolean; // starts with FOO=bar
  piped: boolean; // receives another command's output
}

interface Parsed {
  segments: Segment[];
  complex: boolean; // has $variables, $(…), backticks, brackets or redirects we can't read confidently
  background: boolean; // ends a command with a single &
  redirect: boolean; // writes output to a file (> file)
}

const NULL_TARGETS = new Set(["/dev/null", "$null", "nul", "&1", "&2"]);

function parse(cmd: string, platform: Platform): Parsed {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let complex = false;
  let background = false;
  let redirect = false;
  let piped = false;
  const unixEscapes = platform !== "windows"; // on Windows, \ is just a path separator

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length) {
      let i = 0;
      while (i < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
      segments.push({ words: words.slice(i), envPrefix: i > 0, piped });
    }
    words = [];
    piped = nextPiped;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "$" || c === "`") {
        complex = true; // expands inside double quotes in both zsh and PowerShell
        word += c;
      } else if (c === "\\" && unixEscapes && next !== undefined) {
        word += next;
        i++;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && unixEscapes) {
      if (next === "\n") {
        i++; // line continuation
        continue;
      }
      if (next !== undefined) {
        word += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";") {
      endSegment(false);
      continue;
    }
    if (c === "&" && next === "&") {
      endSegment(false);
      i++;
      continue;
    }
    if (c === "|" && next === "|") {
      endSegment(false);
      i++;
      continue;
    }
    if (c === "|") {
      endSegment(true);
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      // 2>&1, >/dev/null and friends are harmless; anything else writes (or reads) a file.
      let j = i;
      if (c === "&") j++;
      while (cmd[j] === ">" || cmd[j] === "<") j++;
      while (cmd[j] === " ") j++;
      let target = "";
      while (j < cmd.length && !/[\s;|&]/.test(cmd[j])) target += cmd[j++];
      if (cmd[j] === "&" && /^&?$/.test(target)) {
        // "2>&1": the & belongs to the redirect
        target += cmd[j++];
        while (j < cmd.length && /[0-9]/.test(cmd[j])) target += cmd[j++];
      }
      if (!NULL_TARGETS.has(target.toLowerCase()) && !/^&\d$/.test(target)) redirect = true;
      if (/^\d$/.test(word) && inWord) {
        word = "";
        inWord = false; // the "2" in 2>&1
      }
      endWord();
      i = j - 1;
      continue;
    }
    if (c === "&") {
      // A lone & at the end of a command sends it to the background (zsh, PowerShell 7).
      // At the start of a PowerShell command it's the call operator.
      const rest = cmd.slice(i + 1);
      if (/^\s*($|[;\n])/.test(rest)) {
        background = true;
        endSegment(false);
      } else if (!words.length && !inWord && platform === "windows") {
        complex = true;
      } else {
        background = true;
        endSegment(false);
      }
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      complex = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      complex = true; // a comment; could hide the rest of the line from a quick read
      word += c;
      inWord = true;
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) complex = true;
  endSegment(false);
  return { segments, complex, background, redirect };
}

// ---------- Program names ----------

function programName(word: string, platform: Platform): string {
  let name = word.split(platform === "windows" ? /[\\/]/ : /\//).pop() ?? word;
  if (platform === "windows") name = name.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
  return name;
}

// Wrappers that run another command: look through them to the real one.
const WRAPPERS = new Set(["time", "nice", "command", "builtin", "exec", "caffeinate", "env", "xargs", "timeout", "gtimeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "iex", "invoke-expression", "osascript"]);

interface Program {
  name: string;
  args: string[];
  wrapped: boolean;
  nested?: string; // the command inside `bash -c "…"` or `powershell -Command "…"`
}

function unwrap(words: string[], platform: Platform): Program {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const name = programName(words[i], platform);
    if (!WRAPPERS.has(name)) break;
    wrapped = true;
    i++;
    // Skip the wrapper's own options and settings (env FOO=1, timeout 30, nice -n 5).
    while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || /^\d+[smhd]?$/.test(words[i]))) i++;
  }
  const name = i < words.length ? programName(words[i], platform) : "";
  const args = words.slice(i + 1);
  return { name, args, wrapped, nested: nestedCommand(lower(name), args) };
}

// The command a shell is asked to run: bash -c "…", cmd /c …, powershell -Command "…".
// PowerShell accepts any abbreviation of its parameter names (-c, -com, -e, -enc…).
function nestedCommand(shell: string, args: string[]): string | undefined {
  if (!SHELLS.has(shell)) return undefined;
  const powershell = shell === "pwsh" || shell === "powershell";
  for (let k = 0; k < args.length; k++) {
    const a = lower(args[k]);
    const bare = a.replace(/^-+/, "");
    if (powershell && a.startsWith("-") && bare.length >= 1) {
      if ("encodedcommand".startsWith(bare) || bare === "ec") return "\u0000encoded";
      if ("command".startsWith(bare)) return args.slice(k + 1).join(" ");
      if ("file".startsWith(bare)) return undefined;
    } else if (shell === "cmd" && (a === "/c" || a === "/k")) {
      return args.slice(k + 1).join(" ");
    } else if (!powershell && shell !== "cmd" && /^-[a-z]*c[a-z]*$/.test(a)) {
      return args.slice(k + 1).join(" ");
    }
  }
  return undefined;
}

const lower = (s: string) => s.toLowerCase();

// ---------- Never run ----------

const BLOCKED: Record<string, string> = {
  sudo: "Admin commands (sudo) can't run here",
  su: "Admin commands can't run here",
  doas: "Admin commands can't run here",
  runas: "Admin commands can't run here",
  security: "Keychain commands can't run here",
  cmdkey: "Saved-password commands can't run here",
  vaultcmd: "Saved-password commands can't run here",
  osascript: "Commands can't control other apps",
  open: "Commands can't open other apps (a way around the sandbox). Open it yourself",
  launchctl: "Commands can't add background services",
  crontab: "Commands can't schedule jobs",
  at: "Commands can't schedule jobs",
  schtasks: "Commands can't schedule jobs",
  "register-scheduledtask": "Commands can't schedule jobs",
  "new-service": "Commands can't add services",
  sc: "Commands can't change services",
  shutdown: "Commands can't shut down or restart the computer",
  reboot: "Commands can't shut down or restart the computer",
  halt: "Commands can't shut down or restart the computer",
  poweroff: "Commands can't shut down or restart the computer",
  "stop-computer": "Commands can't shut down or restart the computer",
  "restart-computer": "Commands can't shut down or restart the computer",
  diskutil: "Disk commands can't run here",
  diskpart: "Disk commands can't run here",
  format: "Disk commands can't run here",
  bcdedit: "System settings can't be changed here",
  csrutil: "System settings can't be changed here",
  spctl: "System settings can't be changed here",
  tccutil: "System settings can't be changed here",
  systemsetup: "System settings can't be changed here",
  networksetup: "System settings can't be changed here",
  "set-executionpolicy": "System settings can't be changed here",
  "set-itemproperty": "Commands can't change the registry or file settings outside the project",
  gh: "GitHub stays read-only: the GitHub command line (gh) can't run here",
  hub: "GitHub stays read-only: hub can't run here",
  "invoke-expression": "Commands can't run text as code (Invoke-Expression)",
  iex: "Commands can't run text as code (Invoke-Expression)",
  "invoke-command": "Remote commands can't run here",
  "enter-pssession": "Remote commands can't run here",
};

// Ways of leaving a process running out of sight.
const DETACHERS: Record<string, string> = {
  nohup: "nohup",
  disown: "disown",
  setsid: "setsid",
  screen: "screen",
  tmux: "tmux",
  pm2: "pm2",
  forever: "forever",
  bg: "bg",
  "start-process": "Start-Process",
  saps: "Start-Process",
  start: "start",
  "start-job": "Start-Job",
  "start-threadjob": "Start-ThreadJob",
};
const BACKGROUND_HINT = "can't run here, so nothing keeps running out of sight. Ask DeepSeek to use background mode instead; it shows up in the Running list";

function blockedReason(p: Program, platform: Platform): string | null {
  const n = platform === "windows" ? lower(p.name) : p.name;
  if (DETACHERS[n] && !(n === "start" && platform !== "windows")) return `${DETACHERS[n]} ${BACKGROUND_HINT}`;
  if (BLOCKED[n] && !(n === "open" && platform === "windows") && !(n === "format" && platform !== "windows") && !(n === "sc" && platform !== "windows")) return BLOCKED[n];
  if (n === "defaults" && ["write", "delete", "import", "rename"].includes(p.args[0])) return "Commands can't change app settings outside the project";
  if (n === "reg" && platform === "windows" && ["add", "delete", "import", "restore", "load", "unload", "copy"].includes(lower(p.args[0] ?? ""))) {
    return "Commands can't change the registry";
  }
  if (n === "git") {
    const sub = gitSubcommand(p.args);
    if (sub === "push") return "GitHub stays read-only: git push can't run here. Push from your own terminal";
    if (sub === "send-email" || sub === "request-pull") return "git can't send anything from here";
    if (sub === "credential" || sub === "credential-osxkeychain" || sub === "credential-manager") return "git logins can't be read here";
  }
  if ((n === "rm" || n === "remove-item" || n === "ri" || n === "del" || n === "rd" || n === "rmdir" || n === "erase") && p.args.some(outsideTarget)) {
    return "This would delete outside the project";
  }
  return null;
}

// Paths that clearly point at the whole disk or your home folder.
const outsideTarget = (a: string) => /^(\/|\/\*|~|~\/|~\/\*|\.\.|\.\.\/|\.\.\/\*|[A-Za-z]:\\?|[A-Za-z]:\\\*|\$HOME|\$env:USERPROFILE|%USERPROFILE%)$/i.test(a);

function gitSubcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "";
}

// ---------- Always ask ----------

const PUBLISHERS: Record<string, (args: string[]) => boolean> = {
  npm: (a) => ["publish", "unpublish", "deprecate", "owner", "dist-tag"].includes(a[0]),
  pnpm: (a) => a[0] === "publish",
  yarn: (a) => a[0] === "publish" || (a[0] === "npm" && a[1] === "publish"),
  bun: (a) => a[0] === "publish",
  twine: (a) => a[0] === "upload",
  cargo: (a) => a[0] === "publish",
  gem: (a) => a[0] === "push",
  docker: (a) => a[0] === "push" || (a[0] === "image" && a[1] === "push"),
  vercel: () => true,
  netlify: (a) => a[0] === "deploy",
  firebase: (a) => a[0] === "deploy",
  fly: (a) => a[0] === "deploy",
  flyctl: (a) => a[0] === "deploy",
  heroku: () => true,
  railway: (a) => a[0] === "up",
  wrangler: (a) => a[0] === "deploy" || a[0] === "publish",
  terraform: (a) => a[0] === "apply" || a[0] === "destroy",
  pulumi: (a) => a[0] === "up" || a[0] === "destroy",
  kubectl: () => true,
  helm: () => true,
  aws: () => true,
  gcloud: () => true,
  az: () => true,
  eas: (a) => a[0] === "submit" || a[0] === "update",
  supabase: (a) => a[0] === "db" && a[1] === "push",
};

function alwaysAskReason(p: Program, platform: Platform): string | null {
  const n = platform === "windows" ? lower(p.name) : p.name;
  const args = p.args;
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive" || /^-recurse$/i.test(a) || /^\/s$/i.test(a));
  if ((n === "rm" || n === "remove-item" || n === "ri" || n === "del" || n === "erase" || n === "rd" || n === "rmdir") && recursive) {
    return "Deletes folders, and commands can't be undone";
  }
  if (n === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a))) return "Runs a command or deletes files for everything it finds";
  if (n === "git") {
    const sub = gitSubcommand(args);
    const rest = args.slice(args.indexOf(sub) + 1);
    if (sub === "clean") return "Deletes untracked files, and commands can't be undone";
    if (sub === "reset" && rest.includes("--hard")) return "Throws away uncommitted work";
    if (sub === "checkout" && (rest.includes(".") || rest.includes("--") || rest.includes("-f") || rest.includes("--force"))) return "Throws away uncommitted work";
    if (sub === "restore" && !(rest.includes("--staged") && !rest.includes("--worktree"))) return "Throws away uncommitted work";
    if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return "Deletes saved stashes";
    if (sub === "branch" && rest.some((a) => a === "-D" || a === "--delete" || a === "-d")) return "Deletes a branch";
  }
  if (PUBLISHERS[n]?.(args)) return "Publishes or deploys something outside this computer";
  return null;
}

// ---------- Look-only commands (run without asking) ----------

// Arguments must stay inside the project: no absolute paths, home (~), .. or other drives.
const insideProject = (a: string) =>
  !a.startsWith("/") && !a.startsWith("~") && !/(^|[\\/])\.\.([\\/]|$)/.test(a) && !/^[A-Za-z]:/.test(a) && !a.startsWith("\\\\") && !a.includes("://");

const VERSION_PROGRAMS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "py", "pip", "pip3", "uv", "poetry", "git", "go",
  "cargo", "rustc", "java", "javac", "ruby", "gem", "php", "composer", "dotnet", "tsc", "docker", "brew", "make", "gcc", "clang",
  "swift", "xcodebuild", "kotlin", "gradle", "mvn", "flutter", "dart", "elixir", "mix", "rails", "psql", "sqlite3", "terraform",
]);

type ArgCheck = (args: string[]) => boolean;
const any: ArgCheck = () => true;
const without = (...bad: RegExp[]): ArgCheck => (args) => !args.some((a) => bad.some((r) => r.test(a)));

const LOOK_UNIX: Record<string, ArgCheck> = {
  cd: any,
  ls: any,
  pwd: any,
  cat: any,
  head: any,
  tail: without(/^-[a-zA-Z]*[fF]/, /^--follow/, /^--retry/),
  wc: any,
  grep: any,
  egrep: any,
  fgrep: any,
  rg: without(/^--pre/),
  find: without(/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/),
  tree: without(/^-o$/, /^--output/),
  du: any,
  df: any,
  file: any,
  stat: any,
  which: any,
  whereis: any,
  type: any,
  echo: any,
  basename: any,
  dirname: any,
  realpath: any,
  readlink: any,
  date: without(/^-s$/, /^--set/),
  uname: any,
  whoami: any,
  sort: without(/^-o/, /^--output/),
  uniq: (a) => a.filter((x) => !x.startsWith("-")).length <= 1,
  cut: any,
  tr: any,
  diff: any,
  cmp: any,
  comm: any,
  jq: any,
  nl: any,
  column: any,
};

const LOOK_POWERSHELL: Record<string, ArgCheck> = {
  cd: any,
  "set-location": any,
  sl: any,
  chdir: any,
  "get-childitem": any,
  gci: any,
  dir: any,
  ls: any,
  "get-content": without(/^-wait$/i, /^-tail$/i),
  gc: without(/^-wait$/i),
  cat: without(/^-wait$/i),
  type: any,
  "get-location": any,
  gl: any,
  pwd: any,
  "select-string": any,
  sls: any,
  "test-path": any,
  "get-item": any,
  gi: any,
  "resolve-path": any,
  "split-path": any,
  "join-path": any,
  "measure-object": any,
  measure: any,
  "select-object": any,
  select: any,
  "format-table": any,
  ft: any,
  "format-list": any,
  fl: any,
  "get-command": any,
  gcm: any,
  "write-output": any,
  echo: any,
  "get-date": any,
  "get-filehash": any,
  where: any,
};

const GIT_LOOK = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep", "cat-file",
  "show-ref", "name-rev", "merge-base", "count-objects", "whatchanged", "rev-list", "branch", "tag", "stash", "remote", "reflog",
]);

function gitLooks(args: string[]): boolean {
  if (!args.length || args[0].startsWith("-")) return args.length === 1 && /^(--version|-v)$/.test(args[0]);
  const [sub, ...rest] = args;
  if (!GIT_LOOK.has(sub)) return false;
  if (rest.some((a) => /^--(output|ext-diff|open-files-in-pager)/.test(a) || a === "-O")) return false;
  const positional = rest.filter((a) => !a.startsWith("-"));
  const listing = rest.some((a) => a === "-l" || a === "--list");
  switch (sub) {
    case "branch":
    case "tag":
      return !positional.length || listing;
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "remote":
      return !positional.length || (positional[0] === "get-url" && positional.length <= 2);
    case "reflog":
      return !positional.length || positional[0] === "show";
    default:
      return true;
  }
}

function versionCheck(p: Program): boolean {
  return VERSION_PROGRAMS.has(p.name.toLowerCase()) && p.args.length === 1 && /^(--version|-v|-V|version|-version)$/.test(p.args[0]);
}

function looksOnly(p: Program, platform: Platform): boolean {
  if (p.wrapped) return false;
  if (!p.args.every(insideProject)) return false;
  if (versionCheck(p)) return true;
  const n = platform === "windows" ? lower(p.name) : p.name;
  if (n === "git") return gitLooks(p.args);
  if (["npm", "pnpm", "yarn", "bun"].includes(n)) return (p.args[0] === "ls" || p.args[0] === "list" || (p.args[0] === "run" && p.args.length === 1)) && p.args.length <= 3;
  if (["pip", "pip3"].includes(n)) return ["list", "show", "freeze"].includes(p.args[0] ?? "");
  const check = platform === "windows" ? (LOOK_POWERSHELL[n] ?? LOOK_UNIX[n]) : LOOK_UNIX[n];
  return !!check && check(p.args);
}

// ---------- "Always allow" rules ----------

const TWO_WORD = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx", "node", "deno", "tsx", "ts-node", "ruby", "php", "go", "cargo", "make", "git",
  "docker", "dotnet", "mvn", "gradle", "./gradlew", "uv", "poetry", "pipenv", "bundle", "rails", "rake", "mix", "swift", "flutter",
  "dart", "composer", "pip", "pip3", "python", "python3", "py", "just", "turbo", "nx",
]);
const ONE_WORD = new Set(["pytest", "jest", "vitest", "tsc", "eslint", "prettier", "ruff", "black", "mypy", "playwright", "cypress", "biome"]);

function suggestRule(words: string[]): string {
  const [prog, a1, a2] = words;
  const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
  let n = words.length;
  if (["npm", "pnpm", "yarn", "bun"].includes(prog) && a1 === "run" && a2) n = 3;
  else if (["python", "python3", "py"].includes(prog) && a1 === "-m" && a2) n = 3;
  else if (["uv", "poetry", "pipenv"].includes(prog) && a1 === "run" && a2) n = 3;
  else if (TWO_WORD.has(prog) && a1 && !a1.startsWith("-")) n = 2;
  else if (ONE_WORD.has(prog)) n = 1;
  return words.slice(0, n).map(quote).join(" ");
}

// Does a command match one of the project's "Always allow" rules?
// Only plain, single commands match: no chains, pipes, redirects or $variables.
export function matchesRule(cmd: string, rules: string[], platform: Platform): boolean {
  if (!rules.length) return false;
  const parsed = parse(cmd, platform);
  if (parsed.complex || parsed.redirect || parsed.background || parsed.segments.length !== 1) return false;
  const seg = parsed.segments[0];
  if (seg.envPrefix) return false;
  const norm = (w: string, i: number) => (i === 0 && platform === "windows" ? programName(w, platform) : w);
  const words = seg.words.map(norm);
  return rules.some((rule) => {
    const r = parse(rule, platform);
    if (r.complex || r.segments.length !== 1) return false;
    const rw = r.segments[0].words.map(norm);
    return rw.length > 0 && rw.length <= words.length && rw.every((w, i) => w === words[i]);
  });
}

// ---------- The verdict ----------

const worst = (a: Level, b: Level): Level => {
  const order: Level[] = ["look", "ask", "always_ask", "blocked"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
};

// Things we look for even in commands we can't fully read.
const RAW_BLOCKS: [RegExp, string][] = [
  [/(^|[\s;&|(`$])sudo\s/, BLOCKED.sudo],
  [/(^|[\s;&|(`$])git\b[^;&|\n]*\spush\b/, "GitHub stays read-only: git push can't run here. Push from your own terminal"],
  [/(^|[\s;&|(`$])gh\s/, BLOCKED.gh],
  [/(^|[\s;&|(`$])security\s+(find|dump|export|unlock|add|delete|set)/, BLOCKED.security],
  [/(^|[\s;&|(`$])osascript\b/, BLOCKED.osascript],
  [/\b(invoke-expression|iex)\b/i, BLOCKED.iex],
  [/(^|[\s;&|(`$])nohup\s/, `nohup ${BACKGROUND_HINT}`],
];

export function classifyCommand(cmd: string, platform: Platform, appPorts: number[] = []): Verdict {
  const text = cmd.trim();
  if (!text) return { level: "blocked", reason: "The command is empty" };
  if (text.length > 20_000) return { level: "blocked", reason: "The command is too long" };
  for (const port of appPorts) {
    if (new RegExp(`(localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0):${port}\\b`).test(text)) {
      return { level: "blocked", reason: "Commands can't talk to this app itself" };
    }
  }
  const parsed = parse(text, platform);
  if (parsed.background) return { level: "blocked", reason: `A trailing & ${BACKGROUND_HINT}` };

  let level: Level = "look";
  let reason: string | undefined;
  const raise = (l: Level, r?: string) => {
    if (worst(level, l) !== level) {
      level = l;
      reason = r;
    } else if (l === level && r && !reason) reason = r;
  };

  if (parsed.complex) {
    raise("ask");
    for (const [re, why] of RAW_BLOCKS) if (re.test(text)) raise("blocked", why);
  }
  if (parsed.redirect) raise("ask");

  // Secret files (.env, keys) always need a click, even when they're only read.
  const mentionsSecret = parsed.segments.some((s) => s.words.some((w) => w.split(/[\s=,]/).some((part) => part && isSecretFile(part.replace(/[)"']+$/, "")))));
  if (mentionsSecret) raise("always_ask", "Touches a secret file (like .env)");

  for (const seg of parsed.segments) {
    if (seg.envPrefix) raise("ask");
    const p = unwrap(seg.words, platform);
    if (!p.name) {
      raise("ask");
      continue;
    }
    const block = blockedReason(p, platform);
    if (block) raise("blocked", block);
    // `curl … | sh`: the shell reads its program from the pipe. (`… | python3 -m json.tool` is fine.)
    const readsProgramFromPipe = !p.args.some((a) => !a.startsWith("-") || /^-(c|e|m|command)$/i.test(a));
    if (seg.piped && INTERPRETERS.has(lower(p.name)) && readsProgramFromPipe) {
      raise("blocked", "Piping into a shell or interpreter runs code from somewhere else");
    }
    if (p.nested !== undefined) {
      if (p.nested === "\u0000encoded") raise("blocked", "Encoded commands can't be checked, so they can't run");
      else {
        const inner = classifyCommand(p.nested, platform, appPorts);
        raise(worst(inner.level, "ask"), inner.reason);
      }
      continue;
    }
    const always = alwaysAskReason(p, platform);
    if (always) raise("always_ask", always);
    if (!looksOnly(p, platform)) raise("ask");
  }

  const final = level as Level; // (TypeScript can't see that raise() changes it)
  const verdict: Verdict = { level: final, ...(reason ? { reason } : {}) };
  const single = parsed.segments.length === 1 && !parsed.complex && !parsed.redirect && !parsed.segments[0].envPrefix;
  if (final === "ask" && single) verdict.rule = suggestRule(parsed.segments[0].words);
  return verdict;
}

// Does this command need your click before it runs?
export function needsApproval(v: Verdict, opts: { mode: Mode; platform: Platform; allowed: boolean }): boolean {
  if (v.level === "look") return false;
  if (v.level !== "ask") return true; // always_ask (blocked never gets this far)
  if (opts.mode === "ask" || opts.mode === "plan") return true;
  if (opts.allowed) return false; // matches one of your "Always allow" rules
  if (opts.platform !== "mac") return true; // no sandbox: always ask
  return opts.mode !== "auto";
}

// Code block languages that get a ▶ Run button.
export const RUNNABLE_LANGS: Record<Platform, Set<string>> = {
  mac: new Set(["bash", "sh", "zsh", "shell", "console", "terminal", "shellscript", "shell-session"]),
  windows: new Set(["powershell", "ps1", "ps", "pwsh", "bash", "sh", "shell", "console", "terminal"]),
  other: new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]),
};

// The command(s) in a code block. In "console" style blocks, only the lines after a prompt ($, %, >, PS C:\>).
export function commandFromBlock(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const prompt = /^\s*(?:PS [^>]*>|[$%>])\s+/;
  const prompted = lines.filter((l) => prompt.test(l));
  const picked = prompted.length ? prompted.map((l) => l.replace(prompt, "")) : lines;
  return picked.join("\n").trim();
}
