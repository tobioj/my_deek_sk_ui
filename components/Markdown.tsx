"use client";
// Renders assistant replies: GitHub-flavoured Markdown, math, and highlighted code blocks.
// Shell code blocks get a ▶ Run button in chats where the project's Terminal is on.
import clsx from "clsx";
import { Check, Copy, Loader2, MessageSquarePlus, Play, Square, X } from "lucide-react";
import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { commandFromBlock, RUNNABLE_LANGS, type Platform } from "@/lib/commands";
import type { ProcessInfo } from "@/lib/types";
import { Popover } from "./ui";

// Where ▶ Run sends commands. null = no Run buttons (no project Terminal in this chat).
export interface RunTarget {
  chatId: string;
  folders: string[]; // the project's folders linked to this chat (short names)
  platform: Platform;
  ai: string; // the chat's AI ("DeepSeek" or "Claude")
  sendOutput: (command: string, output: string) => void; // put the output in the message box
  onStarted: () => void; // refresh the Running list
}
export const RunContext = createContext<RunTarget | null>(null);
const StreamingContext = createContext(false);

// Models often write math as \( … \) and \[ … \]; remark-math wants $$ … $$.
// Convert them, leaving code blocks and inline code alone. Single dollars stay plain text,
// so prices like "$5 to $10" don't turn into math.
function normalizeMath(src: string): string {
  return src
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$$${m.trim()}$$`),
    )
    .join("");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={className ?? "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"}
      title={label}
      aria-label={label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

type RunState = { id: string | null; status: ProcessInfo["status"] | "starting"; text: string; exitCode?: number | null; error?: string };

const smallButton = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg";

// ▶ Run: runs a code block's command in the project folder and follows its output.
// It doesn't involve the AI at all, so it costs nothing.
function useRunner(target: RunTarget | null, command: string) {
  const [run, setRun] = useState<RunState | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const follow = async (id: string) => {
    let since = 0;
    while (alive.current) {
      try {
        const res = await fetch(`/api/processes/${id}?since=${since}`);
        if (!res.ok) break;
        const d = (await res.json()) as { info: ProcessInfo; text: string; next: number };
        since = d.next;
        setRun((r) => (r ? { ...r, status: d.info.status, text: (r.text + d.text).slice(-200_000), exitCode: d.info.exitCode, error: d.info.error } : r));
        if (!["running", "stopping", "stop_failed"].includes(d.info.status)) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  };

  const start = async (folder: string, confirmed = false): Promise<void> => {
    if (!target) return;
    setRun({ id: null, status: "starting", text: "" });
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: target.chatId, command, folder, confirmed }),
      });
      const d = (await res.json().catch(() => ({}))) as Partial<ProcessInfo> & { error?: string; confirm?: string };
      if (res.status === 409 && d.confirm) {
        if (window.confirm(`${d.confirm}.\n\n${command}\n\nRun it anyway?`)) return start(folder, true);
        return setRun(null);
      }
      if (!res.ok || !d.id) return setRun({ id: null, status: "failed", text: "", error: d.error || "Couldn't run it." });
      setRun({ id: d.id, status: "running", text: "" });
      target.onStarted();
      follow(d.id);
    } catch {
      setRun({ id: null, status: "failed", text: "", error: "Couldn't reach the app." });
    }
  };

  const stop = async () => {
    if (!run?.id) return;
    setRun((r) => (r ? { ...r, status: "stopping" } : r));
    await fetch(`/api/processes/${run.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
    target?.onStarted();
  };

  return { run, start, stop, clear: () => setRun(null) };
}

