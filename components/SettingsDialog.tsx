"use client";
import { CheckCircle2, Globe, KeyRound, Keyboard, Loader2, MessageSquareText, Palette, Paperclip, ScrollText, SlidersHorizontal, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client";
import { EFFORT_SHORT, EFFORTS, type ModelInfo } from "@/lib/models";
import type { KeyStatus, Settings } from "@/lib/types";
import { ProviderCard } from "./ProviderSettings";
import { SkillsSection } from "./SkillsSettings";
import { DocsSection, GitHubSection } from "./SettingsSections";
import { Button, Fold, FoldSection, Modal, Segmented, Switch } from "./ui";

type Theme = "system" | "light" | "dark";

export function applyTheme(theme: Theme) {
  localStorage.setItem("theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

const SOURCE_LABEL: Record<NonNullable<KeyStatus["source"]>, string> = {
  keychain: "saved in your macOS Keychain",
  windows: "saved encrypted with your Windows login",
  env: "from .env.local",
  settings: "saved in data/settings.json",
};

const SUMMARIZE_OPTIONS = [
  { value: "0", label: "Never" },
  { value: "100000", label: "100K" },
  { value: "200000", label: "200K" },
  { value: "400000", label: "400K" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  keyStatus: KeyStatus | null;
  claudeKey: KeyStatus | null;
  searchKey: KeyStatus | null;
  githubKey: KeyStatus | null;
  models: { deepseek: ModelInfo[]; claude: ModelInfo[] };
  defaultSystemPrompt: string;
  onKeysChanged: () => void; // a key was saved or removed: reload keys and the model list
  onSaved: (s: Settings) => void;
}

// Mounted fresh each time it opens, so the form always starts from the saved values.
export function SettingsDialog(props: Props) {
  if (!props.open || !props.settings) return null;
  return <SettingsForm {...props} settings={props.settings} />;
}

function SettingsForm({ open, onClose, settings, keyStatus, claudeKey, searchKey, githubKey, models, defaultSystemPrompt, onKeysChanged, onSaved }: Props & { settings: Settings }) {
  const [ghStatus, setGhStatus] = useState<KeyStatus | null>(githubKey);
  const [draft, setDraft] = useState<Settings>(settings);
  const [status, setStatus] = useState<KeyStatus | null>(keyStatus);
  const [claudeStatus, setClaudeStatus] = useState<KeyStatus | null>(claudeKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");
  const [tavilyKey, setTavilyKey] = useState("");
  const [searchStatus, setSearchStatus] = useState<KeyStatus | null>(searchKey);
  const [searchMsg, setSearchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [blocked, setBlocked] = useState(settings.claudeBlockedSites.join("\n"));

  type TavilyTest = { ok: boolean; error?: string; usage?: { used: number; limit: number | null } };
  const describeUsage = (t: TavilyTest) =>
    t.usage ? ` ${t.usage.used.toLocaleString()}${t.usage.limit ? ` of ${t.usage.limit.toLocaleString()}` : ""} credits used this month.` : "";

  const saveTavilyKey = async () => {
    setBusy("tavily");
    setSearchMsg(null);
    try {
      const st = await api<KeyStatus>("/api/settings/key", { method: "POST", json: { key: tavilyKey, provider: "tavily" } });
      setSearchStatus(st);
      setTavilyKey("");
      const test = await api<TavilyTest>("/api/settings/test?provider=tavily", { method: "POST" });
      setSearchMsg(test.ok ? { ok: true, text: `Saved and verified.${describeUsage(test)}` } : { ok: false, text: test.error ?? "Saved, but the test failed." });
      if (test.ok) setDraft((d) => ({ ...d, webSearch: true }));
      onKeysChanged();
    } catch (e) {
      setSearchMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const testTavilyKey = async () => {
    setBusy("tavily-test");
    setSearchMsg(null);
    const test = await api<TavilyTest>("/api/settings/test?provider=tavily", { method: "POST" }).catch((e) => ({ ok: false, error: (e as Error).message }) as TavilyTest);
    setSearchMsg(test.ok ? { ok: true, text: `Connected to Tavily.${describeUsage(test)}` } : { ok: false, text: test.error ?? "Test failed." });
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    try {
      const claudeBlockedSites = blocked.split(/[\s,]+/).filter(Boolean);
      const { settings: saved } = await api<{ settings: Settings }>("/api/settings", { method: "POST", json: { ...draft, claudeBlockedSites } });
      onSaved(saved);
      onClose();
    } finally {
      setBusy(null);
    }
  };

  // The default model can be any model you have a key for.
  const choices = [...(status?.configured ? models.deepseek : []), ...(claudeStatus?.configured ? models.claude : [])];
  const defaultChoices = choices.length ? choices : models.deepseek;
  const hasClaude = !!claudeStatus?.configured;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      width="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy === "save"}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <FoldSection
          id="settings-providers"
          title="AI providers"
          icon={<KeyRound size={15} />}
          defaultOpen
          summary={[status?.configured && "DeepSeek", claudeStatus?.configured && "Claude"].filter(Boolean).join(" · ") || "No keys yet"}
        >
          <Fold label="How this works">
            Add a key for DeepSeek, Claude or both, and pick the model in each chat. Keys are saved right away; the switches below are saved with
            <b> Save</b>.
          </Fold>
          <div className="grid gap-3 lg:grid-cols-2">
            <ProviderCard
              provider="deepseek"
              status={status}
              limits={draft.limits.deepseek}
              onLimits={(l) => setDraft({ ...draft, limits: { ...draft.limits, deepseek: l } })}
              onKeyChanged={(st) => {
                setStatus(st);
                onKeysChanged();
              }}
            />
            <ProviderCard
              provider="claude"
              status={claudeStatus}
              limits={draft.limits.claude}
              onLimits={(l) => setDraft({ ...draft, limits: { ...draft.limits, claude: l } })}
              onKeyChanged={(st) => {
                setClaudeStatus(st);
                onKeysChanged();
              }}
            >
              <Fold label="Web search and safety options" plain className="mt-3 border-t border-line pt-2.5">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13px]">Web searches per reply</div>
                      <div className="text-xs text-muted">$10 per 1,000 searches, plus the pages it reads as input</div>
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={draft.claudeMaxSearches}
                      onChange={(e) => setDraft({ ...draft, claudeMaxSearches: Math.max(1, Math.min(50, Number(e.target.value) || 5)) })}
                      aria-label="Web searches per reply"
                      className="h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right text-[13px] tabular-nums outline-none"
                    />
                  </div>
                  <div>
                    <div className="text-[13px]">Sites Claude never uses</div>
                    <div className="mb-1 text-xs text-muted">For web search and page reading. One site per line, e.g. example.com</div>
                    <textarea
                      value={blocked}
                      onChange={(e) => setBlocked(e.target.value)}
                      rows={2}
                      aria-label="Sites Claude never uses"
                      placeholder="example.com"
                      className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[12.5px] outline-none focus:border-line-strong"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13px]">Retry mistaken declines on another Claude model</div>
                      <div className="text-xs text-muted">
                        Safety checks sometimes flag harmless requests. Another Claude model answers instead (at its own price), and the reply says so.
                      </div>
                    </div>
                    <Switch checked={draft.claudeFallback} onChange={(v) => setDraft({ ...draft, claudeFallback: v })} label="Retry declines on another Claude model" />
                  </div>
                </div>
              </Fold>
            </ProviderCard>
          </div>
        </FoldSection>

        <FoldSection
          id="settings-defaults"
          title="Defaults for new chats"
          icon={<SlidersHorizontal size={15} />}
          defaultOpen
          summary={defaultChoices.find((m) => m.id === draft.defaultModel)?.label ?? draft.defaultModel}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13.5px]">Model</span>
            <select
              value={draft.defaultModel}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
              aria-label="Default model"
              className="h-8 max-w-64 rounded-lg border border-line bg-app px-2 text-[13px] outline-none"
            >
              {!defaultChoices.some((m) => m.id === draft.defaultModel) && <option value={draft.defaultModel}>{draft.defaultModel} (not available)</option>}
              {["DeepSeek", "Claude"].map((group) => {
                const list = defaultChoices.filter((m) => (m.provider === "deepseek") === (group === "DeepSeek"));
                return list.length ? (
                  <optgroup key={group} label={group}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {group === "Claude" ? `Claude ${m.label}` : m.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
          <div className="grid gap-x-8 gap-y-3 lg:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-[13.5px]" title="Better answers on hard problems; slower and uses more tokens">
                  DeepSeek: thinking
                </div>
                <Switch checked={draft.thinking} onChange={(v) => setDraft({ ...draft, thinking: v })} label="DeepSeek thinking" />
              </div>
              {draft.thinking && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[13.5px]">DeepSeek: effort</span>
                  <Segmented
                    value={draft.effort === "max" ? "max" : "high"}
                    onChange={(v) => setDraft({ ...draft, effort: v })}
                    options={[
                      { value: "high", label: "High" },
                      { value: "max", label: "Max" },
                    ]}
                  />
                </div>
              )}
            </div>
            {hasClaude && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-[13.5px]" title="For models that can switch it off (the newest Opus and Fable always think)">
                    Claude: thinking
                  </div>
                  <Switch checked={draft.claudeThinking} onChange={(v) => setDraft({ ...draft, claudeThinking: v })} label="Claude thinking" />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[13.5px]" title="How hard it works. A model without a level uses the nearest one below.">
                    Claude: effort
                  </span>
                  <Segmented value={draft.claudeEffort} onChange={(v) => setDraft({ ...draft, claudeEffort: v })} options={EFFORTS.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))} />
                </div>
              </div>
            )}
          </div>
        </FoldSection>

        <FoldSection
          id="settings-long-chats"
          title="Long chats"
          icon={<ScrollText size={15} />}
          summary={draft.summarizeAt ? `Summarize past ${SUMMARIZE_OPTIONS.find((o) => o.value === String(draft.summarizeAt))?.label ?? draft.summarizeAt} tokens` : "Never summarize"}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13.5px]">Summarize earlier messages past</span>
            <Segmented value={String(draft.summarizeAt)} onChange={(v) => setDraft({ ...draft, summarizeAt: Number(v) })} options={SUMMARIZE_OPTIONS} />
          </div>
          <Fold label="How summarizing works">
            Past this size, the earlier messages are summarized and the AI continues from the summary: faster and cheaper, for DeepSeek and Claude.
            You still see every message, and the chat shows where the summary starts. You can also summarize any chat from its token meter.
          </Fold>
        </FoldSection>

        <FoldSection id="settings-tavily" title="Web search for DeepSeek" icon={<Globe size={15} />} summary={draft.webSearch ? "On" : "Off"}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13.5px]">Show the Search button in DeepSeek chats</span>
            <Switch checked={draft.webSearch} onChange={(v) => setDraft({ ...draft, webSearch: v })} label="Web search" />
          </div>
          <Fold label="How it works">
            DeepSeek looks things up through Tavily and cites its sources. Get a free key (1,000 searches a month, no card) at{" "}
            <a href="https://app.tavily.com" target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
              app.tavily.com
            </a>
            . Claude chats use Claude&apos;s own search instead (see AI providers).
          </Fold>
          {(draft.webSearch || searchStatus?.configured) && (
            <div className="rounded-xl border border-line bg-app p-3">
              <p className="mb-2 text-[12.5px] text-muted">
                {searchStatus?.configured ? (
                  <>
                    Tavily key ending in <span className="font-mono">…{searchStatus.hint}</span>,{" "}
                    {searchStatus.source === "env" ? "from .env.local (TAVILY_API_KEY)" : SOURCE_LABEL[searchStatus.source!]}.
                  </>
                ) : (
                  <>No Tavily key yet.</>
                )}
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={tavilyKey}
                  onChange={(e) => setTavilyKey(e.target.value)}
                  placeholder={searchStatus?.configured ? "Paste a new key to replace it" : "tvly-…"}
                  autoComplete="off"
                  className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] outline-none focus:border-line-strong"
                />
                <Button variant="primary" onClick={saveTavilyKey} disabled={!tavilyKey.trim() || !!busy}>
                  {busy === "tavily" && <Loader2 size={14} className="animate-spin" />}
                  Save key
                </Button>
                {searchStatus?.configured && (
                  <Button onClick={testTavilyKey} disabled={!!busy}>
                    {busy === "tavily-test" && <Loader2 size={14} className="animate-spin" />}
                    Test
                  </Button>
                )}
              </div>
              {searchMsg && (
                <div className={`mt-2 flex items-center gap-1.5 text-[12.5px] ${searchMsg.ok ? "text-green-600 dark:text-green-400" : "text-danger"}`}>
                  {searchMsg.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {searchMsg.text}
                </div>
              )}
              {draft.webSearch && !searchStatus?.configured && (
                <p className="mt-2 text-xs text-warn">The Search button won&apos;t work until a Tavily key is saved.</p>
              )}
            </div>
          )}
        </FoldSection>

        <DocsSection draft={draft} setDraft={setDraft} />

        <GitHubSection
          draft={draft}
          setDraft={setDraft}
          status={ghStatus}
          setStatus={(st) => {
            setGhStatus(st);
            onKeysChanged();
          }}
        />

        <FoldSection
          id="settings-instructions"
          title="Instructions for the AI"
          icon={<MessageSquareText size={15} />}
          summary={draft.systemPrompt.trim() === defaultSystemPrompt.trim() ? "Default" : "Your own"}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Sent at the start of every chat, to DeepSeek and Claude alike.</span>
            <button type="button" onClick={() => setDraft({ ...draft, systemPrompt: defaultSystemPrompt })} className="text-xs text-muted hover:text-fg">
              Reset to default
            </button>
          </div>
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            rows={6}
            aria-label="Instructions for the AI"
            className="w-full resize-y rounded-lg border border-line bg-app px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-line-strong"
          />
        </FoldSection>

        <SkillsSection draft={draft} setDraft={setDraft} />

        <FoldSection id="settings-files" title="Files" icon={<Paperclip size={15} />} summary={`Up to ${draft.maxFileChars.toLocaleString()} characters per file`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13.5px]">Max characters per attached file</div>
              <div className="text-xs text-muted">Longer files are cut off (with a note) so one file can&apos;t eat the whole context</div>
            </div>
            <input
              type="number"
              min={1000}
              step={10000}
              value={draft.maxFileChars}
              onChange={(e) => setDraft({ ...draft, maxFileChars: Number(e.target.value) || 100000 })}
              aria-label="Max characters per attached file"
              className="h-8 w-28 rounded-lg border border-line bg-app px-2 text-right text-[13px] tabular-nums outline-none"
            />
          </div>
        </FoldSection>

        <FoldSection id="settings-appearance" title="Appearance" icon={<Palette size={15} />} summary={theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"}>
          <div className="flex items-center justify-between">
            <span className="text-[13.5px]">Theme</span>
            <Segmented
              value={theme}
              onChange={(v) => {
                setTheme(v);
                applyTheme(v);
              }}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </FoldSection>

        <FoldSection id="settings-shortcuts" title="Keyboard shortcuts" icon={<Keyboard size={15} />}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
            {[
              ["Send", "Enter"],
              ["New line", "Shift + Enter"],
              ["New chat", "⌘ ⇧ O"],
              ["Search chats", "⌘ K"],
              ["Toggle sidebar", "⌘ B"],
              ["Stop reply", "Esc"],
              ["Mention a project file", "@"],
              ["Paste long text", "Becomes an attachment"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line py-1">
                <span className="text-muted">{k}</span>
                <kbd className="font-sans text-fg">{v}</kbd>
              </div>
            ))}
          </div>
        </FoldSection>
      </div>
    </Modal>
  );
}
