"use client";
import clsx from "clsx";
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCheck,
  Download,
  ChevronRight,
  FilePen,
  FilePlus2,
  Undo2,
  Zap,
  FileSearch,
  FileText,
  FolderTree,
  CircleDot,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  PlayCircle,
  Link2,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/client";
import { formatCost, formatTokens } from "@/lib/tokens";
import { MODELS, type AssistantMessage, type AssistantStep, type Attachment, type CommandRun, type ProcessInfo, type ToolCall, type UserMessage } from "@/lib/types";
import { DiffView } from "./DiffView";
import { CopyButton, Markdown } from "./Markdown";
import { ProcsContext } from "./RunningList";
import { Button, MenuItem, Popover } from "./ui";

export function AttachmentChip({
  a,
  onRemove,
  loading,
  error,
}: {
  a: Attachment;
  onRemove?: () => void;
  loading?: boolean;
  error?: string;
}) {
  const src = a.dataUrl ?? (a.upload ? `/api/uploads/${a.upload}` : null);
  if (a.kind === "image" && src && !error) {
    return (
      <div className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2" title={a.name}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={a.name} className="h-full w-full object-cover" />
        {onRemove && <RemoveButton onClick={onRemove} />}
      </div>
    );
  }
  const Icon = a.kind === "image" ? ImageIcon : FileText;
  return (
    <div
      className={clsx(
        "group relative flex h-12 max-w-60 shrink-0 items-center gap-2.5 rounded-xl border px-2.5",
        error ? "border-danger/40 bg-danger-soft" : "border-line bg-surface",
      )}
      title={error ?? a.name}
    >
      <div className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", error ? "text-danger" : "bg-accent-soft text-accent")}>
        {loading ? <Loader2 size={15} className="animate-spin" /> : error ? <AlertTriangle size={15} /> : <Icon size={15} />}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium">{a.name.split("/").pop()}</div>
        <div className="truncate text-[11px] text-muted">
          {error
            ? error
            : loading
              ? "Reading…"
              : a.kind === "image"
                ? formatBytes(a.size)
                : `${formatTokens(Math.ceil(a.size / 4))} tokens${a.truncated ? " · cut off" : ""}${a.name.includes("/") ? ` · ${a.name.split("/").slice(0, -1).join("/")}` : ""}`}
        </div>
      </div>
      {onRemove && <RemoveButton onClick={onRemove} />}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove attachment"
      className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm hover:text-fg group-hover:flex"
    >
      <X size={11} />
    </button>
  );
}

