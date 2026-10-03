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
  ScrollText,
  Square,
  SquareCode,
  SquareTerminal,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { api, estimateAttachmentTokens, type DraftAttachment } from "@/lib/client";
import { EFFORT_SHORT, nearestEffort, PROVIDER_NAME, type ModelInfo, type ProviderLimits } from "@/lib/models";
import { costOf, formatCost, formatTokens, isPeak } from "@/lib/tokens";
import { isEditingMode, MODES, type Effort, type Mode, type ModelId } from "@/lib/types";
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
  info: ModelInfo; // what the chat's model can do
  models: ModelInfo[]; // models you can pick (those whose provider has a key)
  ai: string; // "DeepSeek" or "Claude"
  limits: ProviderLimits; // what this provider may do (Settings)
  onLimitOff: (what: keyof ProviderLimits) => void; // clicked something that's off for this provider
  thinking: boolean;
  effort: Effort;
  code: boolean; // Claude: code execution in Anthropic's sandbox
  onPrefs: (p: Partial<{ model: ModelId; thinking: boolean; effort: Effort; webSearch: boolean; github: boolean; code: boolean; mode: Mode; runWithoutAsking: boolean }>) => void;
  mode: Mode; // Ask / Plan / Edit / Auto for the project folder
  runFreely: { on: boolean; allowed: boolean; sandboxed: boolean } | null; // "Run commands without asking" (null = not offered here)
  gitChanged: number; // uncommitted changes in the project folder (0 if none / not a repo)
  clash?: { title: string; folder: string } | null; // another chat is changing the same folder right now
  webSearch: boolean; // this chat's Search toggle
  github: boolean; // this chat's GitHub toggle
  githubState: "hidden" | "ready" | "no-repos";
  onGithubSetup: () => void;
  searchShown: boolean; // show the Search toggle (Claude chats, or DeepSeek with web search set up in Settings)
  folders: LinkedFolder[]; // project + chat folders (hidden = project folder switched off here)
  onOpenFolder: () => void;
  onRemoveFolder: (path: string) => void; // remove a chat folder
  onToggleProjectFolder: (path: string) => void; // switch a project folder off/on for this chat
  contextTokens: number;
  chatCost: number;
  summarized: boolean; // earlier messages were summarized
  onSummarize?: () => void; // "Summarize now" (when there's something to summarize)
  summarizing?: boolean;
  placeholder?: string;
  focusKey?: string;
}

