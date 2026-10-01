"use client";
// Settings for each AI provider: its API key (save, test, remove) and what it may ever do.
import clsx from "clsx";
import { CheckCircle2, KeyRound, Loader2, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client";
import { LIMIT_KEYS, LIMIT_LABELS, PROVIDER_NAME, type Provider, type ProviderLimits } from "@/lib/models";
import type { KeyStatus } from "@/lib/types";
import { Button, Fold, Switch } from "./ui";

const SOURCE: Record<NonNullable<KeyStatus["source"]>, string> = {
  keychain: "saved in your macOS Keychain",
  windows: "saved encrypted with your Windows login",
  env: "from .env.local",
  settings: "saved in data/settings.json",
};

const KEY_INFO: Record<Provider, { secret: string; env: string; where: string; placeholder: string }> = {
  deepseek: { secret: "deepseek", env: "DEEPSEEK_API_KEY", where: "platform.deepseek.com → API keys", placeholder: "sk-…" },
  claude: { secret: "anthropic", env: "ANTHROPIC_API_KEY", where: "console.anthropic.com → API keys (billed per use, separately from a Claude.ai plan)", placeholder: "sk-ant-…" },
};

type Msg = { ok: boolean; text: string } | null;

export function ProviderCard({
  provider,
  status,
  limits,
  onLimits,
  onKeyChanged,
  children,
}: {
  provider: Provider;
  status: KeyStatus | null;
  limits: ProviderLimits;
  onLimits: (l: ProviderLimits) => void;
  onKeyChanged: (s: KeyStatus) => void; // saved or removed: reload what depends on it (the model list)
  children?: React.ReactNode; // provider-specific options
}) {
  const name = PROVIDER_NAME[provider];
  const info = KEY_INFO[provider];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const test = async (): Promise<Msg> => {
    const r = await api<{ ok: boolean; error?: string; models?: string[] }>(`/api/settings/test?provider=${info.secret}`, { method: "POST" }).catch(
      (e) => ({ ok: false, error: (e as Error).message, models: undefined }),
    );
    if (!r.ok) return { ok: false, text: r.error ?? "Test failed." };
    return { ok: true, text: provider === "claude" && r.models ? `Connected. Your key can use ${r.models.length} Claude models.` : `Connected to ${name}.` };
  };

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const s = await api<KeyStatus>("/api/settings/key", { method: "POST", json: { key, provider: info.secret } });
      setKey("");
      const t = await test();
      setMsg(t?.ok ? { ok: true, text: `Saved. ${t.text}` } : { ok: false, text: `Saved, but the test failed: ${t?.text}` });
      onKeyChanged(s);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setMsg(await test());
    setBusy(null);
  };

  const remove = async () => {
    if (!window.confirm(`Remove your ${name} API key from this computer?\n\nChats that use ${name} won't work until you add a key again. Your chats are kept.`)) return;
    setBusy("remove");
    setMsg(null);
    try {
      const s = await api<KeyStatus>(`/api/settings/key?provider=${info.secret}`, { method: "DELETE" });
      setMsg(s.configured ? { ok: false, text: `The key is still set: it comes from .env.local (${info.env}). Remove it there.` } : { ok: true, text: "Key removed." });
      onKeyChanged(s);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const keys = LIMIT_KEYS.filter((k) => provider === "claude" || k !== "code");
  const set = (k: keyof ProviderLimits, v: boolean) => {
    const next = { ...limits, [k]: v };
    // Auto mode is a kind of changing files: it needs Change files, and turning that off turns Auto off.
    if (k === "auto" && v) next.edit = true;
    if (k === "edit" && !v) next.auto = false;
    onLimits(next);
  };

  return (
    <div className="rounded-xl border border-line bg-app p-3.5">
      <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
        <KeyRound size={15} /> {name}
      </div>
      <p className="text-[12.5px] text-muted">
        {status?.configured ? (
          <>
            Key ending in <span className="font-mono">…{status.hint}</span>, {status.source === "env" ? `from .env.local (${info.env})` : SOURCE[status.source!]}.
          </>
        ) : (
          <>No key yet.</>
        )}
      </p>
      <Fold label="About this key" className="mb-2.5">
        Get one at {info.where}. It&apos;s stored securely on this computer (the macOS Keychain, or encrypted with your Windows login) and is
        never sent to the browser. Remove deletes it from this computer; your chats are kept.
      </Fold>
      <div className="flex flex-wrap gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={status?.configured ? "Paste a new key to replace it" : info.placeholder}
          autoComplete="off"
          aria-label={`${name} API key`}
          className="h-9 min-w-40 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] outline-none focus:border-line-strong"
        />
        <Button variant="primary" onClick={save} disabled={!key.trim() || !!busy}>
          {busy === "save" && <Loader2 size={14} className="animate-spin" />}
          Save key
        </Button>
        {status?.configured && (
          <Button onClick={runTest} disabled={!!busy}>
            {busy === "test" && <Loader2 size={14} className="animate-spin" />}
            Test
          </Button>
        )}
        {status?.configured && status.source !== "env" && (
          <Button variant="ghost" onClick={remove} disabled={!!busy}>
            {busy === "remove" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Remove
          </Button>
        )}
      </div>
      {msg && (
        <div className={clsx("mt-2 flex items-center gap-1.5 text-[12.5px]", msg.ok ? "text-green-600 dark:text-green-400" : "text-danger")}>
          {msg.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {msg.text}
        </div>
      )}

      <div className="mt-3.5 text-[12.5px] font-medium">What {name} may do</div>
      <Fold label="How these switches work" className="mb-1.5">
        They apply everywhere, on top of each project&apos;s and chat&apos;s own switches. Off means off, whatever a project or chat says: the
        matching buttons in the chat are greyed out, and the app refuses it even if {name} asks.
      </Fold>
      <div className="grid gap-y-1.5">
        {keys.map((k) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px]">{LIMIT_LABELS[k].label}</div>
              <div className="truncate text-[11.5px] text-faint" title={LIMIT_LABELS[k].hint}>
                {LIMIT_LABELS[k].hint}
              </div>
            </div>
            <Switch checked={limits[k]} onChange={(v) => set(k, v)} label={`${name}: ${LIMIT_LABELS[k].label}`} />
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