export const UserBubble = memo(function UserBubble({
  message,
  onEdit,
  canEdit,
}: {
  message: UserMessage;
  onEdit: (text: string) => void;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.style.height = "auto";
      ref.current.style.height = ref.current.scrollHeight + "px";
    }
  }, [editing]);

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.attachments.map((a) => (
            <AttachmentChip key={a.id} a={a} />
          ))}
        </div>
      )}
      {editing ? (
        <div className="w-full max-w-[85%] rounded-2xl border border-line-strong bg-surface p-3">
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = e.target.scrollHeight + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (draft.trim()) {
                  setEditing(false);
                  onEdit(draft);
                }
              }
              if (e.key === "Escape") setEditing(false);
            }}
            className="max-h-[50vh] w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                onEdit(draft);
              }}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        message.text && (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere]">
            {message.text}
          </div>
        )
      )}
      {!editing && (
        <div className="flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.text} />
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
            >
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const expanded = open || active;
  useEffect(() => {
    if (active && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, active]);
  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 text-[13px] text-muted hover:text-fg"
      >
        <Brain size={14} />
        <span className={active ? "shimmer-text" : ""}>{active ? "Thinking…" : "Thought process"}</span>
        <ChevronRight size={14} className={clsx("transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <div
          ref={ref}
          className={clsx(
            "mt-1 whitespace-pre-wrap border-l-2 border-line pl-3.5 text-[13.5px] leading-relaxed text-muted",
            active && "max-h-56 overflow-y-auto",
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof FileText> = {
  list_directory: FolderTree,
  read_file: FileText,
  search_files: Search,
  find_files: FileSearch,
  web_search: Globe,
  read_webpage: Link2,
  list_documents: FolderTree,
  read_document: FileText,
  github_list_repos: GitBranch,
  github_browse: GitBranch,
  github_search_code: Search,
  github_issues: CircleDot,
  github_pull_requests: GitPullRequest,
  github_commits: GitCommitHorizontal,
  github_ci_runs: PlayCircle,
  check_command: Terminal,
  stop_command: Square,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "page";
  }
}

function pendingLabel(call: ToolCall): string {
  let args: Record<string, string> = {};
  try {
    args = JSON.parse(call.args || "{}");
  } catch {}
  switch (call.name) {
    case "list_directory":
      return `Listing ${args.path && args.path !== "." ? args.path : "project"}…`;
    case "read_file":
      return `Reading ${args.path ?? "file"}…`;
    case "search_files":
      return `Searching for "${args.pattern ?? ""}"…`;
    case "find_files":
      return `Finding ${args.pattern ?? "files"}…`;
    case "web_search":
      return `Searching the web for "${args.query ?? ""}"…`;
    case "read_webpage":
      return `Reading ${hostOf(args.url ?? "")}…`;
    case "list_documents":
      return "Looking at your docs…";
    case "read_document":
      return `Reading doc ${args.path ?? ""}…`;
    case "github_list_repos":
      return "Checking your allowed GitHub repos…";
    case "github_browse":
      return `Reading ${args.repo ?? "repo"}/${args.path ?? ""}…`;
    case "github_search_code":
      return `Searching ${args.repo ?? "repo"} for "${args.query ?? ""}"…`;
    case "github_issues":
      return args.number ? `Reading issue #${args.number} in ${args.repo}…` : `Listing issues in ${args.repo ?? "repo"}…`;
    case "github_pull_requests":
      return args.number ? `Reading PR #${args.number} in ${args.repo}…` : `Listing pull requests in ${args.repo ?? "repo"}…`;
    case "github_commits":
      return `Reading commits in ${args.repo ?? "repo"}…`;
    case "github_ci_runs":
      return `Checking CI for ${args.repo ?? "repo"}…`;
    case "check_command":
      return args.id ? `Checking ${args.id}…` : "Checking running commands…";
    case "stop_command":
      return `Stopping ${args.id ?? "command"}…`;
    default:
      return `${call.name}…`;
  }
}

function ToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[call.name] ?? FileText;
  const done = call.summary !== undefined;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => done && setOpen((o) => !o)}
        className={clsx(
          "inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12.5px] hover:bg-hover",
          call.ok === false ? "text-danger" : "text-muted",
        )}
      >
        {done ? <Icon size={13} className="shrink-0" /> : <Loader2 size={13} className="shrink-0 animate-spin" />}
        <span className="truncate">{done ? call.summary : pendingLabel(call)}</span>
        {done && call.result && <ChevronRight size={13} className={clsx("shrink-0 transition-transform", open && "rotate-90")} />}
      </button>
      {open && call.sources?.length ? (
        <div className="mt-1.5 max-w-xl space-y-0.5 rounded-lg border border-line bg-surface p-1.5">
          {call.sources.map((src, i) => (
            <a
              key={src.url + i}
              href={src.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-baseline gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-hover"
            >
              <span className="truncate text-fg">{src.title}</span>
              <span className="shrink-0 text-[11.5px] text-faint">{hostOf(src.url)}</span>
            </a>
          ))}
        </div>
      ) : open && call.result && (
        <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-line bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
          {call.result.length > 20000 ? call.result.slice(0, 20000) + "\n…" : call.result}
        </pre>
      )}
    </div>
  );
}

const EDIT_TOOLS = new Set(["edit_file", "write_file", "delete_file", "save_document"]);
// command: the command as you edited it (commands only).
export type Decide = (callId: string, decision: "approve" | "reject" | "approve_remember", command?: string) => void;

const KIND_UI = {
  create: { icon: FilePlus2, label: "New file" },
  edit: { icon: FilePen, label: "Edit" },
  overwrite: { icon: FilePen, label: "Rewrite" },
  delete: { icon: Trash2, label: "Delete" },
} as const;

// A proposed or applied file change, with its before/after preview.
function EditCard({ call, onDecide }: { call: ToolCall; onDecide?: Decide }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<"approve" | "reject" | null>(null);
  const [remember, setRemember] = useState(false);
  const d = call.diff;
  let path = "";
  try {
    path = JSON.parse(call.args || "{}").path ?? "";
  } catch {}
  if (!d) {
    const failed = call.summary !== undefined;
    return (
      <div className={clsx("my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12.5px]", failed ? "text-danger" : "text-muted")}>
        {failed ? <AlertTriangle size={13} className="shrink-0" /> : <Loader2 size={13} className="shrink-0 animate-spin" />}
        <span className="truncate">{failed ? call.summary : `Preparing a change to ${path || "a file"}…`}</span>
      </div>
    );
  }
  const pending = call.status === "pending";
  const { icon: Icon, label: kindLabel } = KIND_UI[d.kind];
  const label = d.doc ? (d.kind === "create" ? "Save new doc" : "Update doc") : kindLabel;
  const expanded = pending || open;
  return (
    <div className={clsx("my-2 overflow-hidden rounded-xl border bg-surface", pending ? "border-accent/50 shadow-sm" : "border-line")}>
      <button
        type="button"
        onClick={() => !pending && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-hover"
      >
        <Icon size={14} className={d.kind === "delete" ? "text-danger" : "text-accent"} />
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-muted">{d.path}</span>
        <span className="shrink-0 font-mono text-[11.5px]">
          {d.added > 0 && <span className="text-green-700 dark:text-green-400">+{d.added}</span>}
          {d.removed > 0 && <span className="ml-1 text-red-700 dark:text-red-400">−{d.removed}</span>}
        </span>
        <span className="flex-1" />
        {call.status === "applied" && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-green-700 dark:text-green-400">
            <Check size={12} /> Applied
          </span>
        )}
        {call.status === "rejected" && <span className="shrink-0 text-[11.5px] text-faint">Rejected</span>}
        {call.ok === false && !call.status && <span className="shrink-0 truncate text-[11.5px] text-danger">{call.summary}</span>}
        {!pending && <ChevronRight size={13} className={clsx("shrink-0 text-muted transition-transform", open && "rotate-90")} />}
      </button>
      {expanded && (
        <div className="border-t border-line">
          <DiffView diff={d} />
        </div>
      )}
      {pending && onDecide && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-app px-3 py-2">
          <span className="mr-auto text-[12px] text-muted">
            {sent ? "Sending…" : d.doc ? "DeepSeek wants to save this to your Docs folder" : "DeepSeek wants to make this change"}
          </span>
          {d.doc && !sent && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted" title="Future saves to this doc won't ask. You can undo this in Settings → Docs folder.">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--accent)]" />
              Don&apos;t ask again for this doc
            </label>
          )}
          <Button
            variant="secondary"
            disabled={!!sent}
            onClick={() => {
              setSent("reject");
              onDecide(call.id, "reject");
            }}
          >
            <X size={13} /> Reject
          </Button>
          <Button
            variant="primary"
            disabled={!!sent}
            onClick={() => {
              setSent("approve");
              onDecide(call.id, d.doc && remember ? "approve_remember" : "approve");
            }}
          >
            <Check size={13} /> Approve
          </Button>
        </div>
      )}
    </div>
  );
}

const took = (ms: number) => (ms < 1000 ? "<1s" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function CommandStatusBadge({ r, elapsed, live }: { r: CommandRun; elapsed: number; live?: ProcessInfo | null }) {
  const base = "inline-flex shrink-0 items-center gap-1 text-[11.5px]";
  // A background command: show what it's doing now, from the Running list (null = not in it any more).
  if (r.background && r.status === "running" && live !== undefined) {
    if (!live) return <span className={clsx(base, "text-faint")}>No longer running</span>;
    if (live.status === "running" || live.status === "stopping")
      return (
        <span className={clsx(base, "text-muted")}>
          <Loader2 size={12} className="animate-spin" /> {live.status === "stopping" ? "Stopping…" : "Running in the background"}
          {live.ports.length > 0 && ` · localhost:${live.ports.join(", ")}`}
        </span>
      );
    if (live.status === "stop_failed") return <span className={clsx(base, "text-danger")}>{live.error || "Couldn't stop it"}</span>;
    if (live.status === "stopped") return <span className={clsx(base, "text-faint")}>Stopped</span>;
    if (live.status === "finished") return <span className={clsx(base, "text-green-700 dark:text-green-400")}>Finished</span>;
    return <span className={clsx(base, "text-danger")}>{live.status === "timed_out" ? "Hit the time limit" : `Ended (exit ${live.exitCode ?? "?"})`}</span>;
  }
  switch (r.status) {
    case "pending":
      return <span className={clsx(base, "text-accent")}>Waiting for you</span>;
    case "running":
      return (
        <span className={clsx(base, "text-muted")}>
          <Loader2 size={12} className="animate-spin" /> {r.background ? "Running in the background" : `Running ${took(elapsed)}`}
        </span>
      );
    case "finished":
      return (
        <span className={clsx(base, "text-green-700 dark:text-green-400")}>
          <Check size={12} /> Done{r.durationMs != null ? ` · ${took(r.durationMs)}` : ""}
        </span>
      );
    case "failed":
      return <span className={clsx(base, "text-danger")}>Failed{r.exitCode != null ? ` (exit ${r.exitCode})` : ""}</span>;
    case "timed_out":
      return <span className={clsx(base, "text-danger")}>Hit the time limit</span>;
    case "stopped":
      return <span className={clsx(base, "text-faint")}>Stopped</span>;
    case "denied":
      return <span className={clsx(base, "text-faint")}>Not run</span>;
    case "blocked":
      return <span className={clsx(base, "text-danger")}>Blocked</span>;
  }
}

// A command DeepSeek wants to run (or ran): approve it, edit it first, always allow it, or stop it.
function CommandCard({ call, onDecide }: { call: ToolCall; onDecide?: Decide }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [stopping, setStopping] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const outRef = useRef<HTMLPreElement>(null);
  let fallback = "";
  try {
    fallback = JSON.parse(call.args || "{}").command ?? "";
  } catch {}
  const r: CommandRun = call.command ?? { command: fallback, folder: "", status: "pending", level: "ask", sandboxed: true, readOnly: false, internet: false };
  const procs = useContext(ProcsContext);
  const live = r.background && r.procId && procs.loaded ? (procs.byId.get(r.procId) ?? null) : undefined;
  const pending = call.status === "pending" && r.status === "pending";
  const running = r.status === "running" && !r.background;
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (running && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [r.output, running]);
  const expanded = pending || running || open;
  const where = [
    r.folder && `in ${r.folder}`,
    r.sandboxed ? `sandboxed${r.readOnly ? ", look only" : ""}` : "not sandboxed (Windows)",
    r.sandboxed ? `internet ${r.internet ? "on" : "off"}` : "",
    r.background ? "background" : "",
  ].filter(Boolean);
  const decide = (d: "approve" | "reject" | "approve_remember") => {
    setSent(true);
    onDecide?.(call.id, d, editing && draft.trim() && draft.trim() !== r.command ? draft.trim() : undefined);
  };
  return (
    <div className={clsx("my-2 overflow-hidden rounded-xl border bg-surface", pending ? "border-accent/50 shadow-sm" : "border-line")}>
      <button
        type="button"
        onClick={() => !pending && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-hover"
      >
        <Terminal size={14} className={r.level === "always_ask" || r.status === "blocked" ? "shrink-0 text-warn" : "shrink-0 text-accent"} />
        <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.command || "…"}</code>
        <CommandStatusBadge r={r} elapsed={elapsed} live={live} />
        {!pending && <ChevronRight size={13} className={clsx("shrink-0 text-muted transition-transform", open && "rotate-90")} />}
      </button>
      {expanded && (
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center gap-x-2 px-3 pt-1.5 text-[11.5px] text-faint">
            {where.join(" · ")}
            {r.edited && <span>· you edited it</span>}
          </div>
          {r.reason && (r.level === "always_ask" || r.status === "blocked") && (
            <div className={clsx("mx-3 mt-1.5 flex items-start gap-1.5 text-[12px]", r.status === "blocked" ? "text-danger" : "text-warn")}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {r.status === "blocked" ? r.reason : `Always asks: ${r.reason}`}
            </div>
          )}
          {pending && editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              className="mx-3 mt-2 block w-[calc(100%-1.5rem)] resize-y rounded-lg border border-line bg-code px-3 py-2 font-mono text-[12.5px] outline-none focus:border-line-strong"
            />
          ) : (
            pending && <pre className="mx-3 mt-2 whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.command}</pre>
          )}
          {!pending && r.status !== "blocked" && r.status !== "denied" && (
            <pre
              ref={outRef}
              className="mx-3 my-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]"
            >
              {r.output || (r.status === "running" ? "Waiting for output…" : "(no output)")}
            </pre>
          )}
          {pending && <div className="px-3 pt-1.5 text-[11.5px] text-faint">What a command changes can&apos;t be undone with Undo.</div>}
        </div>
      )}
      {pending && onDecide && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-app px-3 py-2">
          <span className="mr-auto text-[12px] text-muted">{sent ? "Sending…" : "DeepSeek wants to run this command"}</span>
          {!sent && !editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(r.command);
                setEditing(true);
              }}
            >
              <Pencil size={13} /> Edit
            </Button>
          )}
          {!sent && !editing && r.rule && r.level === "ask" && (
            <Button variant="ghost" onClick={() => decide("approve_remember")}>
              <span title={`Commands starting with "${r.rule}" will run without asking in this project (Edit and Auto mode). Remove it in Project settings → Terminal.`}>
                Always allow <code className="font-mono text-[12px]">{r.rule.length > 28 ? r.rule.slice(0, 28) + "…" : r.rule}</code>
              </span>
            </Button>
          )}
          <Button variant="secondary" disabled={sent} onClick={() => decide("reject")}>
            <X size={13} /> Don&apos;t run
          </Button>
          <Button variant="primary" disabled={sent || (editing && !draft.trim())} onClick={() => decide("approve")}>
            <PlayCircle size={13} /> Run
          </Button>
        </div>
      )}
      {running && r.procId && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-app px-3 py-1.5">
          <span className="mr-auto text-[11.5px] text-faint">You can stop it any time; DeepSeek sees the output so far.</span>
          <Button
            variant="secondary"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              await api(`/api/processes/${r.procId}`, { method: "POST", json: { action: "stop" } }).catch(() => {});
            }}
          >
            {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />} Stop
          </Button>
        </div>
      )}
    </div>
  );
}

