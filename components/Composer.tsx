"use client";
// The message box: typing, attachments, @-mentions, model picker, token meter, send/stop.
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Layers,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { api, estimateAttachmentTokens, type DraftAttachment } from "@/lib/client";
import { costOf, formatCost, formatTokens, isPeak } from "@/lib/tokens";
import { CONTEXT_LIMIT, isEditingMode, MODELS, MODES, type Effort, type Mode, type ModelId } from "@/lib/types";
import type { LinkedFolder } from "@/lib/folders";
import { AttachmentChip } from "./Message";

interface Suggestion {
  folder: string; // absolute folder path
  rel: string; // path inside that folder
  label: string; // what's inserted after @ (prefixed with the folder name when there are several)
}
import { MenuItem, Popover, Segmented, Switch } from "./ui";

const PASTE_AS_FILE_CHARS = 4000;

export interface ComposerProps {
  text: string;
  setText: (t: string) => void;
  attachments: DraftAttachment[];
  setAttachments: (fn: (prev: DraftAttachment[]) => DraftAttachment[]) => void;
  onAddFiles: (files: File[]) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  model: ModelId;
  thinking: boolean;
  effort: Effort;
  onPrefs: (p: Partial<{ model: ModelId; thinking: boolean; effort: Effort; webSearch: boolean; github: boolean; mode: Mode }>) => void;
  mode: Mode; // Ask / Plan / Edit / Auto for the project folder
  gitChanged: number; // uncommitted changes in the project folder (0 if none / not a repo)
  clash?: { title: string; folder: string } | null; // another chat is changing the same folder right now
  webSearch: boolean; // this chat's Search toggle
  github: boolean; // this chat's GitHub toggle
  githubState: "hidden" | "ready" | "no-repos";
  onGithubSetup: () => void;
  searchEnabled: boolean; // web search flag in Settings — hides the toggle when off
  folders: LinkedFolder[]; // project + chat folders (hidden = project folder switched off here)
  onOpenFolder: () => void;
  onRemoveFolder: (path: string) => void; // remove a chat folder
  onToggleProjectFolder: (path: string) => void; // switch a project folder off/on for this chat
  contextTokens: number;
  chatCost: number;
  placeholder?: string;
  focusKey?: string;
}