export function Composer(p: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const claude = p.info.provider === "claude";
  const thinkingOn = p.info.thinking === "always" || (p.info.thinking === "toggle" && p.thinking);
  const effort = nearestEffort(p.effort, p.info.efforts);
  // Effort matters for DeepSeek only while thinking; for Claude it always does.
  const showEffort = !!effort && (claude || thinkingOn);
  const offTitle = (what: string) => `${what} is off for ${p.ai}. Turn it on in Settings → ${p.ai}.`;
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
  // You can send while the AI is replying too: the message waits for its next step.
  const canSend = ready && (p.text.trim().length > 0 || p.attachments.some((a) => a.status === "ready"));

  const draftTokens =
    Math.ceil(p.text.length / 4) + p.attachments.filter((a) => a.status === "ready").reduce((n, a) => n + estimateAttachmentTokens(a), 0);
  const total = p.contextTokens + draftTokens;
  const limit = p.info.context;
  const pct = total / limit;
  const nextCost = costOf(p.model, { cacheHitTokens: p.contextTokens, cacheMissTokens: draftTokens, completionTokens: 0 });

  return (
    <div className="w-full">
      {pct > 0.8 && (
        <div className={clsx("mb-2 rounded-xl px-3.5 py-2 text-[13px]", pct > 0.95 ? "bg-danger-soft text-danger" : "bg-surface-2 text-warn")}>
          {pct > 1
            ? `This message would exceed ${p.info.label}'s ${formatTokens(limit)}-token limit. Remove attachments, summarize the chat, or start a new one.`
            : `This chat is at ${Math.round(pct * 100)}% of ${p.info.label}'s limit. It's summarized automatically past the size set in Settings, or summarize it now from the token meter.`}
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
            {hasFolders && !p.limits.folders && (
              <button type="button" onClick={() => p.onLimitOff("folders")} className="flex h-8 items-center gap-1 text-[11.5px] text-warn">
                <AlertTriangle size={12} /> {p.ai} isn&apos;t allowed to read folders (Settings)
              </button>
            )}
            {hasFolders && p.limits.folders && (
              <span className="flex h-8 items-center text-[11.5px] text-faint max-sm:hidden">
                {(() => {
                  const names = active.map((f) => f.name);
                  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
                  return p.mode === "auto"
                    ? `${p.ai} edits ${list} automatically`
                    : p.mode === "edit"
                      ? `${p.ai} can edit ${list}`
                      : `${p.ai} can read ${list}`;
                })()}
              </span>
            )}
            {p.runFreely && <RunFreelySwitch {...p.runFreely} ai={p.ai} onChange={(v) => p.onPrefs({ runWithoutAsking: v })} onLimitOff={() => p.onLimitOff("auto")} />}
          </div>
        )}
        {editing && p.gitChanged > 0 && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {active.length > 1 ? "Your folders have" : "This folder has"} {p.gitChanged} uncommitted change{p.gitChanged === 1 ? "" : "s"}. Consider
              committing first so you can review
              {p.ai}&apos;s edits in Git. (Each reply also has an Undo button.)
            </span>
          </div>
        )}
        {editing && p.clash && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              &ldquo;{p.clash.title}&rdquo; is also changing <span className="font-medium">{p.clash.folder}</span> right now. Edits made at the same
              time can clash; Undo warns you if a file was changed again after {p.ai} edited it.
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
                  ? `Describe the whole change. ${p.ai} will do it all…`
                  : "Describe the change you want… (type @ to mention a file)"
                : p.mode === "plan"
                  ? `What should ${p.ai} plan? (type @ to mention a file)`
                  : "Ask about your project… (type @ to mention a file)"
              : `Message ${p.ai}…`)
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

          {p.info.thinking !== "none" && (
            <button
              type="button"
              onClick={() => (p.info.thinking === "toggle" ? p.onPrefs({ thinking: !p.thinking }) : setModelOpen(true))}
              title={
                p.info.thinking === "always"
                  ? `${p.info.label} always thinks before answering. Set how hard it works with Effort in the model menu.`
                  : thinkingOn
                    ? `Thinking is on — ${p.ai} reasons before answering`
                    : "Thinking is off — faster, cheaper answers"
              }
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                thinkingOn ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Brain size={14} /> Think
              {showEffort && (claude || effort === "max") ? ` · ${EFFORT_SHORT[effort!]}` : ""}
            </button>
          )}

          {p.searchShown && (
            <button
              type="button"
              onClick={() => (p.limits.search ? p.onPrefs({ webSearch: !p.webSearch }) : p.onLimitOff("search"))}
              title={
                !p.limits.search
                  ? offTitle("Web search")
                  : p.webSearch
                    ? `Web search is on — ${p.ai} can look things up online${claude ? " ($10 per 1,000 searches)" : ""}`
                    : "Web search is off"
              }
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                !p.limits.search
                  ? "border-dashed border-line text-faint"
                  : p.webSearch
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-line text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Globe size={14} /> Search
            </button>
          )}

          {claude && (
            <button
              type="button"
              onClick={() => (p.limits.code ? p.onPrefs({ code: !p.code }) : p.onLimitOff("code"))}
              title={
                !p.limits.code
                  ? offTitle("Code execution")
                  : p.code
                    ? "Code is on — Claude can run Python in Anthropic's sandbox (not on your computer). Spreadsheets you attach go there too."
                    : "Code is off"
              }
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                !p.limits.code
                  ? "border-dashed border-line text-faint"
                  : p.code
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-line text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <SquareCode size={14} /> Code
            </button>
          )}

          {p.githubState !== "hidden" && (
            <button
              type="button"
              onClick={() => (!p.limits.github ? p.onLimitOff("github") : p.githubState === "ready" ? p.onPrefs({ github: !p.github }) : p.onGithubSetup())}
              title={
                !p.limits.github
                  ? offTitle("Reading GitHub")
                  : p.githubState === "no-repos"
                    ? "No GitHub repos are picked for this project yet. Click to choose them."
                    : p.github
                      ? `GitHub is on: ${p.ai} can read your allowed repos (read-only)`
                      : "GitHub is off"
              }
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                !p.limits.github
                  ? "border-dashed border-line text-faint"
                  : p.github
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-line text-muted hover:bg-hover hover:text-fg",
                p.githubState === "no-repos" && "opacity-60",
              )}
            >
              <GitBranch size={14} /> GitHub
            </button>
          )}

          <div className="flex-1" />

          <TokenMeter
            total={total}
            limit={limit}
            draft={draftTokens}
            context={p.contextTokens}
            chatCost={p.chatCost}
            nextCost={nextCost}
            claude={claude}
            summarized={p.summarized}
            onSummarize={p.onSummarize}
            summarizing={!!p.summarizing}
          />

          {hasFolders && (
            <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="Folder mode">
              {(Object.keys(MODES) as Mode[]).map((m) => {
                const blocked = (isEditingMode(m) && !p.limits.edit) || (m === "auto" && !p.limits.auto);
                return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={p.mode === m}
                  aria-disabled={blocked}
                  title={blocked ? offTitle(m === "auto" && p.limits.edit ? "Auto mode" : "Changing files") : MODES[m].hint}
                  onClick={() => (blocked ? p.onLimitOff(m === "auto" && p.limits.edit ? "auto" : "edit") : p.onPrefs({ mode: m }))}
                  className={clsx(
                    "rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
                    blocked
                      ? "text-faint line-through decoration-faint/60"
                      : p.mode === m
                        ? clsx("bg-surface shadow-sm", m === "edit" || m === "auto" ? "text-warn" : "text-fg")
                        : "text-muted hover:text-fg",
                  )}
                >
                  {MODES[m].label}
                </button>
                );
              })}
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setModelOpen((o) => !o)}
              className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
            >
              {claude && <span className="text-faint">Claude</span>}
              {p.info.label}
              <ChevronDown size={14} />
            </button>
            <Popover open={modelOpen} onClose={() => setModelOpen(false)} className="bottom-full right-0 mb-2 w-80 p-1.5">
              <ModelList
                models={p.models}
                current={p.model}
                onPick={(id) => {
                  p.onPrefs({ model: id });
                  setModelOpen(false);
                }}
              />
              <div className="my-1.5 border-t border-line" />
              {p.info.thinking === "toggle" && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <div>
                    <div className="text-[13.5px] font-medium">Thinking</div>
                    <div className="text-xs text-muted">Reason step by step first</div>
                  </div>
                  <Switch checked={p.thinking} onChange={(v) => p.onPrefs({ thinking: v })} label="Thinking" />
                </div>
              )}
              {p.info.thinking === "always" && (
                <div className="px-2.5 py-1.5 text-xs text-muted">{p.info.label} always thinks first. Lower effort for faster, cheaper replies.</div>
              )}
              {showEffort && (
                <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                  <div className="text-[13px] text-muted" title={claude ? "How hard it works: more effort means better answers on hard problems, but slower and more tokens" : undefined}>
                    Effort
                  </div>
                  <Segmented
                    value={effort!}
                    onChange={(v) => p.onPrefs({ effort: v })}
                    options={p.info.efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))}
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
              title={p.streaming ? `Send now: ${p.ai} reads it at its next step (Enter)` : "Send (Enter)"}
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