function Step({ step, active, streaming, onDecide }: { step: AssistantStep; active: boolean; streaming: boolean; onDecide?: Decide }) {
  return (
    <>
      {step.reasoning && <Thinking text={step.reasoning} active={active && !step.content && !step.toolCalls?.length} />}
      {step.content && <Markdown text={step.content} streaming={streaming && active && !step.toolCalls?.length} />}
      {step.toolCalls?.map((c) =>
        EDIT_TOOLS.has(c.name) ? (
          <EditCard key={c.id} call={c} onDecide={onDecide} />
        ) : c.name === "run_command" ? (
          <CommandCard key={c.id} call={c} onDecide={onDecide} />
        ) : (
          <ToolCard key={c.id} call={c} />
        ),
      )}
    </>
  );
}

export const AssistantBlock = memo(function AssistantBlock({
  message,
  streaming,
  isLast,
  onRegenerate,
  onOpenSettings,
  onDecide,
  onApproveAll,
  onUndo,
  onSave,
}: {
  message: AssistantMessage;
  streaming: boolean;
  isLast: boolean;
  onRegenerate: () => void;
  onOpenSettings: () => void;
  onDecide?: Decide;
  onApproveAll?: () => void;
  onUndo?: () => void;
  onSave?: (mode: "new" | "append") => void;
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const text = message.steps.map((s) => s.content).filter(Boolean).join("\n\n");
  const pendingCalls = message.steps.flatMap((s) => s.toolCalls ?? []).filter((c) => c.status === "pending");
  // "Switch to Auto" grants code-editing rights, so only offer it when code changes are waiting
  // (not just doc saves or commands).
  const offerAuto = !!onApproveAll && pendingCalls.some((c) => c.diff && !c.diff.doc);
  const waitingLabel = pendingCalls.every((c) => c.name === "run_command") ? "commands" : pendingCalls.some((c) => c.name === "run_command") ? "requests" : "changes";
  const changedFiles = new Set(message.changes?.map((c) => c.path) ?? []).size;
  const nothingYet = message.steps.every((s) => !s.content && !s.reasoning && !s.toolCalls?.length);
  const keyProblem = message.error && /api key|Settings/i.test(message.error);
  return (
    <div className="group">
      {streaming && nothingYet && (
        <div className="flex h-7 items-center gap-1.5 text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        </div>
      )}
      {message.steps.map((s, i) => (
        <Step key={i} step={s} active={streaming && i === message.steps.length - 1} streaming={streaming} onDecide={onDecide} />
      ))}
      {pendingCalls.length > 1 && onDecide && (
        <div className="my-2 flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[12.5px] text-accent">
          <span className="mr-auto font-medium">
            {pendingCalls.length} {waitingLabel} are waiting for you
          </span>
          <Button variant="secondary" onClick={() => pendingCalls.forEach((c) => onDecide(c.id, "approve"))}>
            <CheckCheck size={13} /> {waitingLabel === "commands" ? "Run all" : "Approve all"}
          </Button>
          {offerAuto && (
            <Button variant="ghost" onClick={onApproveAll}>
              <Zap size={13} /> Switch to Auto
            </Button>
          )}
        </div>
      )}
      {pendingCalls.length === 1 && offerAuto && (
        <button type="button" onClick={onApproveAll} className="mb-1 text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline">
          Approve this and switch to Auto (no more asking in this chat)
        </button>
      )}
      {message.stopped && <div className="mt-2 text-xs text-faint">Stopped</div>}
      {message.error && (
        <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13.5px] text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">{message.error}</div>
          <div className="flex shrink-0 gap-1.5">
            {keyProblem && (
              <Button variant="secondary" onClick={onOpenSettings}>
                <SettingsIcon size={13} /> Settings
              </Button>
            )}
            {isLast && (
              <Button variant="secondary" onClick={onRegenerate}>
                <RotateCcw size={13} /> Retry
              </Button>
            )}
          </div>
        </div>
      )}
      {!streaming && (text || message.usage || changedFiles > 0) && (
        <div
          className={clsx(
            "mt-1.5 flex h-6 items-center gap-0.5 transition-opacity",
            isLast || (changedFiles > 0 && !message.undone) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {text && <CopyButton text={text} />}
          {text && onSave && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setSaveOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
                title="Save this reply to a file"
              >
                <Download size={13} /> Save
              </button>
              <Popover open={saveOpen} onClose={() => setSaveOpen(false)} className="bottom-full left-0 mb-1 w-56">
                <MenuItem
                  icon={<FilePlus2 size={14} />}
                  onClick={() => {
                    setSaveOpen(false);
                    onSave("new");
                  }}
                >
                  Save as new file…
                </MenuItem>
                <MenuItem
                  icon={<FilePen size={14} />}
                  onClick={() => {
                    setSaveOpen(false);
                    onSave("append");
                  }}
                >
                  Add to end of a file…
                </MenuItem>
              </Popover>
            </div>
          )}
          {changedFiles > 0 &&
            (message.undone ? (
              <span className="inline-flex items-center gap-1 px-1.5 text-xs text-faint">
                <Undo2 size={13} /> Changes undone
              </span>
            ) : (
              onUndo && (
                <button
                  type="button"
                  onClick={onUndo}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
                  title="Put every file this reply changed back the way it was"
                >
                  <Undo2 size={13} /> Undo changes ({changedFiles} file{changedFiles === 1 ? "" : "s"})
                </button>
              )
            ))}
          {isLast && !message.error && (
            <button
              type="button"
              onClick={onRegenerate}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
            >
              <RotateCcw size={13} /> Retry
            </button>
          )}
          <span className="ml-2 text-[11.5px] text-faint">
            {MODELS[message.model]?.label ?? message.model}
            {message.usage && message.usage.completionTokens > 0 && (
              <>
                {" · "}
                {formatTokens(message.usage.completionTokens)} tokens out · {formatCost(message.usage.cost)}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
});