export function Composer(p: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(0);

  // Focus the box when switching chats.
  useEffect(() => {
    ref.current?.focus();
  }, [p.focusKey]);

  // Grow with content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [p.text]);

  const active = p.folders.filter((f) => !f.hidden);
  const hasFolders = active.length > 0;
  const activeKey = active.map((f) => f.path).join("|");

  // Fetch @-mention suggestions from every open folder.
  useEffect(() => {
    if (!mention || !activeKey) return;
    const folders = p.folders.filter((f) => !f.hidden);
    const t = setTimeout(async () => {
      try {
        const lists = await Promise.all(
          folders.map((f) =>
            api<string[]>(`/api/folder/suggest?root=${encodeURIComponent(f.path)}&q=${encodeURIComponent(mention.query)}`).catch(() => []),
          ),
        );
        const merged: Suggestion[] = [];
        // Interleave so one big folder doesn't crowd out the others.
        for (let i = 0; merged.length < 30 && lists.some((l) => l[i]); i++) {
          lists.forEach((l, fi) => {
            if (l[i] && merged.length < 30) {
              const f = folders[fi];
              merged.push({ folder: f.path, rel: l[i], label: folders.length > 1 ? `${f.name}/${l[i]}` : l[i] });
            }
          });
        }
        setSuggestions(merged);
        setSelected(0);
      } catch {
        setSuggestions([]);
      }
    }, 100);
    return () => clearTimeout(t);
  }, [mention, activeKey, p.folders]);

  const updateMention = (value: string, caret: number) => {
    if (!hasFolders) return setMention(null);
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMention(m ? { query: m[2], start: caret - m[2].length - 1 } : null);
  };

  const pickMention = async (s: Suggestion) => {
    if (!mention) return;
    const path = s.label;
    const caret = mention.start + 1 + mention.query.length;
    const next = p.text.slice(0, mention.start) + `@${path} ` + p.text.slice(caret);
    p.setText(next);
    setMention(null);
    setSuggestions([]);
    requestAnimationFrame(() => {
      const pos = mention.start + path.length + 2;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
    const id = nanoid(10);
    p.setAttachments((prev) =>
      prev.some((a) => a.name === path) ? prev : [...prev, { id, name: path, kind: "file", size: 0, status: "loading" }],
    );
    try {
      const { files } = await api<{ files: { path: string; content: string; truncated: boolean; error?: string }[] }>("/api/folder/read", {
        method: "POST",
        json: { root: s.folder, paths: [s.rel] },
      });
      const f = files[0];
      p.setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? f.error
              ? { ...a, status: "error", error: f.error }
              : { ...a, status: "ready", content: f.content, size: f.content.length, truncated: f.truncated }
            : a,
        ),
      );
    } catch (e) {
      p.setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error", error: (e as Error).message } : a)));
    }
  };

  const editing = hasFolders && isEditingMode(p.mode);
  const ready = p.attachments.every((a) => a.status !== "loading");
  // You can send while DeepSeek is replying too: the message waits for its next step.
  const canSend = ready && (p.text.trim().length > 0 || p.attachments.some((a) => a.status === "ready"));

  const draftTokens =
    Math.ceil(p.text.length / 4) + p.attachments.filter((a) => a.status === "ready").reduce((n, a) => n + estimateAttachmentTokens(a), 0);
  const total = p.contextTokens + draftTokens;
  const pct = total / CONTEXT_LIMIT;
  const nextCost = costOf(p.model, { cacheHitTokens: p.contextTokens, cacheMissTokens: draftTokens, completionTokens: 0 });

  return (
    <div className="w-full">
      {pct > 0.8 && (
        <div className={clsx("mb-2 rounded-xl px-3.5 py-2 text-[13px]", pct > 0.95 ? "bg-danger-soft text-danger" : "bg-surface-2 text-warn")}>
          {pct > 1
            ? `This message would exceed DeepSeek's ${formatTokens(CONTEXT_LIMIT)}-token limit. Remove attachments or start a new chat.`
            : `This chat is at ${Math.round(pct * 100)}% of DeepSeek's limit. Consider starting a new chat soon.`}
        </div>
      )}
      <div
        className={clsx(
          "relative rounded-2xl border bg-surface shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-colors",
          editing ? "border-warn/40 focus-within:border-warn/70" : "border-line focus-within:border-line-strong",
        )}
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.focus();
        }}
      >
        {/* @-mention suggestions */}
        {mention && suggestions.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl">
            {suggestions.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(s);
                }}
                onMouseEnter={() => setSelected(i)}
                className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]", i === selected && "bg-hover")}
              >
                <FileText size={13} className="shrink-0 text-muted" />
                <span className="font-medium">{s.label.split("/").pop()}</span>
                <span className="truncate text-xs text-faint">{s.label.split("/").slice(0, -1).join("/")}</span>
              </button>
            ))}
          </div>
        )}

        {p.folders.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {p.folders.map((f) => (
              <div
                key={f.path}
                className={clsx(
                  "flex h-8 items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 text-[12.5px]",
                  f.hidden ? "border border-dashed border-line text-faint" : editing ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent",
                )}
                title={
                  f.hidden
                    ? `${f.path}\nProject folder, switched off for this chat`
                    : `${f.path}\n${f.source === "project" ? "Project folder (linked to every chat in the project)" : "Added to this chat"}`
                }
              >
                {f.source === "project" ? <Layers size={13} className="shrink-0" /> : <FolderOpen size={14} className="shrink-0" />}
                <span className={clsx("max-w-44 truncate font-medium", f.hidden && "line-through")}>{f.name}</span>
                {f.hidden && <span className="text-[11px] font-medium no-underline">· off</span>}
                {f.source === "project" ? (
                  <button
                    type="button"
                    onClick={() => p.onToggleProjectFolder(f.path)}
                    aria-label={f.hidden ? `Use ${f.name} in this chat` : `Don't use ${f.name} in this chat`}
                    title={f.hidden ? "Use it in this chat again" : "Don't use it in this chat"}
                    className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                  >
                    {f.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => p.onRemoveFolder(f.path)}
                    aria-label={`Remove ${f.name}`}
                    title="Remove from this chat"
                    className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            {hasFolders && (
              <span className="flex h-8 items-center text-[11.5px] text-faint max-sm:hidden">
                {(() => {
                  const names = active.map((f) => f.name);
                  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
                  return p.mode === "auto"
                    ? `DeepSeek edits ${list} automatically`
                    : p.mode === "edit"
                      ? `DeepSeek can edit ${list}`
                      : `DeepSeek can read ${list}`;
                })()}
              </span>
            )}
          </div>
        )}
        {editing && p.gitChanged > 0 && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {active.length > 1 ? "Your folders have" : "This folder has"} {p.gitChanged} uncommitted change{p.gitChanged === 1 ? "" : "s"}. Consider
              committing first so you can review
              DeepSeek&apos;s edits in Git. (Each reply also has an Undo button.)
            </span>
          </div>
        )}
        {editing && p.clash && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              &ldquo;{p.clash.title}&rdquo; is also changing <span className="font-medium">{p.clash.folder}</span> right now. Edits made at the same
              time can clash; Undo warns you if a file was changed again after DeepSeek edited it.
            </span>
          </div>
        )}
        {p.attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pb-1 pt-3">
            {p.attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                a={a}
                loading={a.status === "loading"}
                error={a.error}
                onRemove={() => p.setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              />
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          rows={1}
          value={p.text}
          placeholder={
            p.placeholder ??
            (hasFolders
              ? editing
                ? p.mode === "auto"
                  ? "Describe the whole change. DeepSeek will do it all…"
                  : "Describe the change you want… (type @ to mention a file)"
                : p.mode === "plan"
                  ? "What should DeepSeek plan? (type @ to mention a file)"
                  : "Ask about your project… (type @ to mention a file)"
              : "Message DeepSeek…")
          }
          onChange={(e) => {
            p.setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (mention && suggestions.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setSelected((s) => (s + 1) % suggestions.length);
              if (e.key === "ArrowUp") return e.preventDefault(), setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pickMention(suggestions[selected]);
              if (e.key === "Escape") return e.preventDefault(), setMention(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) p.onSend();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              p.onAddFiles(files);
              return;
            }
            const text = e.clipboardData.getData("text/plain");
            if (text.length > PASTE_AS_FILE_CHARS) {
              e.preventDefault();
              p.setAttachments((prev) => [
                ...prev,
                { id: nanoid(10), name: "Pasted text", kind: "pasted", size: text.length, content: text, status: "ready" },
              ]);
            }
          }}
          className="block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-faint"
        />

        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <div className="relative">
            <button
              type="button"
              aria-label="Add files or a folder"
              title="Add files or a folder"
              onClick={() => setPlusOpen((o) => !o)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-hover hover:text-fg"
            >
              <Plus size={17} />
            </button>
            <Popover open={plusOpen} onClose={() => setPlusOpen(false)} className="bottom-full left-0 mb-2 w-64">
              <MenuItem
                icon={<Paperclip size={15} />}
                onClick={() => {
                  setPlusOpen(false);
                  fileInput.current?.click();
                }}
              >
                Upload files or images
              </MenuItem>
              <MenuItem
                icon={<FolderOpen size={15} />}
                onClick={() => {
                  setPlusOpen(false);
                  p.onOpenFolder();
                }}
              >
                Add a folder…
              </MenuItem>
            </Popover>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                p.onAddFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>

          <button
            type="button"
            onClick={() => p.onPrefs({ thinking: !p.thinking })}
            title={p.thinking ? "Thinking is on — DeepSeek reasons before answering" : "Thinking is off — faster, cheaper answers"}
            className={clsx(
              "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
              p.thinking ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Brain size={14} /> Think{p.thinking && p.effort === "max" ? " · Max" : ""}
          </button>

          {p.searchEnabled && (
            <button
              type="button"
              onClick={() => p.onPrefs({ webSearch: !p.webSearch })}
              title={p.webSearch ? "Web search is on — DeepSeek can look things up online" : "Web search is off"}
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                p.webSearch ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Globe size={14} /> Search
            </button>
          )}

          {p.githubState !== "hidden" && (
            <button
              type="button"
              onClick={() => (p.githubState === "ready" ? p.onPrefs({ github: !p.github }) : p.onGithubSetup())}
              title={
                p.githubState === "no-repos"
                  ? "No GitHub repos are picked for this project yet. Click to choose them."
                  : p.github
                    ? "GitHub is on: DeepSeek can read your allowed repos (read-only)"
                    : "GitHub is off"
              }
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                p.github ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover hover:text-fg",
                p.githubState === "no-repos" && "opacity-60",
              )}
            >
              <GitBranch size={14} /> GitHub
            </button>
          )}

          <div className="flex-1" />

          <TokenMeter total={total} draft={draftTokens} context={p.contextTokens} chatCost={p.chatCost} nextCost={nextCost} />

          {hasFolders && (
            <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="Folder mode">
              {(Object.keys(MODES) as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={p.mode === m}
                  title={MODES[m].hint}
                  onClick={() => p.onPrefs({ mode: m })}
                  className={clsx(
                    "rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
                    p.mode === m ? clsx("bg-surface shadow-sm", m === "edit" || m === "auto" ? "text-warn" : "text-fg") : "text-muted hover:text-fg",
                  )}
                >
                  {MODES[m].label}
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setModelOpen((o) => !o)}
              className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
            >
              {MODELS[p.model].label}
              <ChevronDown size={14} />
            </button>
            <Popover open={modelOpen} onClose={() => setModelOpen(false)} className="bottom-full right-0 mb-2 w-72 p-1.5">
              {(Object.keys(MODELS) as ModelId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    p.onPrefs({ model: id });
                    setModelOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
                >
                  <div className="flex-1">
                    <div className="text-[13.5px] font-medium">{MODELS[id].label}</div>
                    <div className="text-xs text-muted">{MODELS[id].description}</div>
                  </div>
                  {p.model === id && <Check size={15} className="mt-0.5 text-accent" />}
                </button>
              ))}
              <div className="my-1.5 border-t border-line" />
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <div>
                  <div className="text-[13.5px] font-medium">Thinking</div>
                  <div className="text-xs text-muted">Reason step by step first</div>
                </div>
                <Switch checked={p.thinking} onChange={(v) => p.onPrefs({ thinking: v })} label="Thinking" />
              </div>
              {p.thinking && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <div className="text-[13px] text-muted">Effort</div>
                  <Segmented
                    value={p.effort}
                    onChange={(v) => p.onPrefs({ effort: v })}
                    options={[
                      { value: "high", label: "High" },
                      { value: "max", label: "Max" },
                    ]}
                  />
                </div>
              )}
            </Popover>
          </div>

          {p.streaming && (
            <button
              type="button"
              onClick={p.onStop}
              aria-label="Stop"
              title="Stop (Esc)"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-fg text-app hover:opacity-85"
            >
              <Square size={13} fill="currentColor" />
            </button>
          )}
          {(!p.streaming || canSend) && (
            <button
              type="button"
              onClick={() => p.onSend()}
              disabled={!canSend}
              aria-label="Send"
              title={p.streaming ? "Send now: DeepSeek reads it at its next step (Enter)" : "Send (Enter)"}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:brightness-110 disabled:opacity-30"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TokenMeter({ total, draft, context, chatCost, nextCost }: { total: number; draft: number; context: number; chatCost: number; nextCost: number }) {
  const [open, setOpen] = useState(false);
  const pct = Math.min(total / CONTEXT_LIMIT, 1);
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = pct > 0.95 ? "var(--danger)" : pct > 0.8 ? "var(--warn)" : "var(--accent)";
  if (total === 0 && chatCost === 0) return null;
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <div className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] tabular-nums text-faint">
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.2" />
          <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(pct, 0.02))} strokeLinecap="round" />
        </svg>
        {formatTokens(total)}
      </div>
      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-xl border border-line bg-surface p-3 text-[12.5px] shadow-xl">
          <Row k="Conversation so far" v={`${formatTokens(context)} tokens`} />
          <Row k="This message adds" v={`~${formatTokens(draft)} tokens`} />
          <Row k="Limit" v={`${formatTokens(CONTEXT_LIMIT)} (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% used)`} />
          <div className="my-2 border-t border-line" />
          <Row k="Spent in this chat" v={formatCost(chatCost)} />
          <Row k="Next message input" v={`~${formatCost(nextCost)}`} />
          <div className="mt-2 text-[11.5px] leading-snug text-faint">
            Every message resends the whole chat. Repeated context is cached and costs ~50× less.{" "}
            {isPeak() ? "Peak hours now: prices are doubled." : "Off-peak now: half price."}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
