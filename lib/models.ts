// The AI providers (DeepSeek and Claude), what each model can do, and what it costs.
// Shared by the server and the browser. Claude's model list comes from your key (see claude.ts);
// DeepSeek's is fixed below.

export type Provider = "deepseek" | "claude";
export const PROVIDERS: Provider[] = ["deepseek", "claude"];
export const PROVIDER_NAME: Record<Provider, string> = { deepseek: "DeepSeek", claude: "Claude" };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as string[]).includes(v);
export const EFFORT_SHORT: Record<Effort, string> = { low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max" };

// The effort the chat asked for, or the closest one the model accepts (never more).
export function nearestEffort(wanted: Effort, allowed: Effort[]): Effort | null {
  if (!allowed.length) return null;
  if (allowed.includes(wanted)) return wanted;
  const at = EFFORTS.indexOf(wanted);
  const lower = allowed.filter((e) => EFFORTS.indexOf(e) < at);
  return lower.length ? lower[lower.length - 1] : allowed[0];
}


export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string; // e.g. "Opus 5.5", "V4.1 Flash"
  family: string; // e.g. "Opus", "Sonnet", "DeepSeek"
  description?: string;
  vision: boolean; // can see images
  pdf: boolean; // reads PDFs itself (pages, scans, charts), not just their text
  context: number; // context window, in tokens
  maxOutput: number;
  efforts: Effort[]; // effort levels it accepts ([] = no effort setting)
  // "toggle": you can switch thinking on and off; "always": it always thinks (effort is the control);
  // "none": it doesn't think.
  thinking: "toggle" | "always" | "none";
  thinkingType?: "adaptive" | "enabled"; // Claude: how thinking is requested
  summarize: "native" | "app"; // long chats: summarized by the API itself, or by the app
  createdAt?: string;
}

export const DEEPSEEK_MODELS: ModelInfo[] = [
  // `deepseek-flash` always points at DeepSeek's newest Flash model (DeepSeek-V4.1-Flash since
  // Sept 10, 2026); `deepseek-v4-pro` is DeepSeek-V4-Pro-0813. Update the labels if DeepSeek upgrades them.
  {
    id: "deepseek-flash",
    provider: "deepseek",
    label: "V4.1 Flash",
    family: "DeepSeek",
    description: "Fast and cheap. Can see images.",
    vision: true,
    pdf: false,
    context: 1_000_000,
    maxOutput: 64_000,
    efforts: ["high", "max"],
    thinking: "toggle",
    summarize: "app",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "V4 Pro",
    family: "DeepSeek",
    description: "Smartest (version 0813). Text only.",
    vision: false,
    pdf: false,
    context: 1_000_000,
    maxOutput: 64_000,
    efforts: ["high", "max"],
    thinking: "toggle",
    summarize: "app",
  },
];

export const providerOf = (model: string): Provider => (model.startsWith("deepseek") ? "deepseek" : "claude");
export const aiName = (model: string) => PROVIDER_NAME[providerOf(model)];
export const validModelId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9.\-]{2,100}$/.test(v);

// ---------- Claude model ids ----------

const FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;
const FAMILY_ORDER = ["Fable", "Mythos", "Opus", "Sonnet", "Haiku"];