function RunButton({ target, busy, onRun }: { target: RunTarget; busy: boolean; onRun: (folder: string) => void }) {
  const [pick, setPick] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => (target.folders.length > 1 ? setPick((p) => !p) : onRun(target.folders[0]))}
        className={clsx(smallButton, "disabled:opacity-50")}
        title={`Run it in ${target.folders.length > 1 ? "a project folder" : target.folders[0]} (${target.platform === "mac" ? "sandboxed" : "not sandboxed"}). Costs nothing: ${target.ai} isn't involved.`}
      >
        <Play size={12} /> Run
      </button>
      <Popover open={pick} onClose={() => setPick(false)} className="right-0 top-full mt-1 w-48">
        <div className="px-2.5 py-1 text-[11.5px] text-faint">Run in…</div>
        {target.folders.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              setPick(false);
              onRun(f);
            }}
            className="flex w-full rounded-lg px-2.5 py-1.5 text-left font-mono text-[12.5px] hover:bg-hover"
          >
            {f}
          </button>
        ))}
      </Popover>
    </div>
  );
}

function RunOutput({ run, ai, onStop, onSend, onClose }: { run: RunState; ai: string; onStop: () => void; onSend: () => void; onClose: () => void }) {
  const outRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [run.text]);
  const live = run.status === "starting" || run.status === "running" || run.status === "stopping";
  const bad = run.status === "failed" || run.status === "stop_failed" || run.status === "timed_out";
  const label =
    run.status === "starting"
      ? "Starting…"
      : run.status === "running"
        ? "Running…"
        : run.status === "stopping"
          ? "Stopping…"
          : run.status === "finished"
            ? "Done (exit 0)"
            : run.status === "stopped"
              ? "Stopped"
              : run.status === "stop_failed"
                ? run.error || "Couldn't stop it"
                : run.error && run.exitCode == null
                  ? run.error
                  : `Failed (exit ${run.exitCode ?? "?"})`;
  return (
    <>
      <div className="flex items-center gap-1 border-t border-line px-3 py-1 text-xs">
        {live ? (
          <Loader2 size={12} className="animate-spin text-muted" />
        ) : bad ? (
          <X size={12} className="text-danger" />
        ) : (
          <Check size={12} className="text-green-700 dark:text-green-400" />
        )}
        <span className={clsx("mr-auto truncate", bad ? "text-danger" : "text-muted")}>{label}</span>
        {(run.status === "running" || run.status === "stop_failed") && (
          <button type="button" onClick={onStop} className={smallButton}>
            <Square size={11} /> Stop
          </button>
        )}
        {!live && run.text && (
          <button type="button" onClick={onSend} className={smallButton} title={`Add this output to your message, so you can ask ${ai} about it`}>
            <MessageSquarePlus size={13} /> Send to {ai}
          </button>
        )}
        {!live && (
          <button type="button" onClick={onClose} className={smallButton} aria-label="Hide output">
            <X size={12} />
          </button>
        )}
      </div>
      {(run.text || live) && (
        <pre
          ref={outRef}
          className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-line px-4 py-2 font-mono text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]"
        >
          {run.text || "Waiting for output…"}
        </pre>
      )}
    </>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const target = useContext(RunContext);
  const streaming = useContext(StreamingContext);
  const code = isValidElement(children) ? (children.props as { className?: string; children?: ReactNode }) : null;
  const lang = /language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
  const raw = textOf(code?.children ?? children).replace(/\n$/, "");
  const runnable = !!target && !streaming && target.folders.length > 0 && RUNNABLE_LANGS[target.platform].has(lang.toLowerCase());
  const command = runnable ? commandFromBlock(raw) : "";
  const { run, start, stop, clear } = useRunner(target, command);
  const busy = !!run && (run.status === "starting" || run.status === "running" || run.status === "stopping");
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex items-center justify-between border-b border-line px-3 py-1 text-xs text-muted">
        <span className="font-mono">{lang || "text"}</span>
        <div className="flex items-center gap-0.5">
          {runnable && command && <RunButton target={target!} busy={busy} onRun={(f) => start(f)} />}
          <CopyButton text={raw} />
        </div>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed">{children}</pre>
      {run && <RunOutput run={run} ai={target?.ai ?? "the AI"} onStop={stop} onSend={() => target?.sendOutput(command, run.text)} onClose={clear} />}
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <StreamingContext.Provider value={!!streaming}>
      <div className={streaming ? "prose-chat cursor-blink-last" : "prose-chat"}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }], [rehypeHighlight, { detect: false }]]}
          components={components}
        >
          {normalizeMath(text)}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider>
  );
});
