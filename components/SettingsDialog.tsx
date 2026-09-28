"use client";
import { CheckCircle2, Globe, KeyRound, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client";
import { MODELS, type KeyStatus, type ModelId, type Settings } from "@/lib/types";
import { DocsSection, GitHubSection } from "./SettingsSections";
import { Button, Modal, Segmented, Switch } from "./ui";

type Theme = "system" | "light" | "dark";

export function applyTheme(theme: Theme) {
  localStorage.setItem("theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

const SOURCE_LABEL: Record<NonNullable<KeyStatus["source"]>, string> = {
  keychain: "saved in your macOS Keychain",
  env: "from .env.local (DEEPSEEK_API_KEY)",
  settings: "saved in data/settings.json",
};

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  keyStatus: KeyStatus | null;
  searchKey: KeyStatus | null;
  githubKey: KeyStatus | null;
  defaultSystemPrompt: string;
  onSaved: (s: Settings, k: KeyStatus, searchKey: KeyStatus, githubKey: KeyStatus) => void;
}

// Mounted fresh each time it opens, so the form always starts from the saved values.
export function SettingsDialog(props: Props) {
  if (!props.open || !props.settings) return null;
  return <SettingsForm {...props} settings={props.settings} />;
}

function SettingsForm({ open, onClose, settings, keyStatus, searchKey, githubKey, defaultSystemPrompt, onSaved }: Props & { settings: Settings }) {
  const [ghStatus, setGhStatus] = useState<KeyStatus | null>(githubKey);
  const [draft, setDraft] = useState<Settings>(settings);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<KeyStatus | null>(keyStatus);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");
  const [tavilyKey, setTavilyKey] = useState("");
  const [searchStatus, setSearchStatus] = useState<KeyStatus | null>(searchKey);
  const [searchMsg, setSearchMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
      onSaved(settings, status!, st, ghStatus!);
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

  const saveKey = async () => {
    setBusy("key");
    setKeyMsg(null);
    try {
      const s = await api<KeyStatus>("/api/settings/key", { method: "POST", json: { key } });
      setStatus(s);
      setKey("");
      const test = await api<{ ok: boolean; error?: string }>("/api/settings/test", { method: "POST" });
      setKeyMsg(test.ok ? { ok: true, text: "Saved and verified with DeepSeek." } : { ok: false, text: test.error ?? "Saved, but the test failed." });
      onSaved(settings, s, searchStatus!, ghStatus!);
    } catch (e) {
      setKeyMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const testKey = async () => {
    setBusy("test");
    setKeyMsg(null);
    const test = await api<{ ok: boolean; error?: string }>("/api/settings/test", { method: "POST" }).catch((e) => ({
      ok: false,
      error: (e as Error).message,
    }));
    setKeyMsg(test.ok ? { ok: true, text: "Connected to DeepSeek." } : { ok: false, text: test.error ?? "Test failed." });
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    try {
      const { settings: saved } = await api<{ settings: Settings }>("/api/settings", { method: "POST", json: draft });
      onSaved(saved, status!, searchStatus!, ghStatus!);
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      width="max-w-xl"
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
      <div className="space-y-6">
        <section>
          <h3 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
            <KeyRound size={15} /> DeepSeek API key
          </h3>
          <p className="mb-2.5 text-[12.5px] text-muted">
            {status?.configured ? (
              <>
                Key ending in <span className="font-mono">…{status.hint}</span> is {SOURCE_LABEL[status.source!]}. It stays on your
                computer and is never sent to the browser.
              </>
            ) : (
              <>No key yet. Get one at platform.deepseek.com → API keys. It&apos;s stored in your macOS Keychain.</>
            )}
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status?.configured ? "Paste a new key to replace it" : "sk-…"}
              autoComplete="off"
              className="h-9 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[13px] outline-none focus:border-line-strong"
            />
            <Button variant="primary" onClick={saveKey} disabled={!key.trim() || !!busy}>
              {busy === "key" && <Loader2 size={14} className="animate-spin" />}
              Save key
            </Button>
            {status?.configured && (
              <Button onClick={testKey} disabled={!!busy}>
                {busy === "test" && <Loader2 size={14} className="animate-spin" />}
                Test
              </Button>
            )}
          </div>
          {keyMsg && (
            <div className={`mt-2 flex items-center gap-1.5 text-[12.5px] ${keyMsg.ok ? "text-green-600 dark:text-green-400" : "text-danger"}`}>
              {keyMsg.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {keyMsg.text}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-[14px] font-semibold">Defaults for new chats</h3>
          <div className="flex items-center justify-between">
            <span className="text-[13.5px]">Model</span>
            <Segmented
              value={draft.defaultModel}
              onChange={(v: ModelId) => setDraft({ ...draft, defaultModel: v })}
              options={(Object.keys(MODELS) as ModelId[]).map((id) => ({ value: id, label: MODELS[id].label }))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13.5px]">Thinking</div>
              <div className="text-xs text-muted">Better answers on hard problems; slower and uses more tokens</div>
            </div>
            <Switch checked={draft.thinking} onChange={(v) => setDraft({ ...draft, thinking: v })} label="Thinking" />
          </div>
          {draft.thinking && (
            <div className="flex items-center justify-between">
              <span className="text-[13.5px]">Thinking effort</span>
              <Segmented
                value={draft.effort}
                onChange={(v) => setDraft({ ...draft, effort: v })}
                options={[
                  { value: "high", label: "High" },
                  { value: "max", label: "Max" },
                ]}
              />
            </div>
          )}
        </section>

        <section className="space-y-2.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="flex items-center gap-2 text-[14px] font-semibold">
                <Globe size={15} /> Web search
              </h3>
              <div className="text-xs text-muted">
                Adds a <b>Search</b> button next to Think. When it&apos;s on in a chat, DeepSeek can look things up online and cite its
                sources.
              </div>
            </div>
            <Switch checked={draft.webSearch} onChange={(v) => setDraft({ ...draft, webSearch: v })} label="Web search" />
          </div>
          {(draft.webSearch || searchStatus?.configured) && (
            <div className="rounded-xl border border-line bg-app p-3">
              <p className="mb-2 text-[12.5px] text-muted">
                {searchStatus?.configured ? (
                  <>
                    Tavily key ending in <span className="font-mono">…{searchStatus.hint}</span> is{" "}
                    {searchStatus.source === "env" ? "from .env.local (TAVILY_API_KEY)" : SOURCE_LABEL[searchStatus.source!]}.
                  </>
                ) : (
                  <>
                    Searches go through Tavily. Get a free key (1,000 searches a month, no card) at{" "}
                    <a href="https://app.tavily.com" target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
                      app.tavily.com
                    </a>
                    .
                  </>
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
        </section>

        <DocsSection draft={draft} setDraft={setDraft} />

        <GitHubSection
          draft={draft}
          setDraft={setDraft}
          status={ghStatus}
          setStatus={(st) => {
            setGhStatus(st);
            onSaved(settings, status!, searchStatus!, st);
          }}
        />

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold">Instructions for DeepSeek</h3>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, systemPrompt: defaultSystemPrompt })}
              className="text-xs text-muted hover:text-fg"
            >
              Reset to default
            </button>
          </div>
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            rows={5}
            className="w-full resize-y rounded-lg border border-line bg-app px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-line-strong"
          />
          <p className="mt-1 text-xs text-muted">Sent at the start of every chat, like Claude&apos;s custom instructions.</p>
        </section>

        <section className="space-y-3">
          <h3 className="text-[14px] font-semibold">Files</h3>
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
              className="h-8 w-28 rounded-lg border border-line bg-app px-2 text-right text-[13px] tabular-nums outline-none"
            />
          </div>
        </section>

        <section className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold">Appearance</h3>
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
        </section>

        <section>
          <h3 className="mb-2 text-[14px] font-semibold">Keyboard shortcuts</h3>
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
        </section>
      </div>
    </Modal>
  );
}