// "claude-opus-5-5" → { family: "opus", major: 5, minor: 5 }; "claude-3-5-sonnet-20241022" → sonnet 3.5.
export function parseClaudeId(id: string): { family: string; major: number; minor: number } | null {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (m) return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-(fable|mythos|opus|sonnet|haiku)(?:-|$)/.exec(id);
  if (old) return { family: old[3], major: Number(old[1]), minor: old[2] ? Number(old[2]) : 0 };
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A readable name from a model id alone, for chats whose model isn't in the list (any more).
export function labelFromId(id: string): string {
  const d = DEEPSEEK_MODELS.find((m) => m.id === id);
  if (d) return d.label;
  const p = parseClaudeId(id);
  if (p) return `${cap(p.family)} ${p.major}${p.minor ? `.${p.minor}` : ""}`;
  if (id.endsWith("mythos-preview")) return "Mythos Preview";
  return id;
}

export function familyOf(id: string): string {
  const p = parseClaudeId(id);
  if (p) return cap(p.family);
  const f = FAMILIES.find((x) => id.includes(x));
  return f ? cap(f) : "Other";
}

// At least this version (e.g. atLeast("claude-opus-5-5", "opus", 5, 5)). Unknown ids count as new.
export function atLeast(id: string, family: string, major: number, minor = 0): boolean {
  const p = parseClaudeId(id);
  if (!p || p.family !== family) return false;
  return p.major > major || (p.major === major && p.minor >= minor);
}

// Sort for the model picker: by family, then newest first.
export function sortModels(list: ModelInfo[]): ModelInfo[] {
  const rank = (m: ModelInfo) => (m.provider === "deepseek" ? -1 : FAMILY_ORDER.indexOf(m.family) === -1 ? 99 : FAMILY_ORDER.indexOf(m.family));
  const version = (m: ModelInfo) => {
    const p = parseClaudeId(m.id);
    return p ? p.major * 100 + p.minor : 0;
  };
  return [...list].sort(
    (a, b) => rank(a) - rank(b) || version(b) - version(a) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
  );
}

// ---------- What a Claude model accepts ----------
// The Models API reports thinking, effort, images, PDFs and summarizing for the models your key
// can use (see claude.ts). For anything it doesn't say, these guesses go by the model's version.

// Which way thinking can be switched off, if it can.
export function thinkingOff(id: string, type: ModelInfo["thinkingType"]): "disabled" | "between_tools" | "omit" | null {
  if (type === "enabled") return "omit";
  const p = parseClaudeId(id);
  if (!p) return null;
  if (p.family === "opus") return atLeast(id, "opus", 5, 5) ? null : "disabled";
  if (p.family === "sonnet") return atLeast(id, "sonnet", 5, 5) ? "between_tools" : "disabled";
  return null; // Fable and Mythos always think
}

// A best guess from the model's name, for when the Models API doesn't say.
export function guessModelInfo(id: string): ModelInfo {
  const p = parseClaudeId(id);
  const fam = p?.family ?? "";
  const big = fam === "fable" || fam === "mythos" || atLeast(id, "opus", 4, 6) || atLeast(id, "sonnet", 4, 6);
  const adaptive = big;
  const efforts: Effort[] =
    fam === "fable" || fam === "mythos" || atLeast(id, "opus", 4, 7) || atLeast(id, "sonnet", 5)
      ? [...EFFORTS]
      : atLeast(id, "opus", 4, 5) || atLeast(id, "sonnet", 4, 6)
        ? ["low", "medium", "high", "max"]
        : [];
  // Older models (Claude 4.5 and earlier, Sonnet 3.7) think with a token budget instead.
  const budget = !!p && (p.major >= 4 || (p.major === 3 && p.minor === 7));
  const thinkingType: ModelInfo["thinkingType"] = adaptive ? "adaptive" : budget ? "enabled" : undefined;
  return finishModelInfo({
    id,
    provider: "claude",
    label: labelFromId(id),
    family: familyOf(id),
    vision: true,
    pdf: true,
    context: big ? 1_000_000 : 200_000,
    maxOutput: big ? 128_000 : 64_000,
    efforts,
    thinking: "none",
    thinkingType,
    summarize: big ? "native" : "app",
  });
}

export function finishModelInfo(info: ModelInfo): ModelInfo {
  info.thinking = !info.thinkingType ? "none" : thinkingOff(info.id, info.thinkingType) ? "toggle" : "always";
  info.description = [formatPrice(info.id), `${formatContext(info.context)} context`].filter(Boolean).join(" · ");
  return info;
}

// Details for any model id: DeepSeek's are fixed; for Claude, a guess when it isn't in your key's list.
export function modelInfoFor(id: string, claude: ModelInfo[] = []): ModelInfo {
  return DEEPSEEK_MODELS.find((m) => m.id === id) ?? claude.find((m) => m.id === id) ?? guessModelInfo(id);
}

// ---------- Prices (USD per million tokens) ----------
// The API doesn't report prices, so they're kept here. Source: platform.claude.com/docs/en/about-claude/pricing
// (October 2026). A model that isn't listed still works; its cost just shows as unknown.

interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const CLAUDE_PRICES: [string, Price][] = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-3-7-sonnet", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25, cacheRead: 0.03 }],
];

// The longest matching prefix wins, so "claude-opus-5-5-…" isn't priced as "claude-opus-5".
export function claudePrice(id: string): Price | null {
  let best: [string, Price] | null = null;
  for (const entry of CLAUDE_PRICES) {
    const [prefix] = entry;
    if ((id === prefix || id.startsWith(prefix + "-")) && (!best || prefix.length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

export const WEB_SEARCH_PRICE = 0.01; // Claude's web search: $10 per 1,000 searches

export function formatPrice(id: string): string | null {
  const p = claudePrice(id);
  if (!p) return null;
  const n = (x: number) => (x < 1 ? `$${x}` : `$${x % 1 ? x.toFixed(2) : x}`);
  return `${n(p.input)} / ${n(p.output)} per M tokens`;
}

export function formatContext(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`;
}

// ---------- Per-provider limits ----------

// What each provider may ever do. These sit above the project and chat switches: a limit that's
// off turns the feature off for that provider everywhere, whatever the project or chat says.
export interface ProviderLimits {
  folders: boolean; // read project and chat folders
  edit: boolean; // change files (Edit mode)
  auto: boolean; // change files without asking (Auto mode)
  commands: boolean; // run terminal commands
  github: boolean; // read GitHub
  docs: boolean; // save to the Docs folder
  search: boolean; // search and read the web
  code: boolean; // Claude only: run code in Anthropic's sandbox
}

export const LIMIT_KEYS: (keyof ProviderLimits)[] = ["folders", "edit", "auto", "commands", "github", "docs", "search", "code"];

export const LIMIT_LABELS: Record<keyof ProviderLimits, { label: string; hint: string }> = {
  folders: { label: "Read folders", hint: "Explore the project and chat folders you link" },
  edit: { label: "Change files", hint: "Allows Edit mode, where you approve each change" },
  auto: { label: "Auto mode", hint: "Change files without asking first" },
  commands: { label: "Run commands", hint: "In projects with Terminal switched on" },
  github: { label: "Read GitHub", hint: "Only your allowed repos, read-only" },
  docs: { label: "Save to Docs", hint: "Save documents to your Docs folder" },
  search: { label: "Web search", hint: "Search and read web pages" },
  code: { label: "Code execution", hint: "Run Python in Anthropic's sandbox, not on your computer" },
};

export const ALL_ALLOWED: ProviderLimits = { folders: true, edit: true, auto: true, commands: true, github: true, docs: true, search: true, code: true };
export const NONE_ALLOWED: ProviderLimits = { folders: false, edit: false, auto: false, commands: false, github: false, docs: false, search: false, code: false };