// The models you can pick, grouped (DeepSeek, then Claude by family, newest first).
export function ModelList({ models, current, onPick }: { models: ModelInfo[]; current: string; onPick: (id: string) => void }) {
  const groups: { name: string; list: ModelInfo[] }[] = [];
  for (const m of models) {
    const name = m.provider === "deepseek" ? PROVIDER_NAME.deepseek : `Claude · ${m.family}`;
    const g = groups.find((x) => x.name === name);
    if (g) g.list.push(m);
    else groups.push({ name, list: [m] });
  }
  const missing = !models.some((m) => m.id === current);
  return (
    <div className="max-h-[min(18rem,30vh)] overflow-y-auto">
      {missing && (
        <div className="mx-1 mb-1 rounded-lg bg-warn/10 px-2.5 py-2 text-xs text-warn">
          This chat&apos;s model isn&apos;t available: its API key isn&apos;t set, or your key can&apos;t use it. Pick another model, or add the key in Settings.
        </div>
      )}
      {groups.map((g) => (
        <div key={g.name}>
          {groups.length > 1 && <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">{g.name}</div>}
          {g.list.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onPick(m.id)}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
              title={m.id}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{m.label}</div>
                {m.description && <div className="truncate text-xs text-muted">{m.description}</div>}
              </div>
              {current === m.id && <Check size={15} className="mt-0.5 shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function TokenMeter(t: {
  total: number;
  limit: number;
  draft: number;
  context: number;
  chatCost: number;
  nextCost: number;
  claude: boolean;
  summarized: boolean;
  onSummarize?: () => void;
  summarizing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pct = Math.min(t.total / t.limit, 1);
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = pct > 0.95 ? "var(--danger)" : pct > 0.8 ? "var(--warn)" : "var(--accent)";
  if (t.total === 0 && t.chatCost === 0) return null;
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] tabular-nums text-faint">
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.2" />
          <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(pct, 0.02))} strokeLinecap="round" />
        </svg>
        {formatTokens(t.total)}
      </button>
      {open && (
        // The padding bridges the gap to the button, so the menu stays open on the way to it.
        <div className="absolute bottom-full right-0 z-40 w-64 pb-2">
          <div className="rounded-xl border border-line bg-surface p-3 text-[12.5px] shadow-xl">
            <Row k="Conversation so far" v={`${formatTokens(t.context)} tokens`} />
            <Row k="This message adds" v={`~${formatTokens(t.draft)} tokens`} />
            <Row k="Limit" v={`${formatTokens(t.limit)} (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% used)`} />
            <div className="my-2 border-t border-line" />
            <Row k="Spent in this chat" v={formatCost(t.chatCost)} />
            <Row k="Next message input" v={`~${formatCost(t.nextCost)}`} />
            <div className="mt-2 text-[11.5px] leading-snug text-faint">
              {t.claude
                ? "Every message resends the whole chat. Repeated context is cached and costs 10–20× less."
                : `Every message resends the whole chat. Repeated context is cached and costs ~50× less. ${isPeak() ? "Peak hours now: prices are doubled." : "Off-peak now: half price."}`}
            </div>
            {t.onSummarize && (
              <button
                type="button"
                onClick={t.onSummarize}
                disabled={t.summarizing}
                className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[12px] text-muted hover:bg-hover hover:text-fg disabled:opacity-60"
                title="The AI writes a summary of the chat so far and continues from it: faster and cheaper from here on. You still see every message."
              >
                <ScrollText size={13} /> {t.summarizing ? "Summarizing…" : t.summarized ? "Summarize again now" : "Summarize the chat so far"}
              </button>
            )}
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

// "Run commands without asking": for a stretch of work where you don't want to click Run on every
// command. Edit and Auto mode only; risky commands still ask, and blocked ones never run.
function RunFreelySwitch({
  on,
  allowed,
  sandboxed,
  ai,
  onChange,
  onLimitOff,
}: {
  on: boolean;
  allowed: boolean;
  sandboxed: boolean;
  ai: string;
  onChange: (v: boolean) => void;
  onLimitOff: () => void;
}) {
  const title = !allowed
    ? `Needs Auto mode allowed for ${ai} in Settings → AI providers.`
    : on
      ? `On: ${ai}'s commands run without asking in this chat. Risky ones (deleting folders, publishing, secret files) still ask; git push and git reset --hard never run. Click to be asked again.`
      : `Off: ${ai}'s commands ask before they run. Click to let them run without asking in this chat.` +
        (sandboxed ? "" : " There's no sandbox on Windows: commands can reach anything your Windows account can.");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Run commands without asking"
      title={title}
      onClick={() => (allowed ? onChange(!on) : onLimitOff())}
      className={clsx(
        "ml-auto flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
        !allowed ? "border-dashed border-line text-faint" : on ? "border-warn/40 bg-warn/15 text-warn" : "border-line text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <SquareTerminal size={14} className="shrink-0" />
      <span className="max-sm:hidden">Run without asking</span>
      <span className={clsx("relative h-3.5 w-6 shrink-0 rounded-full transition-colors", on ? "bg-warn" : "bg-line-strong")}>
        <span className={clsx("absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-all", on ? "left-3" : "left-0.5")} />
      </span>
    </button>
  );
}
