"use client";
// Settings sections for the Docs folder and read-only GitHub access.
import { CheckCircle2, ChevronRight, FileText, FolderOpen, GitBranch, Loader2, Plus, X, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client";
import type { KeyStatus, Settings } from "@/lib/types";
import { Button, Fold, FoldSection } from "./ui";

type Msg = { ok: boolean; text: string } | null;

function Status({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <div className={`mt-2 flex items-center gap-1.5 text-[12.5px] ${msg.ok ? "text-green-600 dark:text-green-400" : "text-danger"}`}>
      {msg.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {msg.text}
    </div>
  );
}

export function DocsSection({ draft, setDraft }: { draft: Settings; setDraft: (s: Settings) => void }) {
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    setBusy(true);
    try {
      const res = await api<{ path?: string }>("/api/folder/pick", { method: "POST" });
      if (res.path) setDraft({ ...draft, docsFolder: res.path });
    } finally {
      setBusy(false);
    }
  };
  return (
    <FoldSection id="settings-docs" title="Docs folder" icon={<FileText size={15} />} summary={draft.docsFolder.trim() || "Off"}>
      <Fold label="How the Docs folder works">
        The AI can create and update documents here in <b>any mode</b>, even Ask and Plan (for example, “save this plan as a doc”). It asks before
        each save and can&apos;t reach anything else through it. Projects can use their own folder. Leave empty to turn this off.
      </Fold>
      <div className="flex gap-2">
        <input
          value={draft.docsFolder}
          onChange={(e) => setDraft({ ...draft, docsFolder: e.target.value })}
          placeholder="Off (no Docs folder)"
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
        />
        <Button onClick={browse} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
          Choose…
        </Button>
      </div>
      {draft.docsAutoSave.length > 0 && (
        <div>
          <div className="mb-1 mt-2 text-xs font-medium text-muted">Docs the AI saves without asking</div>
          <div className="divide-y divide-line rounded-lg border border-line">
            {draft.docsAutoSave.map((p) => (
              <div key={p} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                <FileText size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={p}>
                  {p}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, docsAutoSave: draft.docsAutoSave.filter((x) => x !== p) })}
                  className="rounded p-0.5 text-muted hover:text-fg"
                  aria-label={`Ask again before saving ${p}`}
                  title="Ask again before saving this doc"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </FoldSection>
  );
}

export function GitHubSection({
  draft,
  setDraft,
  status,
  setStatus,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
  status: KeyStatus | null;
  setStatus: (s: KeyStatus) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [visible, setVisible] = useState<string[]>([]); // repos the token can see
  const [manual, setManual] = useState("");
  const [howTo, setHowTo] = useState(!status?.configured);

  const test = async () => {
    setBusy("test");
    setMsg(null);
    const r = await api<{ ok: boolean; error?: string; login?: string; repos?: string[] }>("/api/settings/test?provider=github", {
      method: "POST",
    }).catch((e) => ({ ok: false, error: (e as Error).message }) as { ok: false; error: string; login?: string; repos?: string[] });
    if (r.ok) {
      setVisible(r.repos ?? []);
      setMsg({ ok: true, text: `Connected as ${r.login}. Your token can see ${r.repos?.length ?? 0} repo${r.repos?.length === 1 ? "" : "s"}; tick the ones the AI may read.` });
    } else setMsg({ ok: false, text: r.error ?? "Test failed" });
    setBusy(null);
  };

  const saveToken = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const st = await api<KeyStatus>("/api/settings/key", { method: "POST", json: { key: token, provider: "github" } });
      setStatus(st);
      setToken("");
      await test();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (repo: string) =>
    setDraft({
      ...draft,
      githubRepos: draft.githubRepos.includes(repo) ? draft.githubRepos.filter((r) => r !== repo) : [...draft.githubRepos, repo],
    });

  const addManual = async () => {
    const repo = manual.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return setMsg({ ok: false, text: "Type the repo as owner/name, e.g. octocat/hello-world" });
    setBusy("add");
    const r = await api<{ ok: boolean }>(`/api/settings/test?provider=github&repo=${encodeURIComponent(repo)}`, { method: "POST" }).catch(() => ({ ok: false }));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: `Your token can't see ${repo}. Add it to the token's repository access on GitHub first.` });
    if (!draft.githubRepos.includes(repo)) setDraft({ ...draft, githubRepos: [...draft.githubRepos, repo] });
    setManual("");
    setMsg({ ok: true, text: `${repo} allowed.` });
  };

  const listed = [...new Set([...draft.githubRepos, ...visible])].sort((a, b) => a.localeCompare(b));

  return (
    <FoldSection
      id="settings-github"
      title="GitHub (read-only)"
      icon={<GitBranch size={15} />}
      summary={status?.configured ? `${draft.githubRepos.length} repo${draft.githubRepos.length === 1 ? "" : "s"} allowed` : "Not set up"}
    >
      {status?.configured && (
        <p className="text-[12.5px] text-muted">
          Token ending in <span className="font-mono">…{status.hint}</span>{" "}
          {status.source === "env" ? "comes from .env.local (GITHUB_TOKEN)" : status.source === "settings" ? "is saved in data/settings.json" : status.source === "windows" ? "is saved encrypted with your Windows login" : "is saved in your Keychain"}.
        </p>
      )}
      <Fold label="What the AI can do with it">
        Read code, issues, pull requests, commits and CI results, only in the repos you tick below and only in chats where you turn the{" "}
        <b>GitHub</b> button on. It can&apos;t change anything on GitHub.
      </Fold>

      <button type="button" onClick={() => setHowTo((o) => !o)} className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
        <ChevronRight size={13} className={howTo ? "rotate-90 transition-transform" : "transition-transform"} />
        How to make a safe, limited token
      </button>
      {howTo && (
        <ol className="list-decimal space-y-1 rounded-lg bg-surface-2 py-2.5 pl-8 pr-3 text-[12.5px] leading-relaxed text-muted">
          <li>
            On GitHub: <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</b>.
          </li>
          <li>
            <b>Expiration:</b> 30–90 days.
          </li>
          <li>
            <b>Repository access:</b> <b>Only select repositories</b>, and pick just the ones the AI may read.
          </li>
          <li>
            <b>Permissions → Repository:</b> set <b>Contents</b>, <b>Issues</b>, <b>Pull requests</b> and <b>Actions</b> to <b>Read-only</b>. Leave
            everything else as “No access”.
          </li>
          <li>Generate it, then paste it below. GitHub itself will refuse anything outside these limits.</li>
        </ol>
      )}

      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={status?.configured ? "Paste a new token to replace it" : "github_pat_…"}
          autoComplete="off"
          className="h-9 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[13px] outline-none focus:border-line-strong"
        />
        <Button variant="primary" onClick={saveToken} disabled={!token.trim() || !!busy}>
          {busy === "save" && <Loader2 size={14} className="animate-spin" />}
          Save token
        </Button>
        {status?.configured && (
          <Button onClick={test} disabled={!!busy}>
            {busy === "test" && <Loader2 size={14} className="animate-spin" />}
            {visible.length ? "Refresh" : "Load repos"}
          </Button>
        )}
      </div>
      <Status msg={msg} />

      {status?.configured && (
        <div>
          <div className="mb-1 mt-2 flex items-center justify-between text-xs font-medium text-muted">
            <span>Repos the AI may read ({draft.githubRepos.length} allowed)</span>
          </div>
          {listed.length > 0 ? (
            <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {listed.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13px] hover:bg-hover">
                  <input type="checkbox" checked={draft.githubRepos.includes(r)} onChange={() => toggle(r)} className="accent-[var(--accent)]" />
                  <span className="font-mono text-[12.5px]">{r}</span>
                  {!visible.includes(r) && visible.length > 0 && <span className="text-[11px] text-warn">token can&apos;t see it</span>}
                </label>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-faint">
              Click <b>Load repos</b> to see what your token can access.
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addManual())}
              placeholder="Or add one by name: owner/repo"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
            />
            <Button onClick={addManual} disabled={!manual.trim() || !!busy}>
              {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Allow
            </Button>
          </div>
          <p className="mt-1.5 text-[11.5px] text-faint">Projects pick which of these repos their chats may read, in Project settings.</p>
        </div>
      )}
    </FoldSection>
  );
}
