"use client";
// The Running list: commands DeepSeek or you started, with their real status (checked with the
// system, not guessed). Closing the window doesn't stop them; you stop them here.
import clsx from "clsx";
import { FileText, Loader2, Square, Terminal } from "lucide-react";
import { createContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { ProcessInfo } from "@/lib/types";
import { Button, Popover } from "./ui";

// The Running list as it is right now, so a background command's card in the chat can show its
// real status (it may have been stopped since). loaded = the list has been fetched at least once.
export const ProcsContext = createContext<{ loaded: boolean; byId: Map<string, ProcessInfo> }>({ loaded: false, byId: new Map() });

export const isLive = (p: ProcessInfo) => p.status === "running" || p.status === "stopping" || p.status === "stop_failed";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function statusText(p: ProcessInfo): { text: string; tone: "live" | "ok" | "bad" | "quiet" } {
  switch (p.status) {
    case "running":
      return { text: "Running", tone: "live" };
    case "stopping":
      return { text: "Stopping…", tone: "live" };
    case "stop_failed":
      return { text: p.error || "Couldn't stop it", tone: "bad" };
    case "finished":
      return { text: "Finished", tone: "ok" };
    case "failed":
      return { text: p.exitCode != null ? `Failed (exit ${p.exitCode})` : p.error || "Failed", tone: "bad" };
    case "timed_out":
      return { text: "Hit the time limit", tone: "bad" };
    case "stopped":
      return { text: "Stopped", tone: "quiet" };
  }
}

export function RunningButton({ procs, onChange }: { procs: ProcessInfo[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  if (!procs.length) return null;
  const live = procs.filter(isLive).length;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px]",
          live ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover hover:text-fg",
        )}
        title="Commands started by DeepSeek or with ▶ Run"
      >
        {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : <Terminal size={13} />}
        {live ? `${live} running` : "Commands"}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="right-0 top-full mt-1.5 w-[440px] max-w-[calc(100vw-2rem)]">
        <RunningPanel procs={procs} onChange={onChange} />
      </Popover>
    </div>
  );
}

function RunningPanel({ procs, onChange }: { procs: ProcessInfo[]; onChange: () => void }) {
  const [logFor, setLogFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = procs.filter(isLive);
  const act = async (key: string, url: string, json: unknown) => {
    setBusy(key);
    await api(url, { method: "POST", json }).catch(() => {});
    setBusy(null);
    onChange();
  };
  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1">
        <span className="mr-auto font-medium">Commands</span>
        {procs.length > live.length && (
          <Button variant="ghost" onClick={() => act("clear", "/api/processes", { action: "clear" })}>
            Clear finished
          </Button>
        )}
        {live.length > 1 && (
          <Button variant="secondary" disabled={!!busy} onClick={() => act("all", "/api/processes", { action: "stop_all" })}>
            {busy === "all" ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />} Stop all
          </Button>
        )}
      </div>
      <div className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {procs.map((p) => {
          const st = statusText(p);
          return (
            <div key={p.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    "h-2 w-2 shrink-0 rounded-full",
                    st.tone === "live" ? "animate-pulse bg-accent" : st.tone === "ok" ? "bg-green-600" : st.tone === "bad" ? "bg-danger" : "bg-line-strong",
                  )}
                />
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={p.command}>
                  {p.command}
                </code>
                <button
                  type="button"
                  onClick={() => setLogFor((id) => (id === p.id ? null : p.id))}
                  className={clsx("inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-hover", logFor === p.id ? "text-fg" : "text-muted")}
                >
                  <FileText size={12} /> Log
                </button>
                {isLive(p) && (
                  <Button
                    variant="secondary"
                   
                    disabled={busy === p.id || p.status === "stopping"}
                    onClick={() => act(p.id, `/api/processes/${p.id}`, { action: "stop" })}
                  >
                    {busy === p.id || p.status === "stopping" ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />} Stop
                  </Button>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-4 text-[11.5px] text-faint">
                <span className={clsx(st.tone === "bad" ? "text-danger" : st.tone === "live" ? "text-accent" : "")}>{st.text}</span>
                <span>·</span>
                <span className="truncate" title={p.cwd}>
                  {p.projectName} / {p.folder}
                </span>
                <span>·</span>
                <span>{p.by === "you" ? "you" : "DeepSeek"}</span>
                <span>·</span>
                <span>{ago(p.startedAt)}</span>
                {!p.sandboxed && <span>· not sandboxed</span>}
                {p.ports.map((port) => (
                  <a key={port} href={`http://localhost:${port}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    localhost:{port}
                  </a>
                ))}
              </div>
              {logFor === p.id && <LogView id={p.id} live={isLive(p)} />}
            </div>
          );
        })}
      </div>
      <p className="px-2.5 pb-1 pt-2 text-[11.5px] leading-snug text-faint">
        Closing the window doesn&apos;t stop these. <span className="font-mono">deepseek-chat stop</span> stops them along with the app.
      </p>
    </div>
  );
}

function LogView({ id, live }: { id: string; live: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let since = 0;
    let cancelled = false;
    const tick = async () => {
      try {
        const d = await api<{ text: string; next: number; skipped: boolean }>(`/api/processes/${id}?since=${since}`);
        if (cancelled) return;
        since = d.next;
        if (d.text) setText((t) => (t + d.text).slice(-200_000));
      } catch {}
    };
    tick();
    const t = live ? setInterval(tick, 1000) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [id, live]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted [overflow-wrap:anywhere]"
    >
      {text || "(no output yet)"}
    </pre>
  );
}
